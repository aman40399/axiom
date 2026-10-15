const QRCode = require('qrcode');
const crypto = require('crypto');

function generateShortId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
}

function buildUPILink({ vpa, name, amount, shortId }) {
  const params = new URLSearchParams({
    pa: vpa,
    pn: name,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: shortId,
  });
  return `upi://pay?${params.toString()}`;
}

async function generateQR({ vpa, name, amount, shortId }) {
  const upiLink = buildUPILink({ vpa, name, amount, shortId });
  const qrDataUrl = await QRCode.toDataURL(upiLink, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return { qrDataUrl, upiLink };
}

module.exports = { generateQR, generateShortId, buildUPILink };
