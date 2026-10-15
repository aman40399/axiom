import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand,
  QueryCommand, ScanCommand
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const client = new DynamoDBClient({ region: 'ap-south-1' });
const ddb = DynamoDBDocumentClient.from(client);

// Config from env
const VPA = process.env.PAYTM_VPA || 'merchant@upi';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Axiom Node';
const MIN_AMOUNT = parseFloat(process.env.MIN_AMOUNT_INR || '1');
const MAX_AMOUNT = parseFloat(process.env.MAX_AMOUNT_INR || '10000');
const EXPIRY_MIN = parseInt(process.env.ORDER_EXPIRY_MINUTES || '10');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// Table names
const T_ORDERS = 'axiom-orders';
const T_WALLETS = 'axiom-wallets';
const T_LEDGER = 'axiom-ledger';
const T_NOTIFS = 'axiom-notifications';

// ── CORS headers ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Axiom-Source,ngrok-skip-browser-warning',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

// ── Telegram ──
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram send failed:', e.message); }
}

// ── Parser (no UTR) ──
function parseNotification(text) {
  const amountMatch = text.match(/(?:Rs\.?\s*|₹\s*)([\d,]+(?:\.\d{1,2})?)/i);
  const parsedAmount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;
  const noteMatch = text.match(/(?:Note|Remarks?|Tn)[:\s]+([A-Z0-9]{8,12})/i);
  const parsedNote = noteMatch ? noteMatch[1] : null;
  return { parsedAmount, parsedNote, success: parsedAmount !== null, raw: text };
}

// ── Exchange rate (cached in memory across warm invocations) ──
let cachedRate = null;
let cachedAt = 0;
async function getExchangeRate() {
  if (cachedRate && Date.now() - cachedAt < 5 * 60 * 1000) return cachedRate;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=INR&to=USD');
    const data = await res.json();
    cachedRate = data.rates.USD;
    cachedAt = Date.now();
    return cachedRate;
  } catch { return cachedRate || 0.012; }
}

// ── QR generation (UPI link — no image, frontend renders) ──
function buildUPILink(vpa, name, amount, shortId) {
  const params = new URLSearchParams({ pa: vpa, pn: name, am: amount.toFixed(2), cu: 'INR', tn: shortId });
  return `upi://pay?${params.toString()}`;
}
function generateShortId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// ── Expire stale orders ──
async function expireStaleOrders() {
  const now = Date.now();
  const result = await ddb.send(new QueryCommand({
    TableName: T_ORDERS,
    IndexName: 'status-amount-index',
    KeyConditionExpression: '#s = :pending',
    FilterExpression: 'expiresAt <= :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':now': now },
  }));
  for (const order of (result.Items || [])) {
    await ddb.send(new UpdateCommand({
      TableName: T_ORDERS,
      Key: { orderId: order.orderId },
      UpdateExpression: 'SET #s = :expired',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED' },
    }));
  }
}

// ── Jitter ──
async function getJitteredAmount(requestedINR) {
  const now = Date.now();
  const result = await ddb.send(new QueryCommand({
    TableName: T_ORDERS,
    IndexName: 'status-amount-index',
    KeyConditionExpression: '#s = :pending',
    FilterExpression: 'expiresAt > :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':now': now },
  }));
  const taken = new Set((result.Items || []).map(o => o.amountINR));
  const deltas = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];
  for (const delta of deltas) {
    const candidate = requestedINR + delta;
    if (candidate >= 1 && !taken.has(candidate)) {
      return { jitteredAmount: candidate, delta };
    }
  }
  throw new Error('JITTER_EXHAUSTED');
}

// ── Credit wallet ──
async function creditWallet(userName, amount, orderId, type = 'TOPUP') {
  const walletRes = await ddb.send(new GetCommand({ TableName: T_WALLETS, Key: { userName } }));
  const existing = walletRes.Item;
  let newBalance;

  if (existing) {
    newBalance = existing.balanceCredits + amount;
    await ddb.send(new UpdateCommand({
      TableName: T_WALLETS, Key: { userName },
      UpdateExpression: 'SET balanceCredits = :b, lifetimeTopup = lifetimeTopup + :a, lastUpdated = :t',
      ExpressionAttributeValues: { ':b': newBalance, ':a': amount, ':t': Date.now() },
    }));
  } else {
    newBalance = amount;
    await ddb.send(new PutCommand({
      TableName: T_WALLETS,
      Item: { userName, balanceCredits: amount, lifetimeTopup: amount, lastUpdated: Date.now() },
    }));
  }

  await ddb.send(new PutCommand({
    TableName: T_LEDGER,
    Item: { userName, timestamp: Date.now(), delta: amount, balanceAfter: newBalance, orderId, type },
  }));

  return newBalance;
}

// ── Match notification ──
async function matchNotification(parsed) {
  const { parsedAmount } = parsed;
  const now = Date.now();

  // Primary match — pending orders with this jittered amount
  const pendingRes = await ddb.send(new QueryCommand({
    TableName: T_ORDERS,
    IndexName: 'status-amount-index',
    KeyConditionExpression: '#s = :pending AND amountINR = :amt',
    FilterExpression: 'expiresAt > :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':amt': parsedAmount, ':now': now },
  }));
  const pendingMatches = pendingRes.Items || [];

  if (pendingMatches.length === 1) {
    return await finalizeMatch(pendingMatches[0], parsed, 'PAID');
  }
  if (pendingMatches.length > 1) {
    const msg = `🚨 AMBIGUOUS — ₹${parsedAmount} has ${pendingMatches.length} pending orders`;
    await sendTelegram(msg);
    return { action: 'AMBIGUOUS' };
  }

  // Fallback — expired within 30-min grace
  const graceWindow = now - 30 * 60 * 1000;
  const expiredRes = await ddb.send(new QueryCommand({
    TableName: T_ORDERS,
    IndexName: 'status-amount-index',
    KeyConditionExpression: '#s = :expired AND amountINR = :amt',
    FilterExpression: 'expiresAt > :grace',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':expired': 'EXPIRED', ':amt': parsedAmount, ':grace': graceWindow },
  }));
  const expiredMatches = expiredRes.Items || [];
  if (expiredMatches.length === 1) {
    return await finalizeMatch(expiredMatches[0], parsed, 'LATE_PAID');
  }

  const msg = `⚠️ UNMATCHED — ₹${parsedAmount}\nRaw: ${parsed.raw}`;
  await sendTelegram(msg);
  return { action: 'UNMATCHED' };
}

async function finalizeMatch(order, parsed, newStatus) {
  try {
    const newBalance = await creditWallet(order.userName, order.requestedINR, order.orderId);
    await ddb.send(new UpdateCommand({
      TableName: T_ORDERS, Key: { orderId: order.orderId },
      UpdateExpression: 'SET #s = :st, paidAt = :pa, notifRaw = :nr',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':st': newStatus, ':pa': Date.now(), ':nr': parsed.raw },
    }));

    const statusLabel = newStatus === 'LATE_PAID' ? '(late)' : '';
    const msg = `✅ ₹${order.requestedINR} received ${statusLabel} · Order ${order.shortId} · ${order.userName} · Balance: ₹${newBalance}`;
    await sendTelegram(msg);
    return { action: 'MATCHED', orderId: order.orderId, newBalance };
  } catch (err) {
    const msg = `🚨 CREDIT FAILED for ${order.orderId} — ${err.message}`;
    await sendTelegram(msg);
    return { action: 'CREDIT_FAILED', error: err.message };
  }
}

// ── Route handler ──
export const handler = async (event) => {
  // Handle OPTIONS (CORS preflight)
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return respond(200, {});
  }

  const method = event.requestContext?.http?.method || 'GET';
  const path = event.requestContext?.http?.path || event.rawPath || '/';
  const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};

  try {
    // ── POST /api/order ──
    if (method === 'POST' && path === '/api/order') {
      const { amountINR, userName } = body;
      if (!userName || typeof userName !== 'string' || !userName.trim()) {
        return respond(400, { error: 'userName is required' });
      }
      const amt = parseFloat(amountINR);
      if (isNaN(amt) || amt < MIN_AMOUNT || amt > MAX_AMOUNT) {
        return respond(400, { error: `Amount must be between ₹${MIN_AMOUNT} and ₹${MAX_AMOUNT}` });
      }

      await expireStaleOrders();

      let jittered;
      try { jittered = await getJitteredAmount(amt); }
      catch (err) {
        if (err.message === 'JITTER_EXHAUSTED') {
          return respond(409, { error: 'BUSY', message: 'Too many payments in progress. Try again in 30s.' });
        }
        throw err;
      }

      const rate = await getExchangeRate();
      const amountUSD = parseFloat((amt * rate).toFixed(2));
      const orderId = crypto.randomUUID();
      const shortId = generateShortId();
      const now = Date.now();
      const expiresAt = now + EXPIRY_MIN * 60 * 1000;
      const upiLink = buildUPILink(VPA, MERCHANT_NAME, jittered.jitteredAmount, shortId);

      await ddb.send(new PutCommand({
        TableName: T_ORDERS,
        Item: {
          orderId, shortId, userName: userName.trim(),
          requestedINR: amt, amountINR: jittered.jitteredAmount, jitterDelta: jittered.delta,
          amountUSD, exchangeRate: rate, status: 'PENDING',
          createdAt: now, expiresAt,
        },
      }));

      return respond(200, {
        orderId, shortId, upiLink,
        jitteredAmount: jittered.jitteredAmount, originalAmount: amt,
        jitterDelta: jittered.delta, amountUSD, exchangeRate: rate, expiresAt,
      });
    }

    // ── GET /api/order/:id/status ──
    if (method === 'GET' && path.startsWith('/api/order/') && path.endsWith('/status')) {
      const orderId = path.split('/')[3];
      await expireStaleOrders();
      const res = await ddb.send(new GetCommand({ TableName: T_ORDERS, Key: { orderId } }));
      if (!res.Item) return respond(404, { error: 'Order not found' });
      const order = res.Item;
      const result = { status: order.status, paidAt: order.paidAt };
      if (order.status === 'PAID' || order.status === 'LATE_PAID') {
        const w = await ddb.send(new GetCommand({ TableName: T_WALLETS, Key: { userName: order.userName } }));
        result.balanceCredits = w.Item ? w.Item.balanceCredits : 0;
      }
      return respond(200, result);
    }

    // ── GET /api/wallet/:userName ──
    if (method === 'GET' && path.startsWith('/api/wallet/')) {
      const userName = decodeURIComponent(path.split('/')[3]);
      const w = await ddb.send(new GetCommand({ TableName: T_WALLETS, Key: { userName } }));
      const ledgerRes = await ddb.send(new QueryCommand({
        TableName: T_LEDGER, KeyConditionExpression: 'userName = :u',
        ExpressionAttributeValues: { ':u': userName },
        ScanIndexForward: false, Limit: 20,
      }));
      return respond(200, { balanceCredits: w.Item ? w.Item.balanceCredits : 0, ledger: ledgerRes.Items || [] });
    }

    // ── GET /api/admin/orders ──
    if (method === 'GET' && path === '/api/admin/orders') {
      await expireStaleOrders();
      const res = await ddb.send(new ScanCommand({ TableName: T_ORDERS }));
      const items = (res.Items || []).sort((a, b) => b.createdAt - a.createdAt);
      return respond(200, items);
    }

    // ── GET /api/admin/notifications ──
    if (method === 'GET' && path === '/api/admin/notifications') {
      const res = await ddb.send(new ScanCommand({ TableName: T_NOTIFS }));
      const items = (res.Items || []).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 50);
      return respond(200, items);
    }

    // ── GET /api/admin/wallets ──
    if (method === 'GET' && path === '/api/admin/wallets') {
      const res = await ddb.send(new ScanCommand({ TableName: T_WALLETS }));
      const items = (res.Items || []).sort((a, b) => b.lastUpdated - a.lastUpdated);
      return respond(200, items);
    }

    // ── POST /api/admin/manual-credit ──
    if (method === 'POST' && path === '/api/admin/manual-credit') {
      const { notifId, userName } = body;
      if (!notifId || !userName) return respond(400, { error: 'notifId and userName required' });
      const nRes = await ddb.send(new GetCommand({ TableName: T_NOTIFS, Key: { id: notifId } }));
      if (!nRes.Item) return respond(404, { error: 'Notification not found' });
      if (nRes.Item.status === 'MATCHED') return respond(409, { error: 'Already matched' });
      const amount = nRes.Item.parsedAmount;
      if (!amount || amount <= 0) return respond(400, { error: 'No valid amount' });
      const newBalance = await creditWallet(userName.trim(), amount, null, 'MANUAL_CREDIT');
      await ddb.send(new UpdateCommand({
        TableName: T_NOTIFS, Key: { id: notifId },
        UpdateExpression: 'SET #s = :matched, matchedOrder = :mo',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':matched': 'MATCHED', ':mo': 'MANUAL' },
      }));
      return respond(200, { success: true, credited: amount, newBalance });
    }

    // ── POST /webhook/notification (Android app) ──
    if (method === 'POST' && path === '/webhook/notification') {
      const { text, isTest } = body;
      if (!text) return respond(200, { ok: true });
      if (isTest) return respond(200, { ok: true, message: 'Connection OK' });

      const parsed = parseNotification(text);
      const notifId = crypto.randomUUID();

      if (!parsed.success) {
        await ddb.send(new PutCommand({
          TableName: T_NOTIFS,
          Item: { id: notifId, receivedAt: Date.now(), rawText: text, parsedAmount: null, status: 'PARSE_FAIL' },
        }));
        await sendTelegram(`⚠️ PARSE_FAIL:\n${text}`);
        return respond(200, { ok: true });
      }

      await ddb.send(new PutCommand({
        TableName: T_NOTIFS,
        Item: {
          id: notifId, receivedAt: Date.now(), rawText: text,
          parsedAmount: parsed.parsedAmount, parsedNote: parsed.parsedNote, status: 'RECEIVED',
        },
      }));

      await expireStaleOrders();
      const result = await matchNotification(parsed);

      if (result.action === 'MATCHED') {
        await ddb.send(new UpdateCommand({
          TableName: T_NOTIFS, Key: { id: notifId },
          UpdateExpression: 'SET #s = :matched, matchedOrder = :oid',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':matched': 'MATCHED', ':oid': result.orderId },
        }));
      } else if (result.action === 'UNMATCHED') {
        await ddb.send(new UpdateCommand({
          TableName: T_NOTIFS, Key: { id: notifId },
          UpdateExpression: 'SET #s = :unmatched',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':unmatched': 'UNMATCHED' },
        }));
      }

      return respond(200, { ok: true });
    }

    // ── POST /webhook/telegram ──
    if (method === 'POST' && path === '/webhook/telegram') {
      const message = body.message;
      if (!message) return respond(200, { ok: true });
      const text = message.text || message.caption || '';
      if (!text) return respond(200, { ok: true });

      const parsed = parseNotification(text);
      const notifId = crypto.randomUUID();

      if (!parsed.success) {
        await ddb.send(new PutCommand({
          TableName: T_NOTIFS,
          Item: { id: notifId, receivedAt: Date.now(), rawText: text, parsedAmount: null, status: 'PARSE_FAIL' },
        }));
        await sendTelegram(`⚠️ PARSE_FAIL:\n${text}`);
        return respond(200, { ok: true });
      }

      await ddb.send(new PutCommand({
        TableName: T_NOTIFS,
        Item: {
          id: notifId, receivedAt: Date.now(), rawText: text,
          parsedAmount: parsed.parsedAmount, parsedNote: parsed.parsedNote, status: 'RECEIVED',
        },
      }));

      await expireStaleOrders();
      const result = await matchNotification(parsed);

      if (result.action === 'MATCHED') {
        await ddb.send(new UpdateCommand({
          TableName: T_NOTIFS, Key: { id: notifId },
          UpdateExpression: 'SET #s = :matched, matchedOrder = :oid',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':matched': 'MATCHED', ':oid': result.orderId },
        }));
      } else if (result.action === 'UNMATCHED') {
        await ddb.send(new UpdateCommand({
          TableName: T_NOTIFS, Key: { id: notifId },
          UpdateExpression: 'SET #s = :unmatched',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':unmatched': 'UNMATCHED' },
        }));
      }

      return respond(200, { ok: true });
    }

    // ── GET /api/exchange-rate ──
    if (method === 'GET' && path === '/api/exchange-rate') {
      const rate = await getExchangeRate();
      return respond(200, { rate });
    }

    return respond(404, { error: 'Not found' });

  } catch (err) {
    console.error('Lambda error:', err);
    return respond(500, { error: 'Internal server error' });
  }
};
