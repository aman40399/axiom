const fetch = require('node-fetch');

let cachedRate = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getExchangeRate() {
  const now = Date.now();
  if (cachedRate && now - cachedAt < CACHE_TTL) {
    return cachedRate;
  }

  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=INR&to=USD');
    const data = await res.json();
    cachedRate = data.rates.USD; // e.g. 0.012 means 1 INR = 0.012 USD
    cachedAt = now;
    return cachedRate;
  } catch (err) {
    console.error('Exchange rate fetch failed:', err.message);
    // Return last cached value or a sensible fallback
    return cachedRate || 0.012;
  }
}

module.exports = { getExchangeRate };
