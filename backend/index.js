require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { getJitteredAmount } = require('./jitter');
const { handleIncomingNotification, creditWallet } = require('./matcher');
const { generateQR, generateShortId } = require('./qr');
const { getExchangeRate } = require('./rate');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3000;
const VPA = process.env.PAYTM_VPA || 'merchant@upi';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Axiom Settlement Node';
const MIN_AMOUNT = parseFloat(process.env.MIN_AMOUNT_INR) || 1;
const MAX_AMOUNT = parseFloat(process.env.MAX_AMOUNT_INR) || 10000;
const EXPIRY_MIN = parseInt(process.env.ORDER_EXPIRY_MINUTES) || 10;

/**
 * Periodically transitions past-due pending orders to EXPIRED.
 */
function expireStaleOrders() {
  const now = Date.now();
  db.prepare("UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND expiresAt <= ?").run(now);
}

// ── Public Settlement APIs ──

/**
 * POST /api/order
 * Creates a new settlement intent and executes the ε-jitter allocation protocol.
 */
app.post('/api/order', async (req, res, next) => {
  try {
    const { amountINR, userName } = req.body || {};

    if (!userName || typeof userName !== 'string' || !userName.trim()) {
      return res.status(400).json({ error: 'userName is required' });
    }

    const amt = parseFloat(amountINR);
    if (isNaN(amt) || amt < MIN_AMOUNT || amt > MAX_AMOUNT) {
      return res.status(400).json({ error: `Amount must be between INR ${MIN_AMOUNT} and INR ${MAX_AMOUNT}` });
    }

    expireStaleOrders();

    // Allocate epsilon-jittered amount using ADJA
    let jittered;
    try {
      jittered = getJitteredAmount(amt, db);
    } catch (err) {
      if (err.code === 'JITTER_EXHAUSTED' || err.message === 'JITTER_EXHAUSTED') {
        return res.status(409).json({
          error: 'BUSY',
          message: 'All temporal fingerprint slots for this amount are currently occupied. Please retry in 30 seconds.',
        });
      }
      throw err;
    }

    // Currency conversion & unique order identifiers
    const rate = await getExchangeRate();
    const amountUSD = parseFloat((amt * rate).toFixed(2));
    const orderId = crypto.randomUUID();
    const shortId = generateShortId();
    const now = Date.now();
    const expiresAt = now + EXPIRY_MIN * 60 * 1000;

    // Build UPI deep link and QR code data URL
    const { qrDataUrl, upiLink } = await generateQR({
      vpa: VPA,
      name: MERCHANT_NAME,
      amount: jittered.jitteredAmount,
      shortId,
    });

    db.prepare(`
      INSERT INTO orders (
        orderId, shortId, userName, requestedINR, amountINR, jitterDelta,
        amountUSD, exchangeRate, status, createdAt, expiresAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(
      orderId,
      shortId,
      userName.trim(),
      amt,
      jittered.jitteredAmount,
      jittered.delta,
      amountUSD,
      rate,
      now,
      expiresAt
    );

    res.json({
      orderId,
      shortId,
      qrDataUrl,
      upiLink,
      jitteredAmount: jittered.jitteredAmount,
      originalAmount: amt,
      jitterDelta: jittered.delta,
      amountUSD,
      exchangeRate: rate,
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/order/:id/status
 * Polled by client to query settlement status.
 */
app.get('/api/order/:id/status', (req, res, next) => {
  try {
    expireStaleOrders();

    const order = db.prepare('SELECT * FROM orders WHERE orderId = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = {
      orderId: order.orderId,
      status: order.status,
      paidAt: order.paidAt,
      amountINR: order.amountINR,
      requestedINR: order.requestedINR,
    };

    if (order.status === 'PAID' || order.status === 'LATE_PAID') {
      const wallet = db.prepare('SELECT balanceCredits FROM wallets WHERE userName = ?').get(order.userName);
      result.balanceCredits = wallet ? wallet.balanceCredits : 0;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/wallet/:userName
 * Retrieves ledger state and balance credits.
 */
app.get('/api/wallet/:userName', (req, res, next) => {
  try {
    const userName = req.params.userName.trim();
    const wallet = db.prepare('SELECT * FROM wallets WHERE userName = ?').get(userName);
    const ledger = db
      .prepare('SELECT * FROM ledger WHERE userName = ? ORDER BY timestamp DESC LIMIT 20')
      .all(userName);

    res.json({
      userName,
      balanceCredits: wallet ? wallet.balanceCredits : 0,
      lifetimeTopup: wallet ? wallet.lifetimeTopup : 0,
      ledger,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/exchange-rate
 * Live or cached INR/USD exchange rate.
 */
app.get('/api/exchange-rate', async (_req, res, next) => {
  try {
    const rate = await getExchangeRate();
    res.json({ rate });
  } catch (err) {
    next(err);
  }
});

// ── Ingestion Endpoints ──

/**
 * POST /webhook/telegram
 * Ingests notifications forwarded via Telegram Bot API.
 */
app.post('/webhook/telegram', async (req, res) => {
  try {
    const message = req.body?.message;
    const text = message?.text || message?.caption || '';
    await handleIncomingNotification(db, { text, source: 'TelegramRelay' });
  } catch (err) {
    console.error('[Webhook/Telegram] Ingestion error:', err);
  }
  res.sendStatus(200);
});

/**
 * POST /webhook/notification
 * Ingests notification stream from mobile forwarder daemon.
 */
app.post('/webhook/notification', async (req, res) => {
  try {
    const { text, isTest } = req.body || {};
    const source = req.headers['x-axiom-source'] || req.headers['x-payzap-source'] || 'IngestionRelay';
    await handleIncomingNotification(db, { text, source, isTest });
  } catch (err) {
    console.error('[Webhook/Notification] Ingestion error:', err);
  }
  res.sendStatus(200);
});

// ── Node Administration APIs ──

app.get('/api/admin/orders', (_req, res, next) => {
  try {
    expireStaleOrders();
    const orders = db.prepare('SELECT * FROM orders ORDER BY createdAt DESC').all();
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/notifications', (_req, res, next) => {
  try {
    const notifs = db.prepare('SELECT * FROM notifications_log ORDER BY receivedAt DESC LIMIT 50').all();
    res.json(notifs);
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/wallets', (_req, res, next) => {
  try {
    const wallets = db.prepare('SELECT * FROM wallets ORDER BY lastUpdated DESC').all();
    res.json(wallets);
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/manual-credit', (req, res, next) => {
  try {
    const { notifId, userName } = req.body || {};
    if (!notifId || !userName) {
      return res.status(400).json({ error: 'notifId and userName are required' });
    }

    const notif = db.prepare('SELECT * FROM notifications_log WHERE id = ?').get(notifId);
    if (!notif) return res.status(404).json({ error: 'Notification not found' });
    if (notif.status === 'MATCHED') return res.status(409).json({ error: 'Notification already matched' });

    const amount = notif.parsedAmount;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Notification has no valid parsed amount' });
    }

    const newBalance = creditWallet(db, userName.trim(), amount, null, 'MANUAL_CREDIT');
    db.prepare("UPDATE notifications_log SET status = 'MATCHED', matchedOrder = 'MANUAL' WHERE id = ?").run(notifId);

    res.json({ success: true, credited: amount, newBalance });
  } catch (err) {
    next(err);
  }
});

// ── Interface Routing ──

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'admin.html'));
});

// ── Centralized Error Handler ──

app.use((err, _req, res, _next) => {
  console.error('[Axiom Error]', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? undefined : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Axiom node listening on http://localhost:${PORT}`);
  console.log(`  Admin Dashboard:   http://localhost:${PORT}/admin`);
  console.log(`  Telegram Webhook:  POST http://localhost:${PORT}/webhook/telegram`);
  console.log(`  Direct Webhook:    POST http://localhost:${PORT}/webhook/notification`);
});
