# Axiom

An $\epsilon$-Jitter Protocol for Zero-Middleware Payment Settlement.

[![Protocol Test Suite](https://img.shields.io/badge/verification-56%20passed-green.svg?style=flat-square)](tests/)
[![Runtime Engine](https://img.shields.io/badge/node-%3E%3D18.0.0-blue.svg?style=flat-square)](https://nodejs.org/)
[![Storage Engine](https://img.shields.io/badge/sqlite3-WAL%20mode-orange.svg?style=flat-square)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg?style=flat-square)](LICENSE)

---

## 1. Abstract & System Motivation

Modern peer-to-peer (P2P) banking and instant settlement rails (such as India's Unified Payments Interface - UPI) process billions of direct transfers with sub-second finality. However, integrating decentralized or self-hosted services directly into these networks introduces the **Callback Blindspot**:

1. Commercial payment aggregators introduce intermediary fees (2.0% to 3.0% + tax) and require centralized custodial registration.
2. Direct settlement over native payment rails incurs zero gateway fees, but incoming asynchronous push notifications and settlement webhooks do not transmit application-layer transaction identifiers or client state tokens.
3. Concurrent settlement requests of identical nominal value yield indistinguishable confirmation messages:
   ```text
   "Rs. 100.00 received from 9876543210. UPI Ref No. 402312345678."
   ```

**Axiom** resolves this ambiguity without intermediary aggregators by formulating payment reconciliation as a discrete spatial-temporal fingerprinting problem over a bounded $\epsilon$-offset domain.

---

## 2. The $\epsilon$-Jitter Protocol (ADJA)

The core mechanism of Axiom is the **Adaptive Delta-Jitter Allocation (ADJA)** protocol.

Rather than publishing uniform payment requests, an Axiom node assigns a deterministic micro-offset ($\epsilon$) to the nominal requested amount. The resulting value $A = R + \epsilon$ acts as an ephemeral, collision-free identifier for the duration of the settlement window.

### Candidate Search Topology

Let $R \in \mathbb{R}^+$ be the nominal settlement amount requested by a client. Let $\mathcal{S}_{\text{active}}$ be the set of currently unresolved settlement intents within their validity time-to-live ($\text{TTL}$):

$$\mathcal{S}_{\text{active}} = \{ s \mid s.\text{status} = \text{'PENDING'} \land s.\text{expiresAt} > t_{\text{current}} \}$$

The algorithm traverses candidate deltas $\epsilon$ following an alternating expansion sequence centered at zero:

$$\mathcal{E} = [0, -\delta, +\delta, -2\delta, +2\delta, \dots, -K\delta, +K\delta]$$

Where $\delta$ represents the step granularity ($1.00\text{ INR}$) and $K$ represents the search horizon ($K = 5$).

```text
                     Nominal Amount: R = 100.00
                                 │
                                 ▼
                     Alternating Search Sequence
             [0, -1, +1, -2, +2, -3, +3, -4, +4, -5, +5]
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
    ε = 0 (100.00)          ε = -1 (99.00)          ε = +1 (101.00)
    [Slot Allocated]       [Slot Available]        [Next Candidate]
                                 │
                                 ▼
                    Assigned Settlement Target:
                           INR 99.00
```

### Formal Invariants & Guarantees

- **Theorem 1 (Collision Freedom):**  
  $$\forall s_i, s_j \in \mathcal{S}_{\text{active}}, \quad i \neq j \implies A(s_i) \neq A(s_j)$$  
  *Proof sketch:* Candidates are allocated atomically against the set of occupied reservation slots. Any candidate $C \in \{ A(s) \mid s \in \mathcal{S}_{\text{active}} \}$ is rejected prior to reservation.

- **Theorem 2 (Non-Negative Floor Bound):**  
  $$A_{\text{candidate}} \ge \text{minAmount} \quad (\text{default: } 1.00\text{ INR})$$  
  Candidates where $R + \epsilon < \text{minAmount}$ are excluded by construction, ensuring financial validity on low-value micro-transactions.

- **Theorem 3 (Conservation of Credit):**  
  $$\Delta_{\text{ledger}} \equiv R$$  
  The internal double-entry accounting ledger strictly credits the nominal amount $R$. The offset $\epsilon$ functions exclusively as a reconciliation signal over the wire, guaranteeing zero financial leakage or balance discrepancy for the payer.

- **Computational Complexity:**
  - Candidate Selection Time: $\mathcal{O}(K) = \mathcal{O}(1)$ for bounded search horizon $K$.
  - Collision Verification: $\mathcal{O}(1)$ amortized lookup via hash indexing.
  - Auxiliary Memory Space: $\mathcal{O}(N)$ where $N = |\mathcal{S}_{\text{active}}|$.

---

## 3. Architecture & Protocol Flow

```text
+-------------------+        1. POST /api/order (R = 100)
| Protocol Client   | -------------------------------------------> +-------------------------+
+-------------------+                                              |       Axiom Node        |
        ^                                                          +-------------------------+
        |                                                                       |
        | 3-sec Polling (GET /api/order/:id/status)                             | 2. Computes ε-Jitter
        |                                                                       v
        |                                                          +-------------------------+
        |                                                          |  SQLite (WAL) Engine    |
        |                                                          +-------------------------+
        |                                                                       |
        | 200 OK (QR payload: A = 99.00, shortId = A1B2C3D4)                    |
        +-----------------------------------------------------------------------+
        |
        | 3. Payment transmitted across banking rail (99.00 INR)
        v
+-------------------+        Push Notification / SMS
|   Banking Rail    | -------------------------------------------> +-------------------------+
+-------------------+                                              |  Forwarding Agent / Bot |
                                                                   +-------------------------+
                                                                                |
                                                                                | 4. POST /webhook/notification
                                                                                v
+--------------------------------------------------------------------------------------------+
| Axiom Ingestion & Reconciliation Pipeline                                                  |
|                                                                                            |
| 1. Lexical Parsing     --> Extracts Amount (99.00), UTR (402312345678), Note (A1B2C3D4)    |
| 2. Idempotency Filter  --> UTR duplicate check against historical notifications_log        |
| 3. Primary Lookup      --> SELECT FROM orders WHERE amountINR = 99 AND status = 'PENDING'   |
| 4. State Transition    --> Atomically marks order PAID, appends to double-entry ledger     |
+--------------------------------------------------------------------------------------------+
```

---

## 4. Subsystem Components

### Storage Subsystem (`backend/db.js`)
Configured with SQLite3 operating in **Write-Ahead Logging (WAL)** mode. Features composite B-Tree indexes:
- `idx_orders_status_expires` on `(status, expiresAt)`: Sub-millisecond sweep of expired reservation slots.
- `idx_orders_amount_status_expires` on `(amountINR, status, expiresAt)`: $\mathcal{O}(1)$ indexed order reconciliation.
- `idx_notifs_utr_status` on `(parsedUTR, status)`: Fast verification of incoming reference numbers.

### Reconciliation Engine (`backend/matcher.js`)
- **Idempotency:** Ingested banking notifications are keyed by bank UTR (Unique Transaction Reference). Retried or re-transmitted webhooks are acknowledged without side effects.
- **Grace Window Fallback:** Orders remaining unmatched within their active window enter an extended 30-minute grace index, enabling delayed transaction recovery.

### Lexical Parser (`backend/parser.js`)
A deterministic regex extraction engine supporting heterogeneous banking push notification formats (including standard Indian banking SMS and notification text structures).

---

## 5. Repository Structure

```text
.
├── backend/
│   ├── db.js             # SQLite engine initialization, pragmas, and indexing
│   ├── index.js          # REST protocol endpoints, static assets, error handlers
│   ├── jitter.js         # Pure ADJA algorithm and state allocation adapter
│   ├── matcher.js        # Notification pipeline, ledger mutations, idempotency
│   ├── parser.js         # Lexical regex parser for settlement payloads
│   ├── qr.js             # UPI URI specification builder and QR encoder
│   └── rate.js           # Multi-currency exchange rate cache layer
├── frontend/
│   ├── admin.html        # Node administration console and live telemetry
│   ├── index.html        # Client settlement interface (state machine driven)
│   └── qrcode.min.js     # Bundled client-side QR renderer
├── tests/
│   ├── jitter.test.js    # Invariant, floor protection, and collision tests (19)
│   ├── matcher.test.js   # Reconciliation, ledger mutation, and idempotency tests (12)
│   └── parser.test.js    # Syntax validation across notification formats (25)
├── ARCHITECTURE.md       # Formal system and schema specification
├── LICENSE               # MIT License
├── package.json          # Node package definition
└── README.md             # This document
```

---

## 6. Installation & Deployment

### Environment Requirements
- Node.js >= 18.0.0
- npm >= 9.0.0

### Build & Run
```bash
git clone https://github.com/your-username/axiom.git
cd axiom
npm install
```

### Configuration
```bash
cp .env.example .env
```

Configurable parameters in `.env`:
```env
PORT=3000
PAYTM_VPA=merchant@upi
MERCHANT_NAME=Axiom Node
DB_PATH=./axiom.db
ORDER_EXPIRY_MINUTES=10
MIN_AMOUNT_INR=1
MAX_AMOUNT_INR=10000
```

### Starting the Node
```bash
# Production mode
npm start

# Development mode (automatic reload)
npm run dev
```

Endpoints exposed:
- Client Protocol Interface: `http://localhost:3000`
- Node Management Console: `http://localhost:3000/admin`
- Ingestion Endpoints: `POST http://localhost:3000/webhook/notification`, `POST http://localhost:3000/webhook/telegram`

---

## 7. Verification & Automated Test Suite

Axiom includes an automated test harness covering the parser, protocol invariants, and reconciliation transactions.

```bash
npm test
```

Execution trace:
```text
> axiom-protocol@1.0.0 test
> node tests/parser.test.js && node tests/jitter.test.js && node tests/matcher.test.js

[TEST] Axiom Parser Tests
  [PASS] Format A: amount, UTR, and note extraction
  [PASS] Format B: receiver name and amount extraction
  [PASS] Format C: balance and reference parsing
  [PASS] Format D: custom note extraction
  [PASS] Format E: transaction ID parsing
  [PASS] Edge Cases: comma-separated values, malformed payloads
  Results: 25 passed, 0 failed

[TEST] Axiom Adaptive ε-Jitter Allocation (ADJA) Tests
  [PASS] Alternating delta sequence generation [0, -1, 1, -2, 2, ...]
  [PASS] Zero-delta baseline allocation
  [PASS] Sequential collision handling
  [PASS] Floor price protection (Candidate >= minAmount)
  [PASS] Exhaustion exception handling
  [PASS] Multi-tenant concurrent allocation invariant
  [PASS] Fractional step sizing
  Results: 19 passed, 0 failed

[TEST] Axiom Matcher & Reconciliation Tests
  [PASS] Double-entry wallet transactions and ledger consistency
  [PASS] Webhook notification matching pipeline
  [PASS] Conservation of credit invariant
  [PASS] UTR deduplication and idempotency
  Results: 12 passed, 0 failed

Total: 56 passed, 0 failed
```

---

## 8. Protocol API Specification

### Settlement Intents

#### `POST /api/order`
Registers a new settlement intent and reserves a unique $\epsilon$-jitter slot.

- **Request Payload:**
  ```json
  {
    "amountINR": 250.00,
    "userName": "alice"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "orderId": "3fae5f5e-34a2-42bc-860a-786cc675cf93",
    "shortId": "C44C1F9C",
    "qrDataUrl": "data:image/png;base64,...",
    "upiLink": "upi://pay?pa=...&am=249.00&...",
    "jitteredAmount": 249.00,
    "originalAmount": 250.00,
    "jitterDelta": -1,
    "amountUSD": 2.97,
    "exchangeRate": 0.0119,
    "expiresAt": 1792082840000
  }
  ```
- **Response (409 Conflict):**
  Emitted if the candidate search horizon $\mathcal{E}$ is fully occupied for the requested nominal amount.

#### `GET /api/order/:id/status`
Returns settlement state (`PENDING`, `PAID`, `EXPIRED`, `LATE_PAID`).

#### `GET /api/wallet/:userName`
Returns the ledger balance and the last 20 immutable ledger transactions.

### Webhook Ingestion

#### `POST /webhook/notification`
Stream ingestion target for notification forwarding daemons.
- **Payload:** `{ "text": "...", "isTest": false }`
- **Headers:** `x-axiom-source: RelayDaemon`

#### `POST /webhook/telegram`
Telegram Bot webhook ingestion relay.

---

## 9. Research & Educational Purpose Disclaimer

### Experimental Scope & Privacy Considerations
This codebase is an open-source academic research proof-of-concept developed solely for educational inquiry into algorithmic payment matching, discrete $\epsilon$-jitter distributions, and zero-middleware peer-to-peer settlement topologies.

### Notification Ingestion Notice
The protocol operates by programmatically inspecting incoming push notifications on a host device (e.g., via Android's `NotificationListenerService` or private webhook forwarders) to extract transaction confirmations. Users and researchers deploying this software must acknowledge that:
1. **Elevated Privileges:** Enabling notification interception grants broad access to device notifications. Use of this mechanism must be conducted strictly with explicit device-owner knowledge and consent.
2. **Personal & Sandbox Use Only:** This software is designed and recommended exclusively for personal research, educational sandboxes, and controlled local environments. It is not intended, certified, or audited for commercial deployment or enterprise financial custody.
3. **User Responsibility:** Any deployment, configuration, or utilization of this code is undertaken at the user's sole discretion, responsibility, and risk. Users are independently responsible for compliance with all applicable local financial, telecommunications, and data privacy regulations.

### Disclaimer of Warranty & Limitation of Liability
The software is provided "AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors, maintainers, or copyright holders be liable for any claim, damages, regulatory penalties, financial loss, or other liability arising from, out of, or in connection with the software or the use or other dealings in the software.

---

## 10. License

This project is licensed under the [MIT License](LICENSE).

