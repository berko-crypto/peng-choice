// Pengu Faceoff — "this or that" aesthetics voting for Pudgy Penguins
// Commands: /faceoff, /leaderboard, /mystats

const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  AttachmentBuilder, PermissionFlagsBits,
} = require('discord.js');
const Database = require('better-sqlite3');
const { getImageUrl, fetchTokenMetadata } = require('./lib/pudgyImages');
const { buildMatchupImage } = require('./lib/composite');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const COLLECTION_SIZE = 8888; // token IDs 0–8887

// BIG (main Pudgy Penguins, 0-8887) and LIL (Lil Pudgys, 0-22221) share the
// same votes/Elo tables, keyed by a single "internal id" integer. LIL ids are
// offset well above both ranges so a BIG #123 and a LIL #123 never collide.
// Anywhere outside this offset/decode pair, code should only ever see the
// internal id (for votes/Elo/customIds) or the decoded {rawId, type} (for
// display and image lookups) — never mix the two.
const LIL_ID_OFFSET = 100000;
const toInternalId = (rawId, type) => (type === 'LIL' ? LIL_ID_OFFSET + rawId : rawId);
const fromInternalId = (id) =>
  id >= LIL_ID_OFFSET ? { rawId: id - LIL_ID_OFFSET, type: 'LIL' } : { rawId: id, type: 'BIG' };

// First trait "mode" button. Overridable via env in case your loaded metadata
// uses different exact trait naming (matching is case-insensitive either way).
const BOWLCUT_TRAIT = process.env.BOWLCUT_TRAIT_TYPE || 'Head';
const BOWLCUT_VALUE = process.env.BOWLCUT_TRAIT_VALUE || 'Bowl Cut';

// Chance that a matchup becomes a 3-way "triple threat" (when the pool allows).
const TRIPLE_CHANCE = Number(process.env.TRIPLE_CHANCE ?? 0.2);

// ---------- DB ----------
const db = new Database(process.env.DB_PATH || 'faceoff.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS penguins (
    token_id INTEGER PRIMARY KEY,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    elo REAL NOT NULL DEFAULT 1000
  );
  CREATE TABLE IF NOT EXISTS votes (
    matchup_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    winner INTEGER NOT NULL,
    loser INTEGER NOT NULL,
    voted_at INTEGER NOT NULL,
    PRIMARY KEY (matchup_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS traits (
    token_id INTEGER NOT NULL,
    trait_type TEXT NOT NULL COLLATE NOCASE,
    value TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (token_id, trait_type)
  );
  CREATE INDEX IF NOT EXISTS idx_traits_lookup ON traits (trait_type, value);
  CREATE TABLE IF NOT EXISTS featured_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT
  );
  CREATE TABLE IF NOT EXISTS pfp_penguins (
    token_id INTEGER NOT NULL,
    penguin_type TEXT NOT NULL DEFAULT 'BIG',
    twitter_handle TEXT,
    discord_username TEXT,
    PRIMARY KEY (token_id, penguin_type)
  );
`);

const getFeaturedConfig = db.prepare('SELECT * FROM featured_config WHERE guild_id = ?');
const setFeaturedConfig = db.prepare(`
  INSERT INTO featured_config (guild_id, channel_id, message_id) VALUES (?, ?, NULL)
  ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = NULL`);
const setFeaturedMessageId = db.prepare(
  'UPDATE featured_config SET message_id = ? WHERE guild_id = ?');
const allFeaturedConfigs = db.prepare('SELECT * FROM featured_config');

const traitTypes = db.prepare(
  `SELECT DISTINCT trait_type FROM traits ORDER BY trait_type`);
const traitValues = db.prepare(
  `SELECT DISTINCT value FROM traits WHERE trait_type = ? ORDER BY value`);
const tokensForTrait = db.prepare(
  `SELECT token_id FROM traits WHERE trait_type = ? AND value = ?`);
const traitCount = db.prepare(`SELECT COUNT(*) AS n FROM traits`);
const insertTrait = db.prepare(`
  INSERT INTO traits (token_id, trait_type, value) VALUES (?, ?, ?)
  ON CONFLICT(token_id, trait_type) DO UPDATE SET value = excluded.value`);

const pfpCount = db.prepare(`SELECT COUNT(*) AS n FROM pfp_penguins`);
const pfpTokensByType = db.prepare(`SELECT token_id FROM pfp_penguins WHERE penguin_type = ?`);
const getPfpHandle = db.prepare(`SELECT twitter_handle FROM pfp_penguins WHERE token_id = ? AND penguin_type = ?`);
const upsertPfp = db.prepare(`
  INSERT INTO pfp_penguins (token_id, penguin_type, twitter_handle, discord_username) VALUES (?, ?, ?, ?)
  ON CONFLICT(token_id, penguin_type) DO UPDATE SET
    twitter_handle = COALESCE(excluded.twitter_handle, pfp_penguins.twitter_handle),
    discord_username = COALESCE(excluded.discord_username, pfp_penguins.discord_username)`);

const getPenguin = db.prepare('SELECT * FROM penguins WHERE token_id = ?');
const upsertPenguin = db.prepare(`
  INSERT INTO penguins (token_id) VALUES (?) ON CONFLICT(token_id) DO NOTHING`);
const updatePenguin = db.prepare(
  'UPDATE penguins SET wins = ?, losses = ?, elo = ? WHERE token_id = ?');
const insertVote = db.prepare(`
  INSERT INTO votes (matchup_id, user_id, winner, loser, voted_at)
  VALUES (?, ?, ?, ?, ?)`);
const hasVoted = db.prepare(
  'SELECT 1 FROM votes WHERE matchup_id = ? AND user_id = ?');
const topPenguins = db.prepare(`
  SELECT token_id, wins, losses, elo FROM penguins
  WHERE wins + losses >= ? ORDER BY elo DESC LIMIT ?`);
const userStats = db.prepare(`
  SELECT COUNT(*) AS total FROM votes WHERE user_id = ?`);
const matchupTally = db.prepare(`
  SELECT winner, COUNT(*) AS n FROM votes WHERE matchup_id = ? GROUP BY winner`);

// ---------- Elo ----------
const K = 32;
// loserIds is an array (1 loser for classic 1v1, 2 for a triple threat).
// Elo updates pairwise: the winner "beats" each loser independently.
function recordVote(matchupId, userId, winnerId, loserIds) {
  const tx = db.transaction(() => {
    insertVote.run(matchupId, userId, winnerId, loserIds[0], Date.now());
    upsertPenguin.run(winnerId);
    for (const loserId of loserIds) upsertPenguin.run(loserId);
    for (const loserId of loserIds) {
      const w = getPenguin.get(winnerId);
      const l = getPenguin.get(loserId);
      const expectedW = 1 / (1 + 10 ** ((l.elo - w.elo) / 400));
      updatePenguin.run(w.wins + 1, w.losses, w.elo + K * (1 - expectedW), winnerId);
      updatePenguin.run(l.wins, l.losses + 1, l.elo - K * (1 - expectedW), loserId);
    }
  });
  tx();
}

// ---------- Trait metadata parsing (shared with loadTraits.js's logic) ----------
function parseTraitsFile(text, ext) {
  const rows = [];
  if (ext === '.json') {
    const data = JSON.parse(text);
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
  } else if (ext === '.csv') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idIdx = header.indexOf('token_id');
    const typeIdx = header.indexOf('trait_type');
    const valIdx = header.indexOf('value');
    if (idIdx === -1 || typeIdx === -1 || valIdx === -1) {
      throw new Error('CSV must have header: token_id,trait_type,value');
    }
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      rows.push({ token_id: Number(cols[idIdx]), trait_type: cols[typeIdx].trim(), value: cols[valIdx].trim() });
    }
  } else {
    throw new Error('Unsupported file type — attach a .json or .csv file');
  }
  return rows;
}

// ---------- PFPenguins roster parsing ----------
// Handles the export format with quoted, comma-separated fields (some values
// can legitimately be "null" as literal text, not just empty).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parsePfpFile(text) {
  const clean = text.replace(/^\uFEFF/, ''); // strip BOM if present
  const lines = clean.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim().length);
  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idIdx = header.indexOf('penguinid');
  const typeIdx = header.indexOf('penguintype');
  const twitterIdx = header.indexOf('twitterusername');
  const discordIdx = header.indexOf('discordusername');
  if (idIdx === -1 || typeIdx === -1) {
    throw new Error('CSV must include penguinId and penguinType columns');
  }

  const map = new Map(); // "type:id" -> best row seen (prefers one with a real handle)
  let skippedInvalid = 0;
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const type = (cols[typeIdx] || '').trim().toUpperCase() === 'LIL' ? 'LIL' : 'BIG';
    const tokenId = Number((cols[idIdx] || '').trim());
    if (!Number.isInteger(tokenId)) { skippedInvalid++; continue; }
    const rawTwitter = twitterIdx !== -1 ? (cols[twitterIdx] || '').trim() : '';
    const rawDiscord = discordIdx !== -1 ? (cols[discordIdx] || '').trim() : '';
    const twitter = rawTwitter && rawTwitter.toLowerCase() !== 'null' ? rawTwitter : null;
    const discordName = rawDiscord && rawDiscord.toLowerCase() !== 'null' ? rawDiscord : null;
    const key = `${type}:${tokenId}`;
    const existing = map.get(key);
    if (!existing || (!existing.twitter_handle && twitter)) {
      map.set(key, { token_id: tokenId, penguin_type: type, twitter_handle: twitter, discord_username: discordName });
    }
  }
  const rows = [...map.values()];
  return { rows, skippedInvalid, bigCount: rows.filter(r => r.penguin_type === 'BIG').length, lilCount: rows.filter(r => r.penguin_type === 'LIL').length };
}

// ---------- Bulk on-chain trait fetch (one-time, admin-triggered) ----------
let bulkFetchRunning = false;

async function bulkFetchTraits(onProgress) {
  if (bulkFetchRunning) throw new Error('A fetch is already in progress.');
  bulkFetchRunning = true;
  const CONCURRENCY = 15;
  let done = 0, ok = 0, failed = 0;
  const ids = Array.from({ length: COLLECTION_SIZE }, (_, i) => i);

  try {
    async function worker(queue) {
      for (const tokenId of queue) {
        try {
          const meta = await fetchTokenMetadata(tokenId);
          const attrs = meta.attributes ?? [];
          const tx = db.transaction(() => {
            for (const a of attrs) {
              if (a.trait_type == null || a.value == null) continue;
              insertTrait.run(tokenId, String(a.trait_type), String(a.value));
            }
          });
          tx();
          ok++;
        } catch (err) {
          failed++;
          if (failed <= 20) console.error(`[fetchmetadata] token #${tokenId} failed: ${err.message}`);
        }
        done++;
        if (done % 200 === 0) {
          console.log(`[fetchmetadata] progress: ${done}/${COLLECTION_SIZE} (ok: ${ok}, failed: ${failed})`);
          onProgress?.(done, ok, failed);
        }
      }
    }
    // Split the full ID range into CONCURRENCY interleaved slices so one slow
    // worker doesn't block a big contiguous chunk from starting.
    const workers = Array.from({ length: CONCURRENCY }, (_, w) =>
      worker(ids.filter((_, i) => i % CONCURRENCY === w)));
    await Promise.all(workers);
    console.log(`[fetchmetadata] done. ok: ${ok}, failed: ${failed}`);
    return { ok, failed };
  } finally {
    bulkFetchRunning = false;
  }
}

// ---------- Bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('faceoff')
    .setDescription('Two pengus enter. You pick the better-looking one.')
    .addStringOption(o => o.setName('trait').setDescription('Filter by trait type, e.g. Head')
      .setAutocomplete(true).setRequired(false))
    .addStringOption(o => o.setName('value').setDescription('Filter by trait value, e.g. Bowlcut')
      .setAutocomplete(true).setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard')
    .setDescription('Top-rated pengus by community vote')
    .addStringOption(o => o.setName('trait').setDescription('Filter by trait type').setAutocomplete(true).setRequired(false))
    .addStringOption(o => o.setName('value').setDescription('Filter by trait value').setAutocomplete(true).setRequired(false)),
  new SlashCommandBuilder().setName('mystats')
    .setDescription('Your voting stats'),
  new SlashCommandBuilder().setName('setfeatured')
    .setDescription('Admin: set the channel for the auto-refreshing Featured Matchup')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post/refresh the featured matchup in').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('loadtraits')
    .setDescription('Admin: load/update trait metadata from an attached .json or .csv file')
    .addAttachmentOption(o => o.setName('file').setDescription('metadata.json (attributes array) or .csv (token_id,trait_type,value)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('fetchmetadata')
    .setDescription('Admin: pull trait data for all 8888 penguins on-chain (takes 10-20+ min, runs in background)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('loadpfp')
    .setDescription('Admin: load the PFPenguins roster from an attached CSV')
    .addAttachmentOption(o => o.setName('file').setDescription('CSV export with penguinId/penguinType/twitterUsername/discordUsername columns').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

// Picks `count` distinct random items from a pool (returns null if pool too small).
function pickN(pool, count) {
  if (pool.length < count) return null;
  const copy = [...pool];
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function randomPair(traitType, value, count = 2) {
  if (traitType && value) {
    const pool = tokensForTrait.all(traitType, value).map(r => r.token_id);
    return pickN(pool, count) ?? pickN(pool, 2); // fall back to 2 if pool too small for 3
  }
  const pool = Array.from({ length: COLLECTION_SIZE }, (_, i) => i);
  return pickN(pool, count);
}

// Picks a same-type group (BIG-vs-BIG or LIL-vs-LIL, never mixed) from the
// curated PFPenguins roster. Returns internal ids (offset-applied for LIL).
function randomPfpPair(count = 2) {
  const bigPool = pfpTokensByType.all('BIG').map(r => r.token_id);
  const lilPool = pfpTokensByType.all('LIL').map(r => r.token_id);
  const eligibleTypes = [];
  if (bigPool.length >= 2) eligibleTypes.push('BIG');
  if (lilPool.length >= 2) eligibleTypes.push('LIL');
  if (!eligibleTypes.length) return null;

  const type = eligibleTypes[Math.floor(Math.random() * eligibleTypes.length)];
  const pool = type === 'BIG' ? bigPool : lilPool;
  const picked = pickN(pool, count) ?? pickN(pool, 2);
  return picked ? picked.map(id => toInternalId(id, type)) : null;
}

// mode is one of: '' (full random), 'PFP' (curated roster), or 'TraitType=Value'
// Returns an array of 2 or 3 internal ids (occasionally 3-way, when pool allows).
function pairForMode(mode) {
  const count = Math.random() < TRIPLE_CHANCE ? 3 : 2;
  if (mode === 'PFP') return randomPfpPair(count);
  if (mode) {
    const [traitType, value] = mode.split('=');
    return randomPair(traitType, value, count);
  }
  return randomPair(undefined, undefined, count);
}

function modeGuardError(mode) {
  if (mode === 'PFP') {
    return pfpCount.get().n ? null : 'No PFPenguins loaded yet — ask an admin to run /loadpfp.';
  }
  if (mode) {
    return traitCount.get().n ? null : 'No trait data loaded yet — ask an admin to run the trait loader.';
  }
  return null;
}

// Random pair drawn from the current top-N leaderboard, for the featured matchup —
// keeps it fresh (not always literally #1 vs #2) while still spotlighting favorites.
// Type-aware: BIG and LIL entries share the same Elo table (via the id offset),
// so this picks its top-N pool per type and only pairs within one type.
const FEATURED_POOL_SIZE = 10;
const FEATURED_MIN_MATCHUPS = 3;
const topPenguinsInRange = db.prepare(`
  SELECT token_id, wins, losses, elo FROM penguins
  WHERE wins + losses >= ? AND token_id >= ? AND token_id < ?
  ORDER BY elo DESC LIMIT ?`);
function topPair() {
  const bigPool = topPenguinsInRange.all(FEATURED_MIN_MATCHUPS, 0, LIL_ID_OFFSET, FEATURED_POOL_SIZE).map(p => p.token_id);
  const lilPool = topPenguinsInRange.all(FEATURED_MIN_MATCHUPS, LIL_ID_OFFSET, Number.MAX_SAFE_INTEGER, FEATURED_POOL_SIZE).map(p => p.token_id);
  const eligible = [];
  if (bigPool.length >= 2) eligible.push(bigPool);
  if (lilPool.length >= 2) eligible.push(lilPool);
  if (!eligible.length) return null;

  const pool = eligible[Math.floor(Math.random() * eligible.length)];
  const a = pool[Math.floor(Math.random() * pool.length)];
  let b = pool[Math.floor(Math.random() * pool.length)];
  while (b === a) b = pool[Math.floor(Math.random() * pool.length)];
  return [a, b];
}

async function faceoffMessage(ids, mode = '') {
  const isPfp = mode === 'PFP';
  const matchupId = `${ids.join('v')}-${Date.now().toString(36)}`;

  // Always decode — Featured Matchup's top-N pool and PFPenguins mode can both
  // hand back offset LIL ids even when mode itself doesn't say 'PFP'.
  const contestants = ids.map(id => {
    const { rawId, type } = fromInternalId(id);
    const handle = isPfp ? getPfpHandle.get(rawId, type)?.twitter_handle : null;
    const name = type === 'LIL' ? 'Lil Pudgy' : 'Pengu';
    return {
      id, rawId, type,
      label: handle ? `@${handle}` : `#${rawId}`,
      title: handle ? `${name} #${rawId} (@${handle})` : `${name} #${rawId}`,
    };
  });

  const imageBuffer = await buildMatchupImage(...contestants.map(c => ({ id: c.rawId, type: c.type })));
  const filename = `matchup-${matchupId}.png`;
  const attachment = new AttachmentBuilder(imageBuffer, { name: filename });

  const embed = new EmbedBuilder()
    .setTitle(contestants.map(c => c.title).join('  vs  '))
    .setImage(`attachment://${filename}`)
    .setColor(0x00A9E0)
    .setFooter({ text: '0 votes' });

  const isBowlcutMode = mode.toLowerCase() === `${BOWLCUT_TRAIT}=${BOWLCUT_VALUE}`.toLowerCase();
  const bowlcutButton = isBowlcutMode
    ? new ButtonBuilder().setCustomId('switchmode:').setLabel('All Pengus').setStyle(ButtonStyle.Secondary).setEmoji('🎲')
    : new ButtonBuilder().setCustomId(`switchmode:${BOWLCUT_TRAIT}=${BOWLCUT_VALUE}`).setLabel('Bowlcuts Mode').setStyle(ButtonStyle.Secondary).setEmoji('🎩');
  const pfpButton = isPfp
    ? new ButtonBuilder().setCustomId('switchmode:').setLabel('All Pengus').setStyle(ButtonStyle.Secondary).setEmoji('🎲')
    : new ButtonBuilder().setCustomId('switchmode:PFP').setLabel('PFPenguins Mode').setStyle(ButtonStyle.Secondary).setEmoji('🐦');

  // Row 1: one vote button per contestant. Each customId carries the chosen
  // winner then all other contestants (comma-separated losers) so pairwise
  // Elo works for both 1v1 and triple threats.
  const voteStyles = [ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Secondary];
  const voteRow = new ActionRowBuilder().addComponents(
    contestants.map((c, i) => {
      const losers = contestants.filter(o => o.id !== c.id).map(o => o.id).join(',');
      return new ButtonBuilder().setCustomId(`vote:${matchupId}:${c.id}:${losers}`)
        .setLabel(c.label).setStyle(voteStyles[i]);
    })
  );
  // Row 2: utility buttons (kept separate so triple threats never overflow Discord's 5-per-row limit).
  const utilityRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`newfaceoff:${mode}`)
      .setLabel('New matchup').setStyle(ButtonStyle.Success).setEmoji('🐧'),
    bowlcutButton,
    pfpButton,
  );

  const tripleNote = contestants.length === 3 ? ' ⚡ **TRIPLE THREAT!**' : '';
  const modeNote = isPfp ? ' _(mode: PFPenguins)_' : (mode ? ` _(mode: ${mode.replace('=', ' → ')})_` : '');
  const content = `**Which pengu wears it better?**${tripleNote}${modeNote}`;
  return { content, embeds: [embed], files: [attachment], components: [voteRow, utilityRow] };
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      const traitType = interaction.options.getString('trait');
      let choices;
      if (focused.name === 'trait') {
        choices = traitTypes.all().map(r => r.trait_type);
      } else {
        choices = traitType ? traitValues.all(traitType).map(r => r.value) : [];
      }
      const filtered = choices
        .filter(c => c.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25);
      return interaction.respond(filtered.map(c => ({ name: c, value: c })));
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'faceoff') {
        const traitType = interaction.options.getString('trait');
        const value = interaction.options.getString('value');
        if ((traitType && !value) || (!traitType && value)) {
          return interaction.reply({ content: 'Pick both a trait and a value to filter, or leave both blank.', flags: MessageFlags.Ephemeral });
        }
        // Default to PFPenguins mode when there's roster data; fall back to
        // full random automatically so a plain /faceoff never dead-ends before
        // an admin has run /loadpfp.
        const mode = traitType && value ? `${traitType}=${value}` : (pfpCount.get().n >= 2 ? 'PFP' : '');
        const guardMsg = modeGuardError(mode);
        if (guardMsg) return interaction.reply({ content: guardMsg, flags: MessageFlags.Ephemeral });
        const pair = pairForMode(mode);
        if (!pair) {
          return interaction.reply({ content: `Not enough pengus for that mode yet.`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply(); // image fetch + render can exceed the 3s ack window
        const msg = await faceoffMessage(pair, mode);
        return interaction.editReply(msg);
      }
      if (interaction.commandName === 'leaderboard') {
        const traitType = interaction.options.getString('trait');
        const value = interaction.options.getString('value');
        const rows = traitType && value
          ? db.prepare(`
              SELECT p.token_id, p.wins, p.losses, p.elo FROM penguins p
              JOIN traits t ON t.token_id = p.token_id
              WHERE t.trait_type = ? AND t.value = ? AND p.wins + p.losses >= ?
              ORDER BY p.elo DESC LIMIT ?`).all(traitType, value, 3, 10)
          : topPenguins.all(3, 10);
        if (!rows.length) {
          return interaction.reply({ content: 'No qualified pengus yet — run /faceoff and get voting.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        const medals = ['🥇', '🥈', '🥉'];
        const decoded = rows.map(p => ({ ...p, ...fromInternalId(p.token_id) }));
        const lines = decoded.map((p, i) => {
          const name = p.type === 'LIL' ? 'Lil Pudgy' : 'Pengu';
          return `${medals[i] ?? `**${i + 1}.**`} ${name} #${p.rawId} — ${Math.round(p.elo)} Elo (${p.wins}W/${p.losses}L)`;
        });
        const embed = new EmbedBuilder()
          .setTitle(traitType ? `🏆 Leaderboard — ${traitType}: ${value}` : '🏆 Huddle Hot-or-Not Leaderboard')
          .setDescription(lines.join('\n'))
          .setColor(0xFFD700)
          .setFooter({ text: 'Elo rating · min 3 matchups to qualify' });
        if (decoded[0].type === 'BIG') embed.setThumbnail(getImageUrl(decoded[0].rawId)); // LIL thumbnail needs an async resolve — skipped for now
        return interaction.editReply({ embeds: [embed] });
      }
      if (interaction.commandName === 'mystats') {
        const { total } = userStats.get(interaction.user.id);
        return interaction.reply({
          content: `You've judged **${total}** matchup${total === 1 ? '' : 's'}. The huddle thanks you for your service. 🫡`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (interaction.commandName === 'setfeatured') {
        const channel = interaction.options.getChannel('channel');
        setFeaturedConfig.run(interaction.guildId, channel.id);
        await interaction.reply({ content: `Featured Matchup will now post/refresh in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
        return refreshFeatured(interaction.guildId); // post the first one immediately
      }
      if (interaction.commandName === 'loadtraits') {
        const file = interaction.options.getAttachment('file');
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const res = await fetch(file.url);
          if (!res.ok) throw new Error(`Failed to download attachment: HTTP ${res.status}`);
          const text = await res.text();
          const rows = parseTraitsFile(text, ext);
          const tx = db.transaction((rs) => { for (const r of rs) insertTrait.run(r.token_id, r.trait_type, r.value); });
          tx(rows);
          const { n: total } = traitCount.get();
          const { n: types } = db.prepare('SELECT COUNT(DISTINCT trait_type) AS n FROM traits').get();
          return interaction.editReply(`Loaded **${rows.length}** trait rows from \`${file.name}\`. DB now has **${total}** total rows across **${types}** trait types.`);
        } catch (err) {
          console.error('[loadtraits] failed:', err);
          return interaction.editReply(`Failed to load traits: ${err.message}`);
        }
      }
      if (interaction.commandName === 'fetchmetadata') {
        if (bulkFetchRunning) {
          return interaction.reply({ content: 'A metadata fetch is already running — check server logs for progress.', flags: MessageFlags.Ephemeral });
        }
        await interaction.reply({
          content: `Starting on-chain trait fetch for all **${COLLECTION_SIZE}** penguins. This can take **10-20+ minutes** and runs in the background — I'll edit this message when done if I'm still around, otherwise check server logs or just try the trait-filtered commands again in a bit.`,
          flags: MessageFlags.Ephemeral,
        });
        bulkFetchTraits().then(({ ok, failed }) => {
          interaction.editReply(`✅ Trait fetch complete. **${ok}** succeeded, **${failed}** failed. Trait modes are ready to use.`).catch(() => {
            console.log(`[fetchmetadata] finished (ok: ${ok}, failed: ${failed}) — interaction window closed, see logs only.`);
          });
        }).catch(err => {
          console.error('[fetchmetadata] fatal error:', err);
          interaction.editReply(`❌ Trait fetch failed: ${err.message}`).catch(() => {});
        });
        return;
      }
      if (interaction.commandName === 'loadpfp') {
        const file = interaction.options.getAttachment('file');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const res = await fetch(file.url);
          if (!res.ok) throw new Error(`Failed to download attachment: HTTP ${res.status}`);
          const text = await res.text();
          const { rows, skippedInvalid, bigCount, lilCount } = parsePfpFile(text);
          const tx = db.transaction((rs) => { for (const r of rs) upsertPfp.run(r.token_id, r.penguin_type, r.twitter_handle, r.discord_username); });
          tx(rows);
          const { n: total } = pfpCount.get();
          return interaction.editReply(
            `Loaded **${rows.length}** PFPenguins from \`${file.name}\` (**${bigCount}** Pudgy Penguins, **${lilCount}** Lil Pudgys, **${skippedInvalid}** invalid rows skipped). DB now has **${total}** total. Matchups always pair same-type (Pudgy-vs-Pudgy or Lil-vs-Lil).`
          );
        } catch (err) {
          console.error('[loadpfp] failed:', err);
          return interaction.editReply(`Failed to load PFPenguins: ${err.message}`);
        }
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('switchmode:')) {
        const mode = interaction.customId.slice('switchmode:'.length);
        const guardMsg = modeGuardError(mode);
        if (guardMsg) return interaction.reply({ content: guardMsg, flags: MessageFlags.Ephemeral });
        const pair = pairForMode(mode);
        if (!pair) {
          return interaction.reply({ content: 'Not enough pengus for that mode yet.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await faceoffMessage(pair, mode);
        return interaction.editReply(msg);
      }
      if (interaction.customId.startsWith('newfaceoff')) {
        const [, mode] = interaction.customId.split(':');
        const pair = pairForMode(mode);
        if (!pair) {
          return interaction.reply({ content: 'Not enough pengus for that mode yet.', flags: MessageFlags.Ephemeral });
        }
        // Ephemeral: only the clicker sees their new matchup, so the channel doesn't fill up
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await faceoffMessage(pair, mode);
        return interaction.editReply(msg);
      }
      if (interaction.customId.startsWith('vote:')) {
        const [, matchupId, winner, losersStr] = interaction.customId.split(':');
        if (hasVoted.get(matchupId, interaction.user.id)) {
          return interaction.reply({ content: 'One vote per matchup, penguin. 🐧', flags: MessageFlags.Ephemeral });
        }
        const loserIds = losersStr.split(',').map(Number);
        recordVote(matchupId, interaction.user.id, Number(winner), loserIds);

        // Update the combined vote tally in the single embed's footer. All
        // contestant ids come from this click's own customId (winner + losers),
        // not from parsing the title — avoids fragile regex and raw-vs-internal
        // id mixups for LIL matchups.
        const tally = matchupTally.all(matchupId);
        const counts = Object.fromEntries(tally.map(t => [t.winner, t.n]));
        const allIds = [Number(winner), ...loserIds].sort((x, y) => x - y);
        const filename = `matchup-${matchupId}.png`;
        const footerText = allIds
          .map(id => `#${fromInternalId(id).rawId}: ${counts[id] ?? 0}`)
          .join(' · ');
        const [origEmbed] = interaction.message.embeds;
        // Rebuilt fresh (not EmbedBuilder.from(origEmbed)) — Discord resolves
        // attachment:// references into a CDN URL in cached message data, and
        // copying that resolved URL back causes the image to render twice
        // (once as the raw attachment, once as the "external" embed image).
        const embeds = [
          new EmbedBuilder()
            .setTitle(origEmbed?.title ?? '')
            .setColor(origEmbed?.color ?? 0x00A9E0)
            .setImage(`attachment://${filename}`)
            .setFooter({ text: footerText }),
        ];
        await interaction.update({ embeds });

        // Auto-advance: immediately hand the voter a fresh matchup in the same
        // mode, ephemeral so it doesn't touch the shared public message/tally.
        try {
          const newFaceoffButton = interaction.message.components
            .flatMap(row => row.components)
            .find(c => c.customId?.startsWith('newfaceoff:'));
          const mode = newFaceoffButton ? newFaceoffButton.customId.slice('newfaceoff:'.length) : '';
          const nextPair = pairForMode(mode);
          if (nextPair) {
            const nextMsg = await faceoffMessage(nextPair, mode);
            await interaction.followUp({ ...nextMsg, flags: MessageFlags.Ephemeral });
          }
        } catch (err) {
          console.error('[vote] auto-advance failed:', err); // vote itself already succeeded, so just log and move on
        }
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Something slipped on the ice. Try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
    } else if (interaction.isRepliable() && interaction.deferred) {
      interaction.editReply({ content: 'Something slipped on the ice. Try again.' }).catch(() => {});
    }
  }
});

// ---------- Featured Matchup (auto-refreshing) ----------
async function refreshFeatured(guildId) {
  const config = getFeaturedConfig.get(guildId);
  if (!config) return;
  const pair = topPair();
  if (!pair) {
    console.log(`[featured] guild ${guildId}: not enough qualified pengus yet, skipping refresh`);
    return;
  }
  try {
    const channel = await client.channels.fetch(config.channel_id);
    const msg = await faceoffMessage(pair);
    msg.content = `🌟 **Featured Matchup — Top Contenders!** ${msg.content}`;

    if (config.message_id) {
      try {
        const existing = await channel.messages.fetch(config.message_id);
        await existing.edit({ ...msg, embeds: msg.embeds }); // full edit incl. new attachment
        return;
      } catch {
        // Old message was deleted or otherwise unfetchable — fall through and post a new one.
      }
    }
    const sent = await channel.send(msg);
    setFeaturedMessageId.run(sent.id, guildId);
  } catch (err) {
    console.error(`[featured] refresh failed for guild ${guildId}:`, err);
  }
}

function scheduleFeaturedRefresh() {
  const minutes = Number(process.env.FEATURED_INTERVAL_MINUTES) || 60;
  setInterval(() => {
    for (const config of allFeaturedConfigs.all()) {
      refreshFeatured(config.guild_id).catch(err => console.error('[featured] scheduled refresh error:', err));
    }
  }, minutes * 60 * 1000);
  console.log(`[featured] auto-refresh scheduled every ${minutes} minute(s)`);
}

client.once('clientReady', async () => {
  const rest = new REST().setToken(TOKEN);
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Logged in as ${client.user.tag} — commands registered${process.env.DISCORD_GUILD_ID ? ' (guild-scoped, instant)' : ' (global, may take up to 1hr)'}.`);
  scheduleFeaturedRefresh();
});

client.login(TOKEN);
