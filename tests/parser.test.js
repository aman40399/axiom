const { parsePaytmNotification } = require('../backend/parser');

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

console.log('\n[TEST] Axiom Parser Tests\n');

// Format A
console.log('Format A: "Rs. 500.00 received from ... UPI Ref No. ..."');
{
  const r = parsePaytmNotification('Rs. 500.00 received from 9876543210. UPI Ref No. 402312345678.');
  assert(r.success === true, 'success is true');
  assert(r.parsedAmount === 500, `amount is 500 (got ${r.parsedAmount})`);
  assert(r.parsedUTR === '402312345678', `UTR is 402312345678 (got ${r.parsedUTR})`);
  assert(r.parsedNote === null, `note is null (got ${r.parsedNote})`);
}

// Format B
console.log('\nFormat B: "You have received Rs.500 from JOHN DOE. UPI Ref: ..."');
{
  const r = parsePaytmNotification('You have received Rs.500 from JOHN DOE. UPI Ref: 402312345678');
  assert(r.success === true, 'success is true');
  assert(r.parsedAmount === 500, `amount is 500 (got ${r.parsedAmount})`);
  assert(r.parsedUTR === '402312345678', `UTR is 402312345678 (got ${r.parsedUTR})`);
  assert(r.parsedNote === null, `note is null (got ${r.parsedNote})`);
}

// Format C
console.log('\nFormat C: "₹500.00 credited ... UPI Ref: ... Bal: ₹1500.00"');
{
  const r = parsePaytmNotification('₹500.00 credited to your Paytm account. UPI Ref: 402312345678. Bal: ₹1500.00');
  assert(r.success === true, 'success is true');
  assert(r.parsedAmount === 500, `amount is 500 (got ${r.parsedAmount})`);
  assert(r.parsedUTR === '402312345678', `UTR is 402312345678 (got ${r.parsedUTR})`);
  assert(r.parsedNote === null, `note is null (got ${r.parsedNote})`);
}

// Format D
console.log('\nFormat D: "Received Rs. 500 via UPI. Ref: ... Note: ABCD123456"');
{
  const r = parsePaytmNotification('Received Rs. 500 via UPI. Ref: 402312345678. Note: ABCD123456');
  assert(r.success === true, 'success is true');
  assert(r.parsedAmount === 500, `amount is 500 (got ${r.parsedAmount})`);
  assert(r.parsedUTR === '402312345678', `UTR is 402312345678 (got ${r.parsedUTR})`);
  assert(r.parsedNote === 'ABCD123456', `note is ABCD123456 (got ${r.parsedNote})`);
}

// Format E
console.log('\nFormat E: "Payment of ₹500 received. Transaction ID: ..."');
{
  const r = parsePaytmNotification('Payment of ₹500 received. Transaction ID: 402312345678');
  assert(r.success === true, 'success is true');
  assert(r.parsedAmount === 500, `amount is 500 (got ${r.parsedAmount})`);
  assert(r.parsedUTR === '402312345678', `UTR is 402312345678 (got ${r.parsedUTR})`);
  assert(r.parsedNote === null, `note is null (got ${r.parsedNote})`);
}

// Edge: comma-separated amount
console.log('\nEdge: comma-separated large amount');
{
  const r = parsePaytmNotification('Rs. 1,00,000.50 received from 9876543210. UPI Ref No. 402312345678.');
  assert(r.success === true, 'success is true');
  assert(r.parsedAmount === 100000.50, `amount is 100000.50 (got ${r.parsedAmount})`);
}

// Edge: unparseable text
console.log('\nEdge: unparseable text');
{
  const r = parsePaytmNotification('Hello world this is random text');
  assert(r.success === false, 'success is false');
  assert(r.parsedAmount === null, 'amount is null');
  assert(r.parsedUTR === null, 'UTR is null');
}

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}\n`);
process.exit(failed > 0 ? 1 : 0);
