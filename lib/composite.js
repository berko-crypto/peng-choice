// Renders two penguin images side by side into one PNG buffer, so the
// matchup shows as a single graphic instead of two separate embeds.

const { createCanvas, loadImage } = require('canvas');

const TILE = 400;      // each penguin's square tile size
const GAP = 60;        // center gap for the "VS" divider
const WIDTH = TILE * 2 + GAP;
const HEIGHT = TILE;

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
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

async function buildMatchupImage(urlA, urlB) {
  const [imgA, imgB] = await Promise.all([fetchImage(urlA), fetchImage(urlB)]);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawCover(ctx, imgA, 0, 0, TILE, TILE);
  drawCover(ctx, imgB, TILE + GAP, 0, TILE, TILE);

  // Center "VS" badge
  const cx = TILE + GAP / 2;
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

  return canvas.toBuffer('image/png');
}

module.exports = { buildMatchupImage };
