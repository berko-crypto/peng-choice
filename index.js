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

// First trait "mode" button. Overridable via env in case your loaded metadata
// uses different exact trait naming (matching is case-insensitive either way).
const BOWLCUT_TRAIT = process.env.BOWLCUT_TRAIT_TYPE || 'Head';
const BOWLCUT_VALUE = process.env.BOWLCUT_TRAIT_VALUE || 'Bowl Cut';

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
function recordVote(matchupId, userId, winnerId, loserId) {
  const tx = db.transaction(() => {
    insertVote.run(matchupId, userId, winnerId, loserId, Date.now());
    upsertPenguin.run(winnerId);
    upsertPenguin.run(loserId);
    const w = getPenguin.get(winnerId);
    const l = getPenguin.get(loserId);
    const expectedW = 1 / (1 + 10 ** ((l.elo - w.elo) / 400));
    updatePenguin.run(w.wins + 1, w.losses, w.elo + K * (1 - expectedW), winnerId);
    updatePenguin.run(l.wins, l.losses + 1, l.elo - K * (1 - expectedW), loserId);
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
].map(c => c.toJSON());

function randomPair(traitType, value) {
  if (traitType && value) {
    const pool = tokensForTrait.all(traitType, value).map(r => r.token_id);
    if (pool.length < 2) return null; // not enough pengus in this mode
    const a = pool[Math.floor(Math.random() * pool.length)];
    let b = pool[Math.floor(Math.random() * pool.length)];
    while (b === a) b = pool[Math.floor(Math.random() * pool.length)];
    return [a, b];
  }
  const a = Math.floor(Math.random() * COLLECTION_SIZE);
  let b = Math.floor(Math.random() * COLLECTION_SIZE);
  while (b === a) b = Math.floor(Math.random() * COLLECTION_SIZE);
  return [a, b];
}

// Random pair drawn from the current top-N leaderboard, for the featured matchup —
// keeps it fresh (not always literally #1 vs #2) while still spotlighting favorites.
const FEATURED_POOL_SIZE = 10;
const FEATURED_MIN_MATCHUPS = 3;
function topPair() {
  const pool = topPenguins.all(FEATURED_MIN_MATCHUPS, FEATURED_POOL_SIZE).map(p => p.token_id);
  if (pool.length < 2) return null;
  const a = pool[Math.floor(Math.random() * pool.length)];
  let b = pool[Math.floor(Math.random() * pool.length)];
  while (b === a) b = pool[Math.floor(Math.random() * pool.length)];
  return [a, b];
}

async function faceoffMessage(a, b, traitType, value) {
  const mode = traitType && value ? `${traitType}=${value}` : '';
  const matchupId = `${a}v${b}-${Date.now().toString(36)}`;

  const imageBuffer = await buildMatchupImage(a, b);
  const filename = `matchup-${matchupId}.png`;
  const attachment = new AttachmentBuilder(imageBuffer, { name: filename });

  const embed = new EmbedBuilder()
    .setTitle(`Pengu #${a}  vs  Pengu #${b}`)
    .setImage(`attachment://${filename}`)
    .setColor(0x00A9E0)
    .setFooter({ text: '0 votes' });

  const isBowlcutMode = mode.toLowerCase() === `${BOWLCUT_TRAIT}=${BOWLCUT_VALUE}`.toLowerCase();
  const modeButton = isBowlcutMode
    ? new ButtonBuilder().setCustomId('switchmode:').setLabel('All Pengus').setStyle(ButtonStyle.Secondary).setEmoji('🎲')
    : new ButtonBuilder().setCustomId(`switchmode:${BOWLCUT_TRAIT}=${BOWLCUT_VALUE}`).setLabel('Bowlcuts Mode').setStyle(ButtonStyle.Secondary).setEmoji('🎩');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote:${matchupId}:${a}:${b}`)
      .setLabel(`#${a}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote:${matchupId}:${b}:${a}`)
      .setLabel(`#${b}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`newfaceoff:${mode}`)
      .setLabel('New matchup').setStyle(ButtonStyle.Success).setEmoji('🐧'),
    modeButton,
  );
  const content = mode
    ? `**Which pengu wears it better?** _(mode: ${traitType} → ${value})_`
    : '**Which pengu wears it better?**';
  return { content, embeds: [embed], files: [attachment], components: [row] };
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
        if (traitType && !traitCount.get().n) {
          return interaction.reply({ content: 'No trait data loaded yet — ask an admin to run the trait loader.', flags: MessageFlags.Ephemeral });
        }
        const pair = randomPair(traitType, value);
        if (!pair) {
          return interaction.reply({ content: `Not enough pengus tagged **${traitType} → ${value}** for a matchup.`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply(); // image fetch + render can exceed the 3s ack window
        const msg = await faceoffMessage(...pair, traitType, value);
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
        const lines = rows.map((p, i) =>
          `${medals[i] ?? `**${i + 1}.**`} Pengu #${p.token_id} — ${Math.round(p.elo)} Elo (${p.wins}W/${p.losses}L)`);
        const embed = new EmbedBuilder()
          .setTitle(traitType ? `🏆 Leaderboard — ${traitType}: ${value}` : '🏆 Huddle Hot-or-Not Leaderboard')
          .setDescription(lines.join('\n'))
          .setColor(0xFFD700)
          .setFooter({ text: 'Elo rating · min 3 matchups to qualify' });
        embed.setThumbnail(getImageUrl(rows[0].token_id));
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
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('switchmode:')) {
        const mode = interaction.customId.slice('switchmode:'.length);
        const [traitType, value] = mode ? mode.split('=') : [undefined, undefined];
        if (traitType && !traitCount.get().n) {
          return interaction.reply({ content: 'No trait data loaded yet — ask an admin to run the trait loader.', flags: MessageFlags.Ephemeral });
        }
        const pair = randomPair(traitType, value);
        if (!pair) {
          return interaction.reply({ content: `Not enough pengus tagged **${traitType} → ${value}** for a matchup.`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await faceoffMessage(...pair, traitType, value);
        return interaction.editReply(msg);
      }
      if (interaction.customId.startsWith('newfaceoff')) {
        const [, mode] = interaction.customId.split(':');
        const [traitType, value] = mode ? mode.split('=') : [undefined, undefined];
        const pair = randomPair(traitType, value);
        if (!pair) {
          return interaction.reply({ content: `Not enough pengus tagged **${traitType} → ${value}** for a matchup.`, flags: MessageFlags.Ephemeral });
        }
        // Ephemeral: only the clicker sees their new matchup, so the channel doesn't fill up
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await faceoffMessage(...pair, traitType, value);
        return interaction.editReply(msg);
      }
      if (interaction.customId.startsWith('vote:')) {
        const [, matchupId, winner, loser] = interaction.customId.split(':');
        if (hasVoted.get(matchupId, interaction.user.id)) {
          return interaction.reply({ content: 'One vote per matchup, penguin. 🐧', flags: MessageFlags.Ephemeral });
        }
        recordVote(matchupId, interaction.user.id, Number(winner), Number(loser));

        // Update the combined vote tally in the single embed's footer
        const tally = matchupTally.all(matchupId);
        const counts = Object.fromEntries(tally.map(t => [t.winner, t.n]));
        const [origEmbed] = interaction.message.embeds;
        const match = origEmbed?.title?.match(/Pengu #(\d+)\s+vs\s+Pengu #(\d+)/);
        let embeds = interaction.message.embeds;
        if (match) {
          const [, idA, idB] = match;
          const filename = `matchup-${matchupId}.png`;
          const footerText = `#${idA}: ${counts[idA] ?? 0} · #${idB}: ${counts[idB] ?? 0}`;
          // Rebuilt fresh (not EmbedBuilder.from(origEmbed)) — Discord resolves
          // attachment:// references into a CDN URL in cached message data, and
          // copying that resolved URL back causes the image to render twice
          // (once as the raw attachment, once as the "external" embed image).
          embeds = [
            new EmbedBuilder()
              .setTitle(origEmbed.title)
              .setColor(origEmbed.color ?? 0x00A9E0)
              .setImage(`attachment://${filename}`)
              .setFooter({ text: footerText }),
          ];
        }
        await interaction.update({ embeds });
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
    const msg = await faceoffMessage(...pair);
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
