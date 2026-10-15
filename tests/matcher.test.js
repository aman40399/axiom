const Database = require('better-sqlite3');
const { handleIncomingNotification, creditWallet } = require('../backend/matcher');

let passed = 0;
let failed = 0;

function assert(condition, testName, details) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${testName}`);
    if (details) console.log(`         ${details}`);
    failed++;
  }
}

console.log('\n[TEST] Axiom Matcher & Reconciliation Tests\n');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orders (
      orderId       TEXT PRIMARY KEY,
      shortId       TEXT NOT NULL,
      userName      TEXT NOT NULL,
      requestedINR  REAL NOT NULL,
      amountINR     REAL NOT NULL,
      jitterDelta   INTEGER NOT NULL DEFAULT 0,
      amountUSD     REAL,
      exchangeRate  REAL,
      status        TEXT NOT NULL DEFAULT 'PENDING',
      createdAt     INTEGER NOT NULL,
      expiresAt     INTEGER NOT NULL,
      paidAt        INTEGER,
      utrRef        TEXT,
      notifRaw      TEXT
    );

    CREATE TABLE wallets (
      userName       TEXT PRIMARY KEY,
      balanceCredits REAL NOT NULL DEFAULT 0,
      lifetimeTopup  REAL NOT NULL DEFAULT 0,
      lastUpdated    INTEGER NOT NULL
    );

    CREATE TABLE ledger (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      userName     TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      delta        REAL NOT NULL,
      balanceAfter REAL NOT NULL,
      orderId      TEXT,
      type         TEXT NOT NULL
    );

    CREATE TABLE notifications_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      receivedAt   INTEGER NOT NULL,
      rawText      TEXT NOT NULL,
      parsedAmount REAL,
      parsedUTR    TEXT,
      parsedNote   TEXT,
      matchedOrder TEXT,
      status       TEXT NOT NULL
    );
  `);
  return db;
}

// 1. Double-entry Wallet Crediting
console.log('Test Suite 1: Wallet Transaction & Ledger Integrity');
{
  const db = createTestDb();
  const b1 = creditWallet(db, 'Alice', 100, 'ord-1');
  assert(b1 === 100, `Initial credit sets balance to 100 (got ${b1})`);

  const b2 = creditWallet(db, 'Alice', 50, 'ord-2');
  assert(b2 === 150, `Subsequent credit increases balance to 150 (got ${b2})`);

  const wallet = db.prepare('SELECT * FROM wallets WHERE userName = ?').get('Alice');
  assert(wallet.balanceCredits === 150, 'Wallet balance matches in table');
  assert(wallet.lifetimeTopup === 150, 'Lifetime topup is tracked');

  const ledgerEntries = db.prepare('SELECT * FROM ledger WHERE userName = ?').all('Alice');
  assert(ledgerEntries.length === 2, 'Two immutable ledger rows created');
}

// 2. Exact Order Matching via Webhook
console.log('\nTest Suite 2: Notification Matching Pipeline');
(async () => {
  const db = createTestDb();
  const now = Date.now();

  // Insert a pending order with jittered amount 99.00 (requested 100.00)
  db.prepare(`
    INSERT INTO orders (orderId, shortId, userName, requestedINR, amountINR, jitterDelta, status, createdAt, expiresAt)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
  `).run('test-order-123', 'A1B2C3D4', 'Bob', 100, 99, -1, now, now + 600000);

  // Send notification for 99.00
  const notifText = 'Rs. 99.00 received from 9876543210. UPI Ref No. 402312345678.';
  const res = await handleIncomingNotification(db, { text: notifText, source: 'TestHarness' });

  assert(res.ok === true, 'handleIncomingNotification succeeds');
  assert(res.action === 'MATCHED', `Action is MATCHED (got ${res.action})`);
  assert(res.orderId === 'test-order-123', 'Correct order ID matched');

  // Verify wallet received original requestedINR (100.00), not the jittered 99.00!
  const wallet = db.prepare('SELECT * FROM wallets WHERE userName = ?').get('Bob');
  assert(wallet.balanceCredits === 100, `Wallet credited requestedINR of 100 (got ${wallet.balanceCredits})`);

  // Verify order status updated to PAID
  const order = db.prepare('SELECT * FROM orders WHERE orderId = ?').get('test-order-123');
  assert(order.status === 'PAID', `Order status is PAID (got ${order.status})`);
  assert(order.utrRef === '402312345678', 'Order records parsed UTR');

  // 3. Duplicate UTR Idempotency
  console.log('\nTest Suite 3: Webhook UTR Idempotency');
  const dupRes = await handleIncomingNotification(db, { text: notifText, source: 'TestHarness' });
  assert(dupRes.action === 'DUPLICATE', `Duplicate UTR handled idempotently (got ${dupRes.action})`);

  console.log(`\nMatcher Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
