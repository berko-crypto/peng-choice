// Pengu Faceoff — "this or that" aesthetics voting for Pudgy Penguins
// Commands: /faceoff, /leaderboard, /mystats

const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const COLLECTION_SIZE = 8888; // token IDs 0–8887
const IMAGE_URL = (id) =>
  (process.env.PENGU_IMAGE_URL || 'https://api.pudgypenguins.io/penguin/image/{id}').replace('{id}', id);

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
    trait_type TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (token_id, trait_type)
  );
  CREATE INDEX IF NOT EXISTS idx_traits_lookup ON traits (trait_type, value);
`);

const traitTypes = db.prepare(
  `SELECT DISTINCT trait_type FROM traits ORDER BY trait_type`);
const traitValues = db.prepare(
  `SELECT DISTINCT value FROM traits WHERE trait_type = ? ORDER BY value`);
const tokensForTrait = db.prepare(
  `SELECT token_id FROM traits WHERE trait_type = ? AND value = ?`);
const traitCount = db.prepare(`SELECT COUNT(*) AS n FROM traits`);

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

function faceoffMessage(a, b, traitType, value) {
  const mode = traitType && value ? `${traitType}=${value}` : '';
  const matchupId = `${a}v${b}-${Date.now().toString(36)}`;
  const embeds = [
    new EmbedBuilder().setTitle(`Pengu #${a}`).setURL('https://pudgypenguins.com')
      .setImage(IMAGE_URL(a)).setColor(0x00A9E0),
    new EmbedBuilder().setTitle(`Pengu #${b}`).setURL('https://pudgypenguins.com')
      .setImage(IMAGE_URL(b)).setColor(0xFF7A00),
  ];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote:${matchupId}:${a}:${b}`)
      .setLabel(`#${a}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote:${matchupId}:${b}:${a}`)
      .setLabel(`#${b}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`newfaceoff:${mode}`)
      .setLabel('New matchup').setStyle(ButtonStyle.Success).setEmoji('🐧'),
  );
  const content = mode
    ? `**Which pengu wears it better?** _(mode: ${traitType} → ${value})_`
    : '**Which pengu wears it better?**';
  return { content, embeds, components: [row] };
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
        return interaction.reply(faceoffMessage(...pair, traitType, value));
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
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((p, i) =>
          `${medals[i] ?? `**${i + 1}.**`} Pengu #${p.token_id} — ${Math.round(p.elo)} Elo (${p.wins}W/${p.losses}L)`);
        const embed = new EmbedBuilder()
          .setTitle(traitType ? `🏆 Leaderboard — ${traitType}: ${value}` : '🏆 Huddle Hot-or-Not Leaderboard')
          .setDescription(lines.join('\n'))
          .setThumbnail(IMAGE_URL(rows[0].token_id))
          .setColor(0xFFD700)
          .setFooter({ text: 'Elo rating · min 3 matchups to qualify' });
        return interaction.reply({ embeds: [embed] });
      }
      if (interaction.commandName === 'mystats') {
        const { total } = userStats.get(interaction.user.id);
        return interaction.reply({
          content: `You've judged **${total}** matchup${total === 1 ? '' : 's'}. The huddle thanks you for your service. 🫡`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('newfaceoff')) {
        const [, mode] = interaction.customId.split(':');
        const [traitType, value] = mode ? mode.split('=') : [undefined, undefined];
        const pair = randomPair(traitType, value);
        if (!pair) {
          return interaction.reply({ content: `Not enough pengus tagged **${traitType} → ${value}** for a matchup.`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply(faceoffMessage(...pair, traitType, value));
      }
      if (interaction.customId.startsWith('vote:')) {
        const [, matchupId, winner, loser] = interaction.customId.split(':');
        if (hasVoted.get(matchupId, interaction.user.id)) {
          return interaction.reply({ content: 'One vote per matchup, penguin. 🐧', flags: MessageFlags.Ephemeral });
        }
        recordVote(matchupId, interaction.user.id, Number(winner), Number(loser));

        // Update live tally on the message
        const tally = matchupTally.all(matchupId);
        const counts = Object.fromEntries(tally.map(t => [t.winner, t.n]));
        const embeds = interaction.message.embeds.map(e => {
          const id = Number(e.title.replace('Pengu #', ''));
          return EmbedBuilder.from(e).setFooter({ text: `${counts[id] ?? 0} vote${(counts[id] ?? 0) === 1 ? '' : 's'}` });
        });
        await interaction.update({ embeds });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied) {
      interaction.reply({ content: 'Something slipped on the ice. Try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.once('clientReady', async () => {
  const rest = new REST().setToken(TOKEN);
  const route = process.env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, process.env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Logged in as ${client.user.tag} — commands registered${process.env.DISCORD_GUILD_ID ? ' (guild-scoped, instant)' : ' (global, may take up to 1hr)'}.`);
});

client.login(TOKEN);
