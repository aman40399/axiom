/**
 * Axiom: Adaptive ε-Jitter Allocation Protocol (ADJA)
 * 
 * Formal Protocol Specification:
 * In zero-middleware decentralized settlement topologies, banking push notifications
 * lack distinct session correlation tokens. Axiom allocates deterministic, minimal
 * epsilon-deltas (ε) to amounts, creating an orthogonal temporal fingerprint for each
 * concurrent settlement session.
 * 
 * Algorithmic Properties:
 * - Time Complexity:  O(K) where K = 2 * maxDelta + 1 (O(1) with bounded delta)
 * - Space Complexity: O(1) auxiliary space (O(N) Set lookup)
 * - Invariant 1 (Collision Freedom): For all active sessions s_i != s_j, Amount(s_i) != Amount(s_j)
 * - Invariant 2 (Floor Bound):       Candidate >= minAmount (default: 1.00 INR)
 * - Invariant 3 (Credit Conservation): Ledger strictly credits requestedINR in full
 *
 * @author Axiom Architecture Team
 */

/**
 * Generates an alternating sequence of epsilon deltas centered around origin:
 * [0, -1, +1, -2, +2, -3, +3, ..., -maxDelta, +maxDelta]
 *
 * @param {number} maxDelta - Maximum allowed deviation
 * @param {number} step - Incremental step size (default: 1)
 * @returns {number[]}
 */
function generateAlternatingDeltas(maxDelta = 5, step = 1) {
  const deltas = [0];
  for (let d = step; d <= maxDelta; d += step) {
    deltas.push(-d);
    deltas.push(d);
  }
  return deltas;
}

/**
 * Pure algorithmic core: Resolves a unique settlement amount given the active
 * allocation state without database coupling.
 *
 * @param {number} requestedAmount - Nominal base amount
 * @param {Set<number>|number[]} activeAmounts - Active reservations in current TTL window
 * @param {Object} [options]
 * @param {number} [options.maxDelta=5] - Maximum allowed offset (+/-)
 * @param {number} [options.step=1] - Offset resolution step
 * @param {number} [options.minAmount=1] - Minimum allowable floor price
 * @returns {{ jitteredAmount: number, delta: number, slotIndex: number, poolCapacity: number }}
 * @throws {Error} JITTER_EXHAUSTED if all slots in the search window are occupied
 */
function allocateJitter(requestedAmount, activeAmounts, options = {}) {
  const { maxDelta = 5, step = 1, minAmount = 1 } = options;
  const taken = activeAmounts instanceof Set ? activeAmounts : new Set(activeAmounts);

  const deltas = generateAlternatingDeltas(maxDelta, step);
  const poolCapacity = deltas.length;

  for (let slotIndex = 0; slotIndex < deltas.length; slotIndex++) {
    const delta = deltas[slotIndex];
    // Round to 2 decimal places to avoid IEEE 754 floating point drift
    const candidate = Math.round((requestedAmount + delta) * 100) / 100;

    // Boundary condition: must satisfy floor price and uniqueness invariant
    if (candidate >= minAmount && !taken.has(candidate)) {
      return {
        jitteredAmount: candidate,
        delta,
        slotIndex,
        poolCapacity,
      };
    }
  }

  const error = new Error('JITTER_EXHAUSTED');
  error.code = 'JITTER_EXHAUSTED';
  error.details = {
    requestedAmount,
    maxDelta,
    poolCapacity,
    activeCollisions: taken.size,
  };
  throw error;
}

/**
 * Database adapter: Queries active pending orders from SQLite and allocates a unique epsilon jitter.
 *
 * @param {number} requestedINR - Amount requested by payer
 * @param {import('better-sqlite3').Database} db - SQLite database instance
 * @param {Object} [options] - Algorithm configuration overrides
 * @returns {{ jitteredAmount: number, delta: number, slotIndex: number, poolCapacity: number }}
 */
function getJitteredAmount(requestedINR, db, options = {}) {
  const now = Date.now();
  const pending = db
    .prepare("SELECT amountINR FROM orders WHERE status = 'PENDING' AND expiresAt > ?")
    .all(now);

  const taken = new Set(pending.map(o => o.amountINR));
  return allocateJitter(requestedINR, taken, options);
}

module.exports = {
  allocateJitter,
  getJitteredAmount,
  generateAlternatingDeltas,
};
