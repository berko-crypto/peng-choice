// Load trait metadata into faceoff.db.
//
// Accepts either:
//  1. JSON array of standard NFT metadata objects:
//     [{ "token_id": 0, "attributes": [{ "trait_type": "Head", "value": "Bowlcut" }, ...] }, ...]
//     ("tokenId"/"id"/"edition" also accepted for the id field)
//  2. CSV with header: token_id,trait_type,value
//
// Usage:
//   node loadTraits.js path/to/metadata.json
//   node loadTraits.js path/to/metadata.csv
//   DB_PATH=faceoff.db node loadTraits.js metadata.json

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node loadTraits.js <metadata.json|metadata.csv>');
  process.exit(1);
}

const db = new Database(process.env.DB_PATH || 'faceoff.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS traits (
    token_id INTEGER NOT NULL,
    trait_type TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (token_id, trait_type)
  );
`);

const insert = db.prepare(`
  INSERT INTO traits (token_id, trait_type, value) VALUES (?, ?, ?)
  ON CONFLICT(token_id, trait_type) DO UPDATE SET value = excluded.value`);

const ext = path.extname(file).toLowerCase();
let rowCount = 0;

const tx = db.transaction((rows) => {
  for (const r of rows) {
    insert.run(r.token_id, r.trait_type, r.value);
    rowCount++;
  }
});

if (ext === '.json') {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const entry of data) {
    const tokenId = entry.token_id ?? entry.tokenId ?? entry.id ?? entry.edition;
    if (tokenId === undefined) continue;
    const attrs = entry.attributes ?? entry.traits ?? [];
    for (const a of attrs) {
      const traitType = a.trait_type ?? a.traitType ?? a.type;
      const value = a.value;
      if (traitType == null || value == null) continue;
      rows.push({ token_id: Number(tokenId), trait_type: String(traitType), value: String(value) });
    }
  }
  tx(rows);
} else if (ext === '.csv') {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idIdx = header.indexOf('token_id');
  const typeIdx = header.indexOf('trait_type');
  const valIdx = header.indexOf('value');
  if (idIdx === -1 || typeIdx === -1 || valIdx === -1) {
    console.error('CSV must have header: token_id,trait_type,value');
    process.exit(1);
  }
  const rows = lines.slice(1).map(line => {
    const cols = line.split(',');
    return { token_id: Number(cols[idIdx]), trait_type: cols[typeIdx].trim(), value: cols[valIdx].trim() };
  });
  tx(rows);
} else {
  console.error('Unsupported file type. Use .json or .csv');
  process.exit(1);
}

const { n: total } = db.prepare('SELECT COUNT(*) AS n FROM traits').get();
const { n: types } = db.prepare('SELECT COUNT(DISTINCT trait_type) AS n FROM traits').get();
console.log(`Loaded ${rowCount} trait rows this run. DB now has ${total} total rows across ${types} trait types.`);
