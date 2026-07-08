// Resolves the real, on-chain image for a given Pudgy Penguin token ID.
//
// Pudgy Penguins has no simple public "give me an image by ID" API — the
// canonical image is whatever the ERC-721 contract's tokenURI(id) points to
// (an IPFS-hosted metadata JSON with an `image` field, also IPFS). We read
// that once per token and cache it locally so we're not hitting a public RPC
// and an IPFS gateway on every single /faceoff.

const Database = require('better-sqlite3');

const CONTRACT = '0xBd3531dA5CF5857e7CfAA92426877b022e612cf8'; // Pudgy Penguins ERC-721
// tokenURI(uint256) selector: 0xc87b56dd, uint256 arg right-padded to 32 bytes
const SELECTOR = '0xc87b56dd';

const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
];
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://nftstorage.link/ipfs/',
];

function ipfsToHttp(uri, gatewayIndex = 0) {
  if (!uri) return uri;
  if (uri.startsWith('ipfs://')) {
    return IPFS_GATEWAYS[gatewayIndex] + uri.replace('ipfs://', '').replace(/^ipfs\//, '');
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

async function rpcCall(tokenId) {
  const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
  const data = SELECTOR + paddedId;
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: CONTRACT, data }, 'latest'],
  });
  let lastErr;
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(endpoint, 8000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      if (!json.result) throw new Error('Empty result from RPC');
      return json.result; // ABI-encoded string
    } catch (err) {
      console.error(`[pudgyImages] RPC endpoint failed: ${endpoint} — ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All RPC endpoints failed');
}

// Minimal ABI decode for a single `string` return value.
function decodeAbiString(hex) {
  const clean = hex.replace(/^0x/, '');
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  const len = parseInt(clean.slice(offset, offset + 64), 16) * 2;
  const strHex = clean.slice(offset + 64, offset + 64 + len);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

async function resolveTokenUri(tokenId) {
  const resultHex = await rpcCall(tokenId);
  return decodeAbiString(resultHex);
}

async function fetchIpfsJson(ipfsOrHttpUri) {
  let lastErr;
  for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
    const url = ipfsToHttp(ipfsOrHttpUri, i);
    try {
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`[pudgyImages] IPFS gateway failed: ${url} — ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All IPFS gateways failed');
}

async function resolveImageUrl(tokenId) {
  const tokenUri = await resolveTokenUri(tokenId);
  const meta = await fetchIpfsJson(tokenUri);
  return ipfsToHttp(meta.image);
}

// ---- Caching layer ----
function createImageCache(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_cache (
      token_id INTEGER PRIMARY KEY,
      image_url TEXT NOT NULL,
      resolved_at INTEGER NOT NULL
    );
  `);
  const get = db.prepare('SELECT image_url FROM image_cache WHERE token_id = ?');
  const set = db.prepare(`
    INSERT INTO image_cache (token_id, image_url, resolved_at) VALUES (?, ?, ?)
    ON CONFLICT(token_id) DO UPDATE SET image_url = excluded.image_url, resolved_at = excluded.resolved_at`);

  return {
    async getImageUrl(tokenId) {
      const cached = get.get(tokenId);
      if (cached) return cached.image_url;
      const url = await resolveImageUrl(tokenId);
      set.run(tokenId, url, Date.now());
      return url;
    },
  };
}

module.exports = { createImageCache, resolveImageUrl };
