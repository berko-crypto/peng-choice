// Pudgy Penguins images live under one fixed IPFS folder CID:
//   {gateway}/QmNf1UsmdGaMbpatQ6toXSkzDpizaGmC9zfunCyoz1enD5/penguin/{id}.png
// So we can build the URL directly — no on-chain tokenURI lookup needed.

const CID = 'QmNf1UsmdGaMbpatQ6toXSkzDpizaGmC9zfunCyoz1enD5';

const GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

function getImageUrl(tokenId, gatewayIndex = 0) {
  return `${GATEWAYS[gatewayIndex]}${CID}/penguin/${tokenId}.png`;
}

// Fetches the image bytes, falling back across gateways if one is slow/down.
async function fetchImageBuffer(tokenId) {
  let lastErr;
  for (let i = 0; i < GATEWAYS.length; i++) {
    const url = getImageUrl(tokenId, i);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error(`[pudgyImages] gateway failed for #${tokenId}: ${url} — ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error(`All gateways failed for token ${tokenId}`);
}

module.exports = { getImageUrl, fetchImageBuffer };
