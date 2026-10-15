# Axiom Protocol — Architectural & Formal System Specification

## 1. System Overview

Axiom is a zero-middleware decentralized payment settlement and reconciliation protocol. It enables automated settlement confirmation and ledger mutation over peer-to-peer (P2P) banking rails without reliance on centralized, fee-extracting payment aggregators.

The primary architectural challenge addressed by Axiom is the **Callback Blindspot**: native push notifications emitted by banking and settlement rails announce transfer completions, but omit client session tokens or higher-order application context.

Axiom resolves this constraint through the **Adaptive ε-Jitter Allocation (ADJA)** protocol, establishing orthogonal spatial-temporal fingerprints by allocating bounded micro-offsets to nominal settlement amounts.

---

## 2. Directory Structure

```text
axiom/
├── backend/
│   ├── index.js          # REST endpoints, static routing, centralized error handler
│   ├── db.js             # SQLite3 engine (WAL mode), schema definitions, composite indexes
│   ├── jitter.js         # Adaptive ε-Jitter Allocation (ADJA) pure algorithm & adapter
│   ├── parser.js         # Multi-format lexical notification parser
│   ├── matcher.js        # Webhook pipeline, UTR idempotency filter, atomic ledger credit
│   ├── qr.js             # UPI URI specification builder and QR encoder
│   └── rate.js           # Multi-currency exchange rate cache layer
├── frontend/
│   ├── index.html        # Protocol client interface (finite state machine driven)
│   ├── admin.html        # Node administration console (telemetry, audit log, manual matching)
│   └── qrcode.min.js     # Bundled client-side QR renderer
├── tests/
│   ├── parser.test.js    # Lexical parser test suite (25 tests)
│   ├── jitter.test.js    # ADJA algorithmic invariant test suite (19 tests)
│   └── matcher.test.js   # Reconciliation and idempotency test suite (12 tests)
├── .env.example          # Environment variable template
├── .gitignore            # Ignores secrets, dependencies, and *.db* SQLite journals
├── package.json          # Node.js dependencies and script targets
├── ARCHITECTURE.md       # Architectural specifications (this document)
└── README.md             # Formal protocol specification and deployment guide
```

---

## 3. Database Schema & Indexing Strategy

Axiom utilizes SQLite via `better-sqlite3` configured in **Write-Ahead Logging (WAL)** mode for high-throughput concurrent read execution.

### `orders` Table
Maintains settlement intents and their assigned $\epsilon$-jitter offsets.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `orderId` | TEXT | PRIMARY KEY | UUID v4 unique identifier |
| `shortId` | TEXT | NOT NULL | 8-character uppercase hex token for transaction note (`tn`) |
| `userName` | TEXT | NOT NULL | Payer identity |
| `requestedINR` | REAL | NOT NULL | Nominal settlement amount requested |
| `amountINR` | REAL | NOT NULL | Jittered amount encoded in payment URI |
| `jitterDelta` | INTEGER | DEFAULT 0 | Difference: `amountINR - requestedINR` |
| `amountUSD` | REAL | NULLABLE | Equivalent USD conversion at intent creation |
| `exchangeRate` | REAL | NULLABLE | Applied INR/USD exchange rate |
| `status` | TEXT | DEFAULT 'PENDING' | Lifecycle: `PENDING` → `PAID` / `EXPIRED` / `LATE_PAID` |
| `createdAt` | INTEGER | NOT NULL | Unix epoch millisecond timestamp |
| `expiresAt` | INTEGER | NOT NULL | Intent expiration timestamp |
| `paidAt` | INTEGER | NULLABLE | Timestamp of confirmed reconciliation |
| `utrRef` | TEXT | NULLABLE | Bank reference number extracted from webhook |
| `notifRaw` | TEXT | NULLABLE | Raw payload of matching notification |

**Indexes:**
- `idx_orders_status_expires` on `(status, expiresAt)`: Sub-millisecond sweep of expired reservations.
- `idx_orders_amount_status_expires` on `(amountINR, status, expiresAt)`: $\mathcal{O}(1)$ indexed order lookup during reconciliation.

### `wallets` Table
Maintains account balances and lifetime settlement metrics.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `userName` | TEXT | PRIMARY KEY | User identifier |
| `balanceCredits` | REAL | DEFAULT 0 | Spendable credit balance |
| `lifetimeTopup` | REAL | DEFAULT 0 | Cumulative total credited |
| `lastUpdated` | INTEGER | NOT NULL | Unix timestamp of latest mutation |

### `ledger` Table
Immutable double-entry audit trail tracking all balance mutations.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Monotonic ledger sequence ID |
| `userName` | TEXT | NOT NULL | User account identifier |
| `timestamp` | INTEGER | NOT NULL | Unix epoch millisecond |
| `delta` | REAL | NOT NULL | Signed balance increment |
| `balanceAfter` | REAL | NOT NULL | Balance snapshot post-mutation |
| `orderId` | TEXT | NULLABLE | Associated settlement intent ID |
| `type` | TEXT | NOT NULL | Classification (`TOPUP`, `MANUAL_CREDIT`, `REFUND`) |

**Indexes:**
- `idx_ledger_user_time` on `(userName, timestamp DESC)`: Fast pagination for audit verification.

### `notifications_log` Table
Raw audit log for every incoming webhook transmission.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Monotonic log ID |
| `receivedAt` | INTEGER | NOT NULL | Ingestion timestamp |
| `rawText` | TEXT | NOT NULL | Unmodified notification string |
| `parsedAmount` | REAL | NULLABLE | Regex-extracted numerical value |
| `parsedUTR` | TEXT | NULLABLE | Regex-extracted 10–12 digit reference number |
| `parsedNote` | TEXT | NULLABLE | Regex-extracted remarks / short order token |
| `matchedOrder` | TEXT | NULLABLE | Matched intent ID or `'MANUAL'` |
| `status` | TEXT | NOT NULL | `RECEIVED`, `MATCHED`, `PARSE_FAIL`, `UNMATCHED`, `DUPLICATE` |

**Indexes:**
- `idx_notifs_utr_status` on `(parsedUTR, status)`: Accelerates idempotency deduplication checks.

---

## 4. The Adaptive ε-Jitter Allocation Protocol (ADJA)

### Formal Model
Given a set of concurrent active settlement sessions:
$$\mathcal{S}_{\text{active}} = \{ s \mid s.\text{status} = \text{'PENDING'} \land s.\text{expiresAt} > t_{\text{now}} \}$$

The objective is to compute a function $f(R, \mathcal{S}_{\text{active}}) \to A$ such that:
$$\forall s \in \mathcal{S}_{\text{active}}, \quad A \neq s.\text{amountINR}$$

### Candidate Horizon Expansion
ADJA searches an alternating discrete horizon:
$$\mathcal{E} = [0, -\delta, +\delta, -2\delta, +2\delta, \dots, -K\delta, +K\delta]$$

For each candidate offset $\epsilon_k \in \mathcal{E}$:
1. Compute candidate target: $C = R + \epsilon_k$.
2. Verify floor constraint: $C \ge \text{minAmount}$.
3. Verify reservation status: $C \notin \{ s.\text{amountINR} \mid s \in \mathcal{S}_{\text{active}} \}$.
4. If valid, reserve $\{ \text{jitteredAmount}: C, \text{delta}: \epsilon_k \}$.
5. If the horizon $\mathcal{E}$ is exhausted, emit `JITTER_EXHAUSTED` (HTTP 409).

### Formal Guarantees
1. **Collision Freedom:** Invariant holds across all active sessions within TTL.
2. **Credit Conservation:** Wallet balance mutation $\Delta B = R$ (the nominal requested amount).
3. **Bounded Deviation:** $|A - R| \le K\delta$.

---

## 5. Webhook Ingestion & Reconciliation Engine

```text
Incoming Webhook (/webhook/notification or /webhook/telegram)
                     │
                     ▼
            Input Sanitization & Trim
                     │
                     ▼
           Lexical Parsing (parser.js)
       Extracts Amount, UTR, and Note
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
    Parse Failed            Parse Succeeded
  (Log PARSE_FAIL,               │
   Alert Telegram)               ▼
                     Duplicate UTR Check (Idempotency)
                                 │
                     ┌───────────┴───────────┐
                     ▼                       ▼
               Duplicate Found        New Transmission
              (Log DUPLICATE,        (Log RECEIVED)
               Acknowledge 200)              │
                                             ▼
                                  Primary Match (amountINR)
                                             │
               ┌─────────────────────────────┼─────────────────────────────┐
               ▼                             ▼                             ▼
         0 Orders Found                1 Order Found                2+ Orders Found
               │                             │                             │
               ▼                             ▼                             ▼
       Grace Window Search             Finalize Match               Ambiguous Match
   (Expired within 30 min)            (creditWallet in TXN,        (Log AMBIGUOUS,
         ┌─────┴─────┐                 status = PAID,               Alert Relay)
         ▼           ▼                 utrRef = UTR,
      1 Order     0 Orders             Alert Relay)
     (LATE_PAID) (UNMATCHED)
```

---

## 6. System Hardening & Fault Tolerance

- **Idempotency Invariant:** Transactions are keyed by bank UTR. Redundant webhook deliveries do not trigger ledger mutations.
- **ACID Transactions:** Wallet balance mutations and double-entry ledger entries execute inside isolated transactions (`db.transaction()`).
- **Grace-Window Resolution:** Asynchronous delayed settlements within 30 minutes of expiration are automatically matched and credited under `LATE_PAID`.
- **Decoupled Architecture:** Pure algorithmic resolution is decoupled from database storage, enabling independent simulation, testing, and mathematical verification.

---

## 7. Research & Ethical Use Statement

- **Educational & Sandbox Target:** This architecture is developed for academic exploration of distributed settlement reconciliation algorithms and discrete temporal identification over untrusted channels.
- **Privacy & Notification Ingestion:** Ingesting transaction data via notification listener heuristics requires elevated permissions. System implementers must deploy strictly in personal, controlled, and consensual environments.
- **Liability Disclaimer:** The software architecture is presented for educational purposes only without commercial warranty or financial custodian guarantees.

