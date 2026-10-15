const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './axiom.db';
const db = new Database(path.resolve(__dirname, '..', DB_PATH));

// Enable WAL mode for high-throughput concurrent reads and foreign key integrity
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema and performance indexes
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
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

  CREATE INDEX IF NOT EXISTS idx_orders_status_expires 
    ON orders (status, expiresAt);

  CREATE INDEX IF NOT EXISTS idx_orders_amount_status_expires 
    ON orders (amountINR, status, expiresAt);

  CREATE TABLE IF NOT EXISTS wallets (
    userName       TEXT PRIMARY KEY,
    balanceCredits REAL NOT NULL DEFAULT 0,
    lifetimeTopup  REAL NOT NULL DEFAULT 0,
    lastUpdated    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    userName     TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,
    delta        REAL NOT NULL,
    balanceAfter REAL NOT NULL,
    orderId      TEXT,
    type         TEXT NOT NULL,
    FOREIGN KEY (userName) REFERENCES wallets(userName) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_user_time 
    ON ledger (userName, timestamp DESC);

  CREATE TABLE IF NOT EXISTS notifications_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    receivedAt   INTEGER NOT NULL,
    rawText      TEXT NOT NULL,
    parsedAmount REAL,
    parsedUTR    TEXT,
    parsedNote   TEXT,
    matchedOrder TEXT,
    status       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifs_utr_status 
    ON notifications_log (parsedUTR, status);
`);

module.exports = db;
