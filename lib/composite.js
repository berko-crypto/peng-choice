// Renders two penguin images side by side into one PNG buffer, so the
// matchup shows as a single graphic instead of two separate embeds.
// Accepts either a plain token ID (assumed BIG/main collection) or an
// { id, type } object where type is 'BIG' or 'LIL'.

const { createCanvas, loadImage } = require('canvas');
const { fetchImageBufferForToken } = require('./pudgyImages');

const TILE = 400;      // each penguin's square tile size
const GAP = 60;        // gap between tiles for the "VS" dividers
const HEIGHT = TILE;

function normalize(item) {
  return typeof item === 'object' && item !== null ? item : { id: item, type: 'BIG' };
}

async function fetchImage(item) {
  const { id, type } = normalize(item);
  const buf = await fetchImageBufferForToken(id, type);
  return loadImage(buf);
}

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

async function buildMatchupImage(...items) {
  const imgs = await Promise.all(items.map(fetchImage));
  const n = imgs.length;
  const width = TILE * n + GAP * (n - 1);

  const canvas = createCanvas(width, HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, width, HEIGHT);

  imgs.forEach((img, i) => {
    drawCover(ctx, img, i * (TILE + GAP), 0, TILE, TILE);
  });

  // "VS" badge in each gap
  for (let i = 1; i < n; i++) {
    const cx = i * (TILE + GAP) - GAP / 2;
    const cy = HEIGHT / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, GAP / 2 + 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0e14';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', cx, cy + 1);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { buildMatchupImage };
