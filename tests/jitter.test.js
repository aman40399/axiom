const { allocateJitter, generateAlternatingDeltas } = require('../backend/jitter');

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

console.log('\n[TEST] Axiom Adaptive ε-Jitter Allocation (ADJA) Tests\n');

// 1. Delta Generation Sequence
console.log('Test Suite 1: Alternating Delta Sequence Generator');
{
  const deltas = generateAlternatingDeltas(3, 1);
  const expected = [0, -1, 1, -2, 2, -3, 3];
  assert(
    JSON.stringify(deltas) === JSON.stringify(expected),
    'Generates correct alternating sequence [0, -1, 1, -2, 2, -3, 3]',
    `Got: ${JSON.stringify(deltas)}`
  );
}

// 2. Base Allocation (No Collisions)
console.log('\nTest Suite 2: Zero-Delta Initial Allocation');
{
  const active = new Set();
  const res = allocateJitter(100, active);
  assert(res.jitteredAmount === 100, 'Jittered amount equals requested amount (100)');
  assert(res.delta === 0, 'Initial delta is 0');
  assert(res.slotIndex === 0, 'Slot index is 0');
  assert(res.poolCapacity === 11, 'Default pool capacity is 11 slots');
}

// 3. Collision Resolution (Alternating Steps)
console.log('\nTest Suite 3: Sequential Collision Resolution');
{
  const active = new Set([100]); // 100 is already taken
  const res1 = allocateJitter(100, active);
  assert(res1.jitteredAmount === 99, 'Resolves first collision to -1 offset (99)');
  assert(res1.delta === -1, 'Delta is -1');

  active.add(99); // 100 and 99 taken
  const res2 = allocateJitter(100, active);
  assert(res2.jitteredAmount === 101, 'Resolves second collision to +1 offset (101)');
  assert(res2.delta === 1, 'Delta is +1');

  active.add(101); // 100, 99, 101 taken
  const res3 = allocateJitter(100, active);
  assert(res3.jitteredAmount === 98, 'Resolves third collision to -2 offset (98)');
  assert(res3.delta === -2, 'Delta is -2');
}

// 4. Boundary Floor Price Protection
console.log('\nTest Suite 4: Floor Price Boundary Protection (Candidate >= minAmount)');
{
  // For amount = 1, negative offsets (1 - 1 = 0, 1 - 2 = -1) must be rejected
  const active = new Set([1]);
  const res = allocateJitter(1, active);
  assert(res.jitteredAmount > 0, `Allocated amount (${res.jitteredAmount}) is >= 1`);
  assert(res.jitteredAmount === 2, 'Skipped 0, resolved to +1 offset (2)');
  assert(res.delta === 1, 'Delta is +1');
}

// 5. Pool Exhaustion Exception
console.log('\nTest Suite 5: Pool Exhaustion Handling');
{
  // Fill all 11 slots for requested INR = 50: [50, 49, 51, 48, 52, 47, 53, 46, 54, 45, 55]
  const fullPool = new Set([50, 49, 51, 48, 52, 47, 53, 46, 54, 45, 55]);
  let threwExpected = false;
  try {
    allocateJitter(50, fullPool, { maxDelta: 5, step: 1 });
  } catch (err) {
    threwExpected = err.message === 'JITTER_EXHAUSTED' && err.code === 'JITTER_EXHAUSTED';
  }
  assert(threwExpected, 'Throws JITTER_EXHAUSTED error when all 11 slots are occupied');
}

// 6. Concurrency Simulation (11 Simultaneous Orders for Same Amount)
console.log('\nTest Suite 6: Concurrent Multi-Order Allocation Invariant');
{
  const baseAmount = 500;
  const activeOrders = new Set();
  const allocatedAmounts = [];

  for (let i = 0; i < 11; i++) {
    const allocation = allocateJitter(baseAmount, activeOrders);
    activeOrders.add(allocation.jitteredAmount);
    allocatedAmounts.push(allocation.jitteredAmount);
  }

  const uniqueAllocated = new Set(allocatedAmounts);
  assert(
    uniqueAllocated.size === 11,
    'All 11 concurrently allocated amounts are strictly unique (Invariant 1 satisfied)'
  );
  assert(
    allocatedAmounts.every(amt => amt >= 495 && amt <= 505),
    'All allocations remain strictly bounded within [base - 5, base + 5]'
  );
}

// 7. Custom Resolution Step
console.log('\nTest Suite 7: Custom Step & Window Configuration');
{
  const active = new Set([10]);
  const res = allocateJitter(10, active, { maxDelta: 2, step: 0.5 });
  assert(res.jitteredAmount === 9.5, `Custom step 0.5 resolves to 9.5 (got ${res.jitteredAmount})`);
  assert(res.delta === -0.5, 'Delta is -0.5');
}

console.log(`\nADJA Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n`);
process.exit(failed > 0 ? 1 : 0);
