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

module.exports = { getImageUrl, fetchImageBuffer, fetchTokenMetadata };

// ---------- On-chain metadata resolution (for the one-time bulk trait fetch) ----------
// Images are served directly from the known CID above (fast path, used on every
// /faceoff). Full metadata — including `attributes` — isn't guessable that way,
// so for the one-time bulk pull we read it properly: tokenURI(id) on-chain,
// then follow that IPFS pointer to the metadata JSON.

const CONTRACT = '0xBd3531dA5CF5857e7CfAA92426877b022e612cf8'; // Pudgy Penguins ERC-721
const SELECTOR = '0xc87b56dd'; // tokenURI(uint256)

const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
];

function ipfsToHttp(uri, gatewayIndex = 0) {
  if (!uri) return uri;
  if (uri.startsWith('ipfs://')) {
    return GATEWAYS[gatewayIndex] + uri.replace('ipfs://', '').replace(/^ipfs\//, '');
  }
  return uri;
}

async function fetchWithTimeout(url, ms = 8000, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function decodeAbiString(hex) {
  const clean = hex.replace(/^0x/, '');
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  const len = parseInt(clean.slice(offset, offset + 64), 16) * 2;
  const strHex = clean.slice(offset + 64, offset + 64 + len);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

async function rpcCall(tokenId) {
  const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: CONTRACT, data: SELECTOR + paddedId }, 'latest'],
  });
  let lastErr;
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(endpoint, 8000, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      if (!json.result) throw new Error('Empty result from RPC');
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All RPC endpoints failed');
}

async function fetchIpfsJson(uri) {
  let lastErr;
  for (let i = 0; i < GATEWAYS.length; i++) {
    const url = ipfsToHttp(uri, i);
    try {
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All IPFS gateways failed');
}

// Returns { name, image, attributes: [{trait_type, value}, ...] } for a token ID.
async function fetchTokenMetadata(tokenId) {
  const tokenUri = decodeAbiString(await rpcCall(tokenId));
  return fetchIpfsJson(tokenUri);
}
