/**
 * Parses Paytm payment notification text to extract amount, UTR, and note.
 *
 * Handles formats:
 *   A: "Rs. 500.00 received from 9876543210. UPI Ref No. 402312345678."
 *   B: "You have received Rs.500 from JOHN DOE. UPI Ref: 402312345678"
 *   C: "₹500.00 credited to your Paytm account. UPI Ref: 402312345678. Bal: ₹1500.00"
 *   D: "Received Rs. 500 via UPI. Ref: 402312345678. Note: ABCD123456"
 *   E: "Payment of ₹500 received. Transaction ID: 402312345678"
 */
function parsePaytmNotification(text) {
  // Extract amount — handles Rs., Rs, ₹, with or without decimals, with commas
  const amountMatch = text.match(/(?:Rs\.?\s*|₹\s*)([\d,]+(?:\.\d{1,2})?)/i);
  const parsedAmount = amountMatch
    ? parseFloat(amountMatch[1].replace(/,/g, ''))
    : null;

  // Extract UTR — 10 to 12 digit number after ref keywords
  const utrMatch = text.match(
    /(?:UPI\s*Ref(?:\s*No\.?)?|Ref(?:erence)?|Transaction\s*ID)[:\s.]+(\d{10,12})/i
  );
  const parsedUTR = utrMatch ? utrMatch[1] : null;

  // Extract note/order ID — 8-12 char alphanumeric after Note keyword
  const noteMatch = text.match(/(?:Note|Remarks?|Tn)[:\s]+([A-Z0-9]{8,12})/i);
  const parsedNote = noteMatch ? noteMatch[1] : null;

  // Success if we have at least an amount — UTR is optional (Paytm app notifications often omit it)
  const success = parsedAmount !== null;

  return { parsedAmount, parsedUTR, parsedNote, success, raw: text };
}

module.exports = { parsePaytmNotification };
