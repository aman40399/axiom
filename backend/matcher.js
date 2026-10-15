const fetch = require('node-fetch');
const { parsePaytmNotification } = require('./parser');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Sends an administrative alert message via Telegram Bot API.
 * Fails silently if Telegram credentials are not configured.
 *
 * @param {string} text - Message text
 */
async function sendTelegramMessage(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !CHAT_ID) {
    console.log('[Telegram] Skipping send (unconfigured):', text);
    return;
  }
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
  } catch (err) {
    console.error('[Telegram] Send failed:', err.message);
  }
}

/**
 * Credits a user's wallet and records an immutable double-entry ledger record
 * inside an atomic SQLite transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userName - Payer identity
 * @param {number} amount - Amount to credit (original requestedINR, not jittered)
 * @param {string|null} orderId - Associated order UUID
 * @param {string} [type='TOPUP'] - Ledger entry classification
 * @returns {number} New balance after crediting
 */
function creditWallet(db, userName, amount, orderId, type = 'TOPUP') {
  const txn = db.transaction(() => {
    const existing = db.prepare('SELECT balanceCredits FROM wallets WHERE userName = ?').get(userName);
    let newBalance;

    if (existing) {
      newBalance = Math.round((existing.balanceCredits + amount) * 100) / 100;
      db.prepare(
        'UPDATE wallets SET balanceCredits = ?, lifetimeTopup = lifetimeTopup + ?, lastUpdated = ? WHERE userName = ?'
      ).run(newBalance, amount, Date.now(), userName);
    } else {
      newBalance = Math.round(amount * 100) / 100;
      db.prepare(
        'INSERT INTO wallets (userName, balanceCredits, lifetimeTopup, lastUpdated) VALUES (?, ?, ?, ?)'
      ).run(userName, newBalance, newBalance, Date.now());
    }

    // Insert immutable ledger log
    db.prepare(
      'INSERT INTO ledger (userName, timestamp, delta, balanceAfter, orderId, type) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userName, Date.now(), amount, newBalance, orderId, type);

    return newBalance;
  });

  return txn();
}

/**
 * Finalizes an order match, credits the wallet, updates order status,
 * and notifies Telegram admin.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} order - Matched order record
 * @param {Object} parsed - Parsed notification payload
 * @param {'PAID'|'LATE_PAID'} newStatus - Target status
 * @returns {Promise<{ action: string, orderId: string, newBalance?: number, error?: string }>}
 */
async function finalizeMatch(db, order, parsed, newStatus) {
  const { parsedUTR } = parsed;

  try {
    // Invariant: Always credit requestedINR, preserving customer pricing integrity
    const newBalance = creditWallet(db, order.userName, order.requestedINR, order.orderId);

    // Update order status
    db.prepare(
      'UPDATE orders SET status = ?, paidAt = ?, utrRef = ?, notifRaw = ? WHERE orderId = ?'
    ).run(newStatus, Date.now(), parsedUTR, parsed.raw, order.orderId);

    const statusLabel = newStatus === 'LATE_PAID' ? '(late grace payment)' : '';
    const msg = `[INFO] Payment received ${statusLabel} | Order: ${order.shortId} | User: ${order.userName} | Amount: INR ${order.requestedINR} | Balance: INR ${newBalance}`;
    console.log('[Matcher]', msg);
    await sendTelegramMessage(msg);

    return { action: 'MATCHED', orderId: order.orderId, newBalance };
  } catch (err) {
    const msg = `[ERROR] Credit failed for order ${order.orderId}: ${err.message}`;
    console.error('[Matcher]', msg);
    await sendTelegramMessage(msg);
    return { action: 'CREDIT_FAILED', error: err.message };
  }
}

/**
 * Matches a parsed notification against active or grace-period orders using
 * the jittered amount as a primary fingerprint.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} parsed - Extracted payment payload
 * @returns {Promise<{ action: string, orderId?: string, newBalance?: number, error?: string }>}
 */
async function matchNotification(db, parsed) {
  const { parsedAmount, parsedUTR } = parsed;
  const now = Date.now();

  // Primary match: Active pending orders with this jittered amount
  const pendingMatches = db
    .prepare("SELECT * FROM orders WHERE amountINR = ? AND status = 'PENDING' AND expiresAt > ?")
    .all(parsedAmount, now);

  if (pendingMatches.length === 1) {
    return await finalizeMatch(db, pendingMatches[0], parsed, 'PAID');
  }

  if (pendingMatches.length > 1) {
    const msg = `[WARN] Ambiguous match: INR ${parsedAmount} corresponds to ${pendingMatches.length} pending orders. Manual review required.`;
    console.warn('[Matcher]', msg);
    await sendTelegramMessage(msg);
    return { action: 'AMBIGUOUS' };
  }

  // Fallback: Check expired orders within 30-minute grace window
  const graceWindow = now - 30 * 60 * 1000;
  const expiredMatches = db
    .prepare("SELECT * FROM orders WHERE amountINR = ? AND status = 'EXPIRED' AND expiresAt > ?")
    .all(parsedAmount, graceWindow);

  if (expiredMatches.length === 1) {
    return await finalizeMatch(db, expiredMatches[0], parsed, 'LATE_PAID');
  }

  // Unmatched notification
  const msg = `[WARN] Unmatched payment: INR ${parsedAmount}, UTR: ${parsedUTR || 'N/A'}`;
  console.warn('[Matcher]', msg);
  await sendTelegramMessage(msg);
  return { action: 'UNMATCHED' };
}

/**
 * Unified notification ingestion pipeline: Handles incoming notifications
 * from Android apps, Telegram webhooks, or test harness.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} payload
 * @param {string} payload.text - Notification body
 * @param {string} [payload.source='unknown'] - Origin (e.g. 'Telegram', 'AndroidApp')
 * @param {boolean} [payload.isTest=false] - Heartbeat test ping flag
 * @returns {Promise<{ ok: boolean, action: string, notifId?: number, [key: string]: any }>}
 */
async function handleIncomingNotification(db, { text, source = 'unknown', isTest = false }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { ok: true, action: 'IGNORED', reason: 'empty_text' };
  }

  const rawText = text.trim();
  console.log(`[Notification] Source: ${source} | Text: "${rawText}"`);

  if (isTest) {
    console.log('[Notification] Test ping received: connection verified.');
    return { ok: true, action: 'TEST_PING' };
  }

  const parsed = parsePaytmNotification(rawText);

  const logStmt = db.prepare(`
    INSERT INTO notifications_log (receivedAt, rawText, parsedAmount, parsedUTR, parsedNote, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  if (!parsed.success) {
    logStmt.run(Date.now(), rawText, parsed.parsedAmount, parsed.parsedUTR, parsed.parsedNote, 'PARSE_FAIL');
    const alertMsg = `[WARN] PARSE_FAIL from ${source} | Text: ${rawText}`;
    console.warn('[Notification]', alertMsg);
    await sendTelegramMessage(alertMsg);
    return { ok: true, action: 'PARSE_FAIL' };
  }

  // Check duplicate UTR before processing (idempotency check)
  if (parsed.parsedUTR) {
    const existing = db
      .prepare("SELECT id FROM notifications_log WHERE parsedUTR = ? AND status = 'MATCHED'")
      .get(parsed.parsedUTR);

    if (existing) {
      logStmt.run(Date.now(), rawText, parsed.parsedAmount, parsed.parsedUTR, parsed.parsedNote, 'DUPLICATE');
      console.log(`[Notification] Duplicate UTR ${parsed.parsedUTR} detected, skipping`);
      return { ok: true, action: 'DUPLICATE' };
    }
  }

  // Insert notification log
  const logResult = logStmt.run(
    Date.now(),
    rawText,
    parsed.parsedAmount,
    parsed.parsedUTR,
    parsed.parsedNote,
    'RECEIVED'
  );
  const notifId = Number(logResult.lastInsertRowid);

  // Expire stale orders before matching
  const now = Date.now();
  db.prepare("UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND expiresAt <= ?").run(now);

  // Attempt matching
  const matchResult = await matchNotification(db, parsed);

  // Update notification status based on match outcome
  if (matchResult.action === 'UNMATCHED') {
    db.prepare("UPDATE notifications_log SET status = 'UNMATCHED' WHERE id = ?").run(notifId);
  } else if (matchResult.action === 'MATCHED') {
    db.prepare("UPDATE notifications_log SET status = 'MATCHED', matchedOrder = ? WHERE id = ?")
      .run(matchResult.orderId, notifId);
  }

  return { ok: true, notifId, ...matchResult };
}

module.exports = {
  handleIncomingNotification,
  matchNotification,
  finalizeMatch,
  creditWallet,
  sendTelegramMessage,
};
