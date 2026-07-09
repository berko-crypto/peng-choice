// Two collections are supported:
//   BIG = main Pudgy Penguins (8,888 supply) — images served directly from a
//         known fixed IPFS folder CID (fast path, no on-chain call needed).
//   LIL = Lil Pudgys (22,222 supply) — different contract, different art,
//         no known fixed CID, so images are resolved properly: tokenURI(id)
//         on-chain, then follow the IPFS pointer to the metadata JSON's
//         `image` field. Slower, but only needed for PFPenguins/LIL matchups.

const BIG_CID = 'QmNf1UsmdGaMbpatQ6toXSkzDpizaGmC9zfunCyoz1enD5';
const BIG_CONTRACT = '0xBd3531dA5CF5857e7CfAA92426877b022e612cf8';
const LIL_CONTRACT = '0x524cAB2ec69124574082676e6F654a18df49A048';
const TOKEN_URI_SELECTOR = '0xc87b56dd'; // tokenURI(uint256)

const GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
];

function getImageUrl(tokenId, gatewayIndex = 0) {
  return `${GATEWAYS[gatewayIndex]}${BIG_CID}/penguin/${tokenId}.png`;
}

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

// Fetches BIG's image bytes directly (fast path), falling back across gateways.
async function fetchImageBuffer(tokenId) {
  let lastErr;
  for (let i = 0; i < GATEWAYS.length; i++) {
    const url = getImageUrl(tokenId, i);
    try {
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error(`[pudgyImages] gateway failed for #${tokenId}: ${url} — ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error(`All gateways failed for token ${tokenId}`);
}

// ---------- On-chain metadata resolution (bulk trait fetch + LIL images) ----------

function decodeAbiString(hex) {
  const clean = hex.replace(/^0x/, '');
  const offset = parseInt(clean.slice(0, 64), 16) * 2;
  const len = parseInt(clean.slice(offset, offset + 64), 16) * 2;
  const strHex = clean.slice(offset + 64, offset + 64 + len);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

async function rpcCall(tokenId, contract) {
  const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: contract, data: TOKEN_URI_SELECTOR + paddedId }, 'latest'],
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

async function fetchIpfsBytes(uri) {
  let lastErr;
  for (let i = 0; i < GATEWAYS.length; i++) {
    const url = ipfsToHttp(uri, i);
    try {
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All IPFS gateways failed');
}

// Returns { name, image, attributes: [{trait_type, value}, ...] } for a BIG token ID.
async function fetchTokenMetadata(tokenId, contract = BIG_CONTRACT) {
  const tokenUri = decodeAbiString(await rpcCall(tokenId, contract));
  return fetchIpfsJson(tokenUri);
}

// Resolves a LIL Pudgy's image bytes via on-chain tokenURI + IPFS metadata.
async function fetchLilImageBuffer(tokenId) {
  const meta = await fetchTokenMetadata(tokenId, LIL_CONTRACT);
  return fetchIpfsBytes(meta.image);
}

// Single entry point used by the composite renderer — dispatches by type.
async function fetchImageBufferForToken(tokenId, type = 'BIG') {
  return type === 'LIL' ? fetchLilImageBuffer(tokenId) : fetchImageBuffer(tokenId);
}

module.exports = {
  getImageUrl,
  fetchImageBuffer,
  fetchImageBufferForToken,
  fetchTokenMetadata,
  LIL_CONTRACT,
  BIG_CONTRACT,
};
