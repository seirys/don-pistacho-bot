import express from 'express';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import Database from 'better-sqlite3';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from 'discord.js';

/* ======================
   CONFIG
====================== */
const { DISCORD_TOKEN, DISCORD_APP_ID, TMDB_BEARER, ADMIN_ROLE_IDS } = process.env;

// ✅ Pon aquí el ID de TU servidor
const GUILD_ID = '1305958195570937866';

// Ajustes
const COOLDOWN_HOURS = 24;          // no repetir sugerida en 24h (si hay opciones)
const AVOID_LAST_POLLS = 3;         // evita pelis de las últimas N votaciones (si hay opciones)
const VOTE_DURATION_MS = 300_000;   // ⏱️ 5 minutos (cambia aquí si quieres)
const VOTE_OPTIONS_DEFAULT = 3;     // si /votar sin titulos
const LIST_LIMIT = 100;

if (!DISCORD_TOKEN || !DISCORD_APP_ID || !TMDB_BEARER) {
  console.error('❌ Faltan variables en .env (DISCORD_TOKEN, DISCORD_APP_ID, TMDB_BEARER)');
  process.exit(1);
}

/* ======================
   ADMIN ROLES (opcional)
====================== */
const ADMIN_ROLE_SET = new Set(
  (ADMIN_ROLE_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

function isAdmin(interaction) {
  if (ADMIN_ROLE_SET.size === 0) return true; // si no configuras roles, cualquiera puede
  const memberRoles = interaction.member?.roles;
  if (!memberRoles?.cache) return false;
  return memberRoles.cache.some(r => ADMIN_ROLE_SET.has(r.id));
}

/* ======================
   DB (ruta estable)
====================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'movies.db');

const db = new Database(DB_PATH);

// Tabla principal
db.prepare(`
  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER UNIQUE,
    title TEXT NOT NULL,
    year TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    added_by TEXT,
    watched_at TEXT,
    watched_by TEXT,
    last_suggested_at TEXT,
    suggested_count INTEGER NOT NULL DEFAULT 0
  )
`).run();

// Historial votaciones
db.prepare(`
  CREATE TABLE IF NOT EXISTS poll_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS poll_history_items (
    poll_id INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year TEXT,
    source TEXT,
    FOREIGN KEY (poll_id) REFERENCES poll_history(id)
  )
`).run();

/* ---- migración suave: si falta la columna "source", la añadimos ---- */
function ensureColumn(table, column, typeSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const has = cols.some(c => c.name === column);
  if (!has) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`).run();
      console.log(`🛠️ Migración: añadida columna ${table}.${column}`);
    } catch (e) {
      console.warn(`⚠️ No pude migrar ${table}.${column}:`, e?.message || e);
    }
  }
}
ensureColumn('poll_history_items', 'source', 'TEXT');

/* ======================
   TMDB SEARCH (mejorada)
====================== */
function extractYearFromQuery(q) {
  const m = q.match(/\b(19\d{2}|20\d{2})\b/);
  if (!m) return { clean: q.trim(), year: null };
  const year = m[1];
  const clean = q.replace(m[0], '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  return { clean, year };
}

function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---- IMDb helpers ---- */
function extractImdbId(input) {
  // acepta link completo o texto con tt1234567
  const m = String(input || '').match(/tt\d{7,8}/i);
  return m ? m[0].toLowerCase() : null;
}

async function tmdbFindByImdb(imdbId) {
  const r = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
    headers: { Authorization: `Bearer ${TMDB_BEARER}` },
    params: { external_source: 'imdb_id', language: 'es-ES' },
  });
  return r.data?.movie_results?.[0] || null;
}

async function tmdbSearchMovie(query) {
  const { clean, year } = extractYearFromQuery(query);

  const r = await axios.get('https://api.themoviedb.org/3/search/movie', {
    headers: { Authorization: `Bearer ${TMDB_BEARER}` },
    params: { query: clean, include_adult: false, language: 'es-ES' },
  });

  const results = r.data?.results ?? [];
  if (!results.length) return null;

  const qNorm = normalizeTitle(clean);

  const scored = results.map(m => {
    const y = (m.release_date || '').slice(0, 4);
    const titleNorm = normalizeTitle(m.title);
    const voteCount = m.vote_count ?? 0;
    const popularity = m.popularity ?? 0;

    let score = voteCount * 2 + popularity;
    if (year && y === year) score += 10_000;
    if (titleNorm === qNorm) score += 2_000;
    if (titleNorm.includes(qNorm) || qNorm.includes(titleNorm)) score += 500;

    return { m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].m;
}

async function tmdbResolveMovie(input) {
  // Si viene IMDb -> clava la peli. Si no, busca por título.
  const imdbId = extractImdbId(input);
  if (imdbId) return await tmdbFindByImdb(imdbId);
  return await tmdbSearchMovie(input);
}

/* ======================
   Anti-repetición / selección
====================== */
function hoursAgoIso(h) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function getRecentlyUsedTmdbIds(limitPolls) {
  const polls = db.prepare(`SELECT id FROM poll_history ORDER BY id DESC LIMIT ?`).all(limitPolls);
  if (!polls.length) return new Set();

  const ids = db.prepare(`
    SELECT tmdb_id FROM poll_history_items
    WHERE poll_id IN (${polls.map(p => p.id).join(',')})
  `).all();

  return new Set(ids.map(r => r.tmdb_id));
}

function pickMoviesSmart(n) {
  const cooldownIso = hoursAgoIso(COOLDOWN_HOURS);
  const recentSet = getRecentlyUsedTmdbIds(AVOID_LAST_POLLS);

  let rows = db.prepare(`
    SELECT tmdb_id, title, year, suggested_count, last_suggested_at, added_at
    FROM movies
    WHERE status='pending'
      AND (last_suggested_at IS NULL OR last_suggested_at < ?)
      AND tmdb_id NOT IN (${[...recentSet].length ? [...recentSet].join(',') : -1})
  `).all(cooldownIso);

  if (rows.length < n) {
    rows = db.prepare(`
      SELECT tmdb_id, title, year, suggested_count, last_suggested_at, added_at
      FROM movies
      WHERE status='pending'
        AND (last_suggested_at IS NULL OR last_suggested_at < ?)
    `).all(cooldownIso);
  }

  if (rows.length < n) {
    rows = db.prepare(`
      SELECT tmdb_id, title, year, suggested_count, last_suggested_at, added_at
      FROM movies
      WHERE status='pending'
    `).all();
  }

  rows.sort((a, b) => {
    const sc = (a.suggested_count ?? 0) - (b.suggested_count ?? 0);
    if (sc !== 0) return sc;
    return String(a.added_at).localeCompare(String(b.added_at));
  });

  const candidates = rows.slice(0, Math.max(n * 4, n));
  const picked = [];
  const copy = [...candidates];
  while (copy.length && picked.length < Math.min(n, rows.length)) {
    const i = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(i, 1)[0]);
  }
  return picked;
}

function markSuggested(tmdbIds) {
  const ts = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE movies
    SET last_suggested_at = ?, suggested_count = suggested_count + 1
    WHERE tmdb_id = ?
  `);
  const tx = db.transaction((ids) => { for (const id of ids) stmt.run(ts, id); });
  tx(tmdbIds);
}

function savePollHistory(items, source = 'db') {
  const pollId = db.prepare(`INSERT INTO poll_history DEFAULT VALUES`).run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO poll_history_items (poll_id, tmdb_id, title, year, source) VALUES (?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const m of items) ins.run(pollId, m.tmdb_id, m.title, m.year ?? '', source);
  });
  tx();
  return pollId;
}

/* ======================
   Helpers
====================== */
function parseTitlesList(raw) {
  // Soporta comas y punto y coma. Máximo 5 (botones).
  return (raw || '')
    .split(/[;,]/g)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function formatMovieLine(m) {
  return `${m.title}${m.year ? ` (${m.year})` : ''}`;
}

/* ======================
   SLASH COMMANDS
====================== */
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Muestra ayuda y comandos'),
  new SlashCommandBuilder().setName('ping').setDescription('Responde pong'),

  new SlashCommandBuilder()
    .setName('movie')
    .setDescription('Busca una peli en TMDB (ej: "Matrix 1999")')
    .addStringOption(o =>
      o.setName('titulo').setDescription('Título (o link IMDb)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Añade una peli a la lista (título o link IMDb)')
    .addStringOption(o =>
      o.setName('titulo').setDescription('Ej: "Matrix 1999" o https://www.imdb.com/title/tt0133093/').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Elimina una peli de la lista (texto que coincida)')
    .addStringOption(o =>
      o.setName('titulo').setDescription('Mejor algo específico').setRequired(true)
    ),

  new SlashCommandBuilder().setName('list').setDescription('Lista pelis pendientes'),

  new SlashCommandBuilder()
    .setName('visto')
    .setDescription('Marca peli como vista')
    .addStringOption(o =>
      o.setName('titulo').setDescription('Texto que coincida con el título').setRequired(true)
    ),

  new SlashCommandBuilder().setName('quevemos').setDescription('Elige una peli pendiente (anti-repetición)'),

  new SlashCommandBuilder()
    .setName('votar')
    .setDescription('Votación con botones (titulos, links IMDb o desde la lista)')
    .addStringOption(o =>
      o.setName('titulos')
        .setDescription('Lista separada por comas/; (máx 5). Acepta links IMDb.')
        .setRequired(false)
    )
    .addIntegerOption(o =>
      o.setName('opciones')
        .setDescription('Si NO pones titulos: cuántas pelis sacar de pendientes (3-5)')
        .setRequired(false)
    ),

  new SlashCommandBuilder().setName('stats').setDescription('Estadísticas del cine'),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Exporta la lista (backup)')
    .addStringOption(o =>
      o.setName('formato')
        .setDescription('json o csv')
        .setRequired(false)
        .addChoices({ name: 'json', value: 'json' }, { name: 'csv', value: 'csv' })
    ),

  new SlashCommandBuilder()
    .setName('import')
    .setDescription('Importa un backup')
    .addAttachmentOption(o =>
      o.setName('archivo').setDescription('Archivo .json o .csv exportado').setRequired(true)
    )
    .addStringOption(o =>
      o.setName('modo')
        .setDescription('merge añade / replace borra y carga')
        .setRequired(false)
        .addChoices({ name: 'merge', value: 'merge' }, { name: 'replace', value: 'replace' })
    ),

  new SlashCommandBuilder().setName('reset').setDescription('⚠️ Borra lista + historial'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, GUILD_ID), { body: commands });
console.log('✅ Comandos registrados para este servidor');

/* ======================
   CLIENT (RESPONDE A MENCIONES)
====================== */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.polls = new Map();

// ✅ Evento correcto en discord.js v14+
client.once('clientReady', () => {
  console.log(`🤖 Don Pistacho conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  // Ignorar bots
  if (message.author.bot) return;

  // Si mencionan al bot
  if (message.mentions.has(client.user)) {
    const frases = [
      '🫒 ¿No tendrás 50 eurillos para mangarte?',
      '🎃 ¿Te gustan de terror? Se te acabó el pienso y son las 3 AM.',
      '🍿 A ver si aprendemos a decidirnos, que no sois los que tenéis 7 vidas. Elige ya, lenteja.',
      '🐟 ¿Y si te pones una peli y dejas el atún sin supervisión? Pregunto por... un amigo.',
      '🎬 ¿Otra peli? A este ritmo vas a oler más a sofá que yo Pardolín.',
    ];

    const frase = frases[Math.floor(Math.random() * frases.length)];

    // ✅ Responder mencionando a la persona
    await message.reply({
      content: `${message.author} ${frase}`,
      allowedMentions: { repliedUser: true },
    });
  }
});



/* ======================
   SAFE REPLY (evita 40060)
====================== */
async function safeReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}
async function safeEdit(interaction, payload) {
  if (interaction.deferred) return interaction.editReply(payload);
  return safeReply(interaction, payload);
}

/* ======================
   INTERACTIONS
====================== */
client.on('interactionCreate', async (interaction) => {
  try {
    // ---- BOTONES votación ----
    if (interaction.isButton()) {
      const [prefix, pollId, opt] = interaction.customId.split(':');
      if (prefix !== 'vote') return;

      const poll = client.polls.get(pollId);
      if (!poll || poll.closed) {
        return await safeReply(interaction, { content: '⏱️ Esta votación ya terminó.', ephemeral: true });
      }

      poll.userVotes.set(interaction.user.id, opt);

      const counts = {};
      for (let i = 1; i <= poll.movies.length; i++) counts[String(i)] = 0;
      for (const v of poll.userVotes.values()) counts[v]++;

      const lines = poll.movies.map((m, idx) => {
        const k = String(idx + 1);
        return `**${k}.** ${formatMovieLine(m)} — 🗳️ **${counts[k]}**`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setTitle('🗳️ Votación de peli')
        .setDescription(lines)
        .setFooter({ text: 'Vota con botones (puedes cambiar tu voto).' });

      return await interaction.update({ embeds: [embed] });
    }

    if (!interaction.isChatInputCommand()) return;

    // /help
    if (interaction.commandName === 'help') {
      const adminNote = ADMIN_ROLE_SET.size
        ? '🔒 Roles admin configurados (solo admin puede /add /remove /visto /import /reset)'
        : '🔓 Sin roles admin: cualquiera puede usar comandos';

      return await safeReply(interaction, {
        content:
          `🐱🎩 **Don Pistacho — comandos**\n` +
          `• /add titulo|imdb\n` +
          `• /remove titulo\n` +
          `• /list\n` +
          `• /visto titulo\n` +
          `• /quevemos\n` +
          `• /votar (titulos o opciones)\n` +
          `• /stats\n` +
          `• /export (json/csv)\n` +
          `• /import archivo (merge/replace)\n` +
          `• /movie titulo|imdb\n\n` +
          `${adminNote}`
      });
    }

    // /ping
    if (interaction.commandName === 'ping') {
      return await safeReply(interaction, { content: 'pong 🏓' });
    }

    // /movie (también acepta IMDb)
    if (interaction.commandName === 'movie') {
      const titulo = interaction.options.getString('titulo', true);
      await interaction.deferReply();

      const m = await tmdbResolveMovie(titulo);
      if (!m) return await safeEdit(interaction, { content: '❌ No encontré esa peli (ni por título ni por IMDb)' });

      const year = (m.release_date || '').slice(0, 4) || '—';
      const embed = new EmbedBuilder()
        .setTitle(`${m.title} (${year})`)
        .setDescription(m.overview || 'Sin descripción')
        .addFields({ name: 'TMDB', value: `${(m.vote_average ?? 0).toFixed(1)} • ${m.vote_count ?? 0} votos`, inline: true });

      return await safeEdit(interaction, { embeds: [embed] });
    }

    // /add (título o IMDb)
    if (interaction.commandName === 'add') {
      if (ADMIN_ROLE_SET.size && !isAdmin(interaction)) {
        return await safeReply(interaction, { content: '🔒 No tienes permiso para /add', ephemeral: true });
      }

      const titulo = interaction.options.getString('titulo', true);
      await interaction.deferReply();

      const m = await tmdbResolveMovie(titulo);
      if (!m) return await safeEdit(interaction, { content: '❌ No encontré esa peli (ni por título ni por IMDb)' });

      const year = (m.release_date || '').slice(0, 4) || '';

      try {
        db.prepare(`
          INSERT INTO movies (tmdb_id, title, year, status, added_by)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(m.id, m.title, year, interaction.user.id);

        const imdbId = extractImdbId(titulo);
        const via = imdbId ? ` (vía IMDb: ${imdbId})` : '';
        return await safeEdit(interaction, { content: `🎬 Añadida: **${formatMovieLine({ title: m.title, year })}**${via}` });
      } catch {
        return await safeEdit(interaction, { content: `⚠️ Ya estaba en la lista: **${formatMovieLine({ title: m.title, year })}**` });
      }
    }

    // /remove (seguro: si hay varias coincidencias, no borra)
    if (interaction.commandName === 'remove') {
      if (ADMIN_ROLE_SET.size && !isAdmin(interaction)) {
        return await safeReply(interaction, { content: '🔒 No tienes permiso para /remove', ephemeral: true });
      }

      const q = interaction.options.getString('titulo', true).trim();

      const matches = db.prepare(`
        SELECT id, title, year, status
        FROM movies
        WHERE title LIKE ?
        ORDER BY status ASC, id DESC
        LIMIT 10
      `).all(`%${q}%`);

      if (matches.length === 0) return await safeReply(interaction, { content: '❌ No encontré ninguna peli que coincida.' });

      if (matches.length > 1) {
        const list = matches.map(m => `• ${m.title}${m.year ? ` (${m.year})` : ''} — ${m.status}`).join('\n');
        return await safeReply(interaction, { content: `⚠️ Encontré **${matches.length}** coincidencias. Escribe algo más específico:\n\n${list}` });
      }

      db.prepare(`DELETE FROM movies WHERE id=?`).run(matches[0].id);
      return await safeReply(interaction, { content: `🗑️ Eliminada: **${formatMovieLine(matches[0])}**` });
    }

    // /list
    if (interaction.commandName === 'list') {
      const rows = db.prepare(`
        SELECT title, year FROM movies
        WHERE status='pending'
        ORDER BY added_at DESC
        LIMIT ?
      `).all(LIST_LIMIT);

      if (!rows.length) return await safeReply(interaction, { content: '🍿 No hay pelis pendientes' });

      const text = rows.map(r => `• ${formatMovieLine(r)}`).join('\n');
      return await safeReply(interaction, { content: `🎞️ **Pendientes (máx ${LIST_LIMIT}):**\n${text}` });
    }

    // /visto
    if (interaction.commandName === 'visto') {
      if (ADMIN_ROLE_SET.size && !isAdmin(interaction)) {
        return await safeReply(interaction, { content: '🔒 No tienes permiso para /visto', ephemeral: true });
      }

      const titulo = interaction.options.getString('titulo', true);

      const m = db.prepare(`
        SELECT id, title, year
        FROM movies
        WHERE status='pending' AND title LIKE ?
        ORDER BY added_at DESC
        LIMIT 1
      `).get(`%${titulo}%`);

      if (!m) return await safeReply(interaction, { content: '❌ No encontré ninguna pendiente que coincida' });

      db.prepare(`
        UPDATE movies
        SET status='watched', watched_at=datetime('now'), watched_by=?
        WHERE id=?
      `).run(interaction.user.id, m.id);

      return await safeReply(interaction, { content: `✅ Vista: **${formatMovieLine(m)}**` });
    }

    // /quevemos
    if (interaction.commandName === 'quevemos') {
      const pendingCount = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='pending'`).get().c;
      if (pendingCount === 0) return await safeReply(interaction, { content: '🍿 No hay pelis pendientes. Usa /add' });

      const [pick] = pickMoviesSmart(1);
      if (!pick) return await safeReply(interaction, { content: '🍿 No encontré opciones' });

      markSuggested([pick.tmdb_id]);

      const embed = new EmbedBuilder()
        .setTitle('🎬 Hoy vemos…')
        .setDescription(`**${formatMovieLine(pick)}**`)
        .setFooter({ text: 'Anti-repetición ON • /quevemos para otra opción' });

      return await safeReply(interaction, { embeds: [embed] });
    }

    // /votar (titulos/IMDb o desde lista)
    if (interaction.commandName === 'votar') {
      await interaction.deferReply(); // evita “la aplicación no ha respondido”

      const rawTitles = interaction.options.getString('titulos', false);
      const optsRaw = interaction.options.getInteger('opciones') ?? VOTE_OPTIONS_DEFAULT;
      const n = Math.max(3, Math.min(5, optsRaw));

      let picked = [];
      let source = 'db';

      if (rawTitles && rawTitles.trim().length > 0) {
        source = 'manual';
        const items = parseTitlesList(rawTitles);

        if (items.length < 2) {
          return await safeEdit(interaction, { content: '🍿 Pon al menos 2 títulos/links separados por comas o ;' });
        }

        // Resolver cada item (título o IMDb)
        for (const it of items) {
          const m = await tmdbResolveMovie(it);
          if (!m) continue;
          picked.push({
            tmdb_id: m.id,
            title: m.title,
            year: (m.release_date || '').slice(0, 4) || '',
          });
        }

        // quitar duplicados por tmdb_id
        const seen = new Set();
        picked = picked.filter(x => (seen.has(x.tmdb_id) ? false : (seen.add(x.tmdb_id), true)));

        if (picked.length < 2) {
          return await safeEdit(interaction, { content: '❌ No pude encontrar al menos 2 pelis en TMDB con esos títulos/IMDb.' });
        }

        picked = picked.slice(0, 5);
        savePollHistory(picked, 'manual');
      } else {
        const pendingCount = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='pending'`).get().c;
        if (pendingCount < 2) return await safeEdit(interaction, { content: '🍿 Necesito al menos 2 pelis pendientes para votar.' });

        picked = pickMoviesSmart(Math.min(n, pendingCount));
        if (!picked.length) return await safeEdit(interaction, { content: '🍿 No hay pelis pendientes.' });

        savePollHistory(picked, 'db');
        markSuggested(picked.map(x => x.tmdb_id));
      }

      const pollId = `${interaction.channelId}-${Date.now()}`;
      const poll = { id: pollId, movies: picked, userVotes: new Map(), closed: false };
      client.polls.set(pollId, poll);

      const embed = new EmbedBuilder()
        .setTitle('🗳️ Votación de peli')
        .setDescription(picked.map((m, i) => `**${i + 1}.** ${formatMovieLine(m)} — 🗳️ **0**`).join('\n'))
        .setFooter({ text: `Dura ${Math.round(VOTE_DURATION_MS / 1000)}s • Puedes cambiar tu voto` });

      const row = new ActionRowBuilder().addComponents(
        ...picked.map((_, i) =>
          new ButtonBuilder()
            .setCustomId(`vote:${pollId}:${i + 1}`)
            .setLabel(String(i + 1))
            .setStyle(ButtonStyle.Primary)
        )
      );

      const msg = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });

      setTimeout(async () => {
        const p = client.polls.get(pollId);
        if (!p || p.closed) return;
        p.closed = true;

        const counts = {};
        for (let i = 1; i <= p.movies.length; i++) counts[String(i)] = 0;
        for (const v of p.userVotes.values()) counts[v]++;

        let best = '1';
        for (let i = 2; i <= p.movies.length; i++) {
          const k = String(i);
          if (counts[k] > counts[best]) best = k;
        }
        const winner = p.movies[Number(best) - 1];

        const finalLines = p.movies.map((m, i) => {
          const k = String(i + 1);
          return `**${k}.** ${formatMovieLine(m)} — 🗳️ **${counts[k]}**`;
        }).join('\n');

        const finalEmbed = new EmbedBuilder()
          .setTitle('🗳️ Votación cerrada')
          .setDescription(finalLines)
          .addFields({ name: '🎬 Ganadora', value: `**${formatMovieLine(winner)}**` });

        const disabledRow = new ActionRowBuilder().addComponents(
          row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
        );

        try { await msg.edit({ embeds: [finalEmbed], components: [disabledRow] }); } catch {}
      }, VOTE_DURATION_MS);

      return;
    }

    // /stats
    if (interaction.commandName === 'stats') {
      const total = db.prepare(`SELECT COUNT(*) AS c FROM movies`).get().c;
      const pending = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='pending'`).get().c;
      const watched = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='watched'`).get().c;

      const topAdd = db.prepare(`
        SELECT added_by AS user_id, COUNT(*) AS c
        FROM movies
        WHERE added_by IS NOT NULL AND added_by <> ''
        GROUP BY added_by
        ORDER BY c DESC
        LIMIT 5
      `).all();

      const topWatched = db.prepare(`
        SELECT watched_by AS user_id, COUNT(*) AS c
        FROM movies
        WHERE watched_by IS NOT NULL AND watched_by <> ''
        GROUP BY watched_by
        ORDER BY c DESC
        LIMIT 5
      `).all();

      const fmtTop = (arr) => arr.length
        ? arr.map((r, i) => `${i + 1}. <@${r.user_id}> — **${r.c}**`).join('\n')
        : '—';

      const embed = new EmbedBuilder()
        .setTitle('📊 Stats — Don Pistacho')
        .addFields(
          { name: '🎞️ Total', value: String(total), inline: true },
          { name: '🍿 Pendientes', value: String(pending), inline: true },
          { name: '✅ Vistas', value: String(watched), inline: true },
          { name: '🏆 Top “añade pelis”', value: fmtTop(topAdd), inline: false },
          { name: '🏅 Top “marca vistas”', value: fmtTop(topWatched), inline: false },
        )
        .setFooter({ text: 'Tip: /add acepta links IMDb' });

      return await safeReply(interaction, { embeds: [embed] });
    }

    // /export
    if (interaction.commandName === 'export') {
      const fmt = interaction.options.getString('formato') || 'json';

      const rows = db.prepare(`
        SELECT tmdb_id, title, year, status, added_at, added_by, watched_at, watched_by
        FROM movies
        ORDER BY id ASC
      `).all();

      if (rows.length === 0) return await safeReply(interaction, { content: '📦 No hay datos para exportar.' });

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const outName = `don-pistacho-export-${stamp}.${fmt}`;
      const outPath = path.join(process.cwd(), outName);

      if (fmt === 'csv') {
        const header = 'tmdb_id,title,year,status,added_at,added_by,watched_at,watched_by\n';
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const body = rows.map(r =>
          [r.tmdb_id, r.title, r.year, r.status, r.added_at, r.added_by, r.watched_at, r.watched_by].map(esc).join(',')
        ).join('\n');
        fs.writeFileSync(outPath, header + body, 'utf8');
      } else {
        fs.writeFileSync(outPath, JSON.stringify({ exported_at: new Date().toISOString(), movies: rows }, null, 2), 'utf8');
      }

      const file = new AttachmentBuilder(outPath);
      await safeReply(interaction, { content: '📦 Backup listo:', files: [file] });

      try { fs.unlinkSync(outPath); } catch {}
      return;
    }

    // /import
    if (interaction.commandName === 'import') {
      if (ADMIN_ROLE_SET.size && !isAdmin(interaction)) {
        return await safeReply(interaction, { content: '🔒 No tienes permiso para /import', ephemeral: true });
      }

      const att = interaction.options.getAttachment('archivo', true);
      const mode = interaction.options.getString('modo') || 'merge';

      await interaction.deferReply({ ephemeral: true });

      const resp = await axios.get(att.url, { responseType: 'text' });
      const text = resp.data;

      if (mode === 'replace') {
        db.prepare(`DELETE FROM poll_history_items`).run();
        db.prepare(`DELETE FROM poll_history`).run();
        db.prepare(`DELETE FROM movies`).run();
      }

      let imported = 0;
      let skipped = 0;

      function upsertMovie(row) {
        try {
          db.prepare(`
            INSERT INTO movies (tmdb_id, title, year, status, added_at, added_by, watched_at, watched_by)
            VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)
          `).run(
            Number(row.tmdb_id),
            String(row.title),
            String(row.year ?? ''),
            String(row.status ?? 'pending'),
            row.added_at ?? null,
            row.added_by ?? null,
            row.watched_at ?? null,
            row.watched_by ?? null
          );
          imported++;
        } catch {
          skipped++;
        }
      }

      if (att.name.toLowerCase().endsWith('.csv')) {
        const lines = text.split(/\r?\n/).filter(Boolean);
        lines.shift(); // header

        for (const line of lines) {
          const cols = [];
          let cur = '';
          let inQ = false;

          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"' && line[i + 1] === '"' && inQ) { cur += '"'; i++; continue; }
            if (ch === '"') { inQ = !inQ; continue; }
            if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
            cur += ch;
          }
          cols.push(cur);

          const [tmdb_id, title, year, status, added_at, added_by, watched_at, watched_by] = cols;
          upsertMovie({ tmdb_id, title, year, status, added_at, added_by, watched_at, watched_by });
        }
      } else {
        let obj;
        try { obj = JSON.parse(text); } catch { return await safeEdit(interaction, { content: '❌ JSON inválido.' }); }
        const movies = obj.movies || obj;
        if (!Array.isArray(movies)) return await safeEdit(interaction, { content: '❌ JSON no contiene una lista de movies.' });

        for (const m of movies) upsertMovie(m);
      }

      return await safeEdit(interaction, { content: `✅ Import terminado. Añadidas: ${imported} • Duplicadas/omitidas: ${skipped}` });
    }

    // /reset
    if (interaction.commandName === 'reset') {
      if (ADMIN_ROLE_SET.size && !isAdmin(interaction)) {
        return await safeReply(interaction, { content: '🔒 No tienes permiso para /reset', ephemeral: true });
      }

      db.prepare(`DELETE FROM poll_history_items`).run();
      db.prepare(`DELETE FROM poll_history`).run();
      db.prepare(`DELETE FROM movies`).run();
      return await safeReply(interaction, { content: '🧨 Lista borrada (incluye historial).' });
    }

  } catch (err) {
    console.error(err);

    // Evita 40060 SIEMPRE
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ Algo falló. Mira la consola.', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ Algo falló. Mira la consola.', ephemeral: true });
      }
    } catch {}
  }
});

// ======================
// HTTP SERVER (GPT + Railway)
// ======================
const app = express();
app.use(express.json());

// Mini “API key” opcional.
// Si NO configuras GPT_API_KEY en Railway, no se exige nada.
const { GPT_API_KEY, GPT_CHANNEL_ID } = process.env;

function requireKey(req, res) {
  if (!GPT_API_KEY) return true;
  const key = req.headers['x-api-key'];
  if (key && key === GPT_API_KEY) return true;
  res.status(401).json({ ok: false, error: 'Unauthorized (missing/invalid x-api-key)' });
  return false;
}

// Home
app.get('/', (req, res) => res.status(200).send('Don Pistacho OK ✅'));

// Salud
app.get('/health', (req, res) =>
  res.status(200).json({ ok: true, bot: 'Don Pistacho', status: 'online' })
);

// ======================
// GPT ENDPOINTS
// ======================

// LIST: GET /gpt/list?limit=...
app.get('/gpt/list', (req, res) => {
  if (!requireKey(req, res)) return;

  const limit = Math.max(1, Math.min(300, Number(req.query.limit ?? LIST_LIMIT)));
  const rows = db.prepare(`
    SELECT title, year
    FROM movies
    WHERE status='pending'
    ORDER BY added_at DESC
    LIMIT ?
  `).all(limit);

  res.status(200).json({
    ok: true,
    count: rows.length,
    limit,
    movies: rows.map(r => ({ title: r.title, year: r.year || '' })),
  });
});

// ADD: POST /gpt/add  { titulo: "..." }
app.post('/gpt/add', async (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const titulo = String(req.body?.titulo ?? '').trim();
    if (!titulo) return res.status(400).json({ ok: false, error: 'Missing "titulo"' });

    const m = await tmdbResolveMovie(titulo);
    if (!m) return res.status(404).json({ ok: false, error: 'TMDB: not found' });

    const year = (m.release_date || '').slice(0, 4) || '';

    try {
      db.prepare(`
        INSERT INTO movies (tmdb_id, title, year, status, added_by)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(m.id, m.title, year, 'gpt');

      const imdbId = extractImdbId(titulo);
      return res.status(200).json({
        ok: true,
        added: { tmdb_id: m.id, title: m.title, year },
        info: imdbId ? `via IMDb: ${imdbId}` : 'added',
      });
    } catch {
      return res.status(200).json({
        ok: true,
        existing: { tmdb_id: m.id, title: m.title, year },
        info: 'already_in_list',
      });
    }
  } catch (e) {
    console.error('POST /gpt/add error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// REMOVE: POST /gpt/remove  { titulo: "..." }
app.post('/gpt/remove', (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const titulo = String(req.body?.titulo ?? '').trim();
    if (!titulo) return res.status(400).json({ ok: false, error: 'Missing "titulo"' });

    const matches = db.prepare(`
      SELECT id, title, year, status
      FROM movies
      WHERE title LIKE ?
      ORDER BY status ASC, id DESC
      LIMIT 10
    `).all(`%${titulo}%`);

    if (matches.length === 0) return res.status(200).json({ ok: false, error: 'not_found' });

    if (matches.length > 1) {
      return res.status(200).json({
        ok: false,
        error: 'multiple_matches',
        matches: matches.map(m => ({
          id: m.id,
          title: m.title,
          year: m.year || '',
          status: m.status,
        })),
      });
    }

    const one = matches[0];
    db.prepare(`DELETE FROM movies WHERE id=?`).run(one.id);

    return res.status(200).json({
      ok: true,
      removed: { id: one.id, title: one.title, year: one.year || '', status: one.status },
    });
  } catch (e) {
    console.error('POST /gpt/remove error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// VISTO: POST /gpt/visto  { titulo: "..." }
app.post('/gpt/visto', (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const titulo = String(req.body?.titulo ?? '').trim();
    if (!titulo) return res.status(400).json({ ok: false, error: 'Missing "titulo"' });

    const m = db.prepare(`
      SELECT id, title, year
      FROM movies
      WHERE status='pending' AND title LIKE ?
      ORDER BY added_at DESC
      LIMIT 1
    `).get(`%${titulo}%`);

    if (!m) return res.status(200).json({ ok: false, error: 'not_found' });

    db.prepare(`
      UPDATE movies
      SET status='watched', watched_at=datetime('now'), watched_by=?
      WHERE id=?
    `).run('gpt', m.id);

    return res.status(200).json({
      ok: true,
      watched: { id: m.id, title: m.title, year: m.year || '' },
    });
  } catch (e) {
    console.error('POST /gpt/visto error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// QUEVEMOS: POST /gpt/quevemos
app.post('/gpt/quevemos', (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const pendingCount = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='pending'`).get().c;
    if (pendingCount === 0) return res.status(200).json({ ok: false, error: 'no_pending' });

    const [pick] = pickMoviesSmart(1);
    if (!pick) return res.status(200).json({ ok: false, error: 'no_pick' });

    markSuggested([pick.tmdb_id]);

    return res.status(200).json({
      ok: true,
      pick: { tmdb_id: pick.tmdb_id, title: pick.title, year: pick.year || '' },
    });
  } catch (e) {
    console.error('POST /gpt/quevemos error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// VOTAR: POST /gpt/votar  { titulos: ["...","..."], duration_ms?: 600000 }
app.post('/gpt/votar', async (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const titulos = Array.isArray(req.body?.titulos) ? req.body.titulos : [];
    if (titulos.length < 2) return res.status(400).json({ ok: false, error: 'Need at least 2 titles' });

    const durationMs = Math.max(30_000, Number(req.body?.duration_ms ?? VOTE_DURATION_MS));
    const items = titulos.slice(0, 5);

    // Resuelve títulos/IMDb -> TMDB
    let picked = [];
    for (const it of items) {
      const m = await tmdbResolveMovie(String(it));
      if (!m) continue;
      picked.push({
        tmdb_id: m.id,
        title: m.title,
        year: (m.release_date || '').slice(0, 4) || '',
      });
    }

    // Quita duplicados
    const seen = new Set();
    picked = picked.filter(x => (seen.has(x.tmdb_id) ? false : (seen.add(x.tmdb_id), true)));

    if (picked.length < 2) return res.status(200).json({ ok: false, error: 'tmdb_not_enough_results' });

    // Si no hay canal configurado, solo devuelve la selección (igual sirve para GPT)
    if (!GPT_CHANNEL_ID) {
      return res.status(200).json({
        ok: true,
        poll: { count: picked.length, titles: picked.map(m => formatMovieLine(m)) },
      });
    }

    // Enviar votación al canal
    const channel = await client.channels.fetch(GPT_CHANNEL_ID).catch(() => null);
    if (!channel) {
      return res.status(200).json({ ok: false, error: 'invalid_GPT_CHANNEL_ID' });
    }

    const pollId = `${GPT_CHANNEL_ID}-${Date.now()}`;
    const poll = { id: pollId, movies: picked, userVotes: new Map(), closed: false };
    client.polls.set(pollId, poll);

    const embed = new EmbedBuilder()
      .setTitle('🗳️ Votación de peli (lanzada por GPT)')
      .setDescription(picked.map((m, i) => `**${i + 1}.** ${formatMovieLine(m)} — 🗳️ **0**`).join('\n'))
      .setFooter({ text: `Dura ${Math.round(durationMs / 1000)}s • Puedes cambiar tu voto` });

    const row = new ActionRowBuilder().addComponents(
      ...picked.map((_, i) =>
        new ButtonBuilder()
          .setCustomId(`vote:${pollId}:${i + 1}`)
          .setLabel(String(i + 1))
          .setStyle(ButtonStyle.Primary)
      )
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    setTimeout(async () => {
      const p = client.polls.get(pollId);
      if (!p || p.closed) return;
      p.closed = true;

      const counts = {};
      for (let i = 1; i <= p.movies.length; i++) counts[String(i)] = 0;
      for (const v of p.userVotes.values()) counts[v]++;

      let best = '1';
      for (let i = 2; i <= p.movies.length; i++) {
        const k = String(i);
        if (counts[k] > counts[best]) best = k;
      }
      const winner = p.movies[Number(best) - 1];

      const finalLines = p.movies.map((m, i) => {
        const k = String(i + 1);
        return `**${k}.** ${formatMovieLine(m)} — 🗳️ **${counts[k]}**`;
      }).join('\n');

      const finalEmbed = new EmbedBuilder()
        .setTitle('🗳️ Votación cerrada')
        .setDescription(finalLines)
        .addFields({ name: '🎬 Ganadora', value: `**${formatMovieLine(winner)}**` });

      const disabledRow = new ActionRowBuilder().addComponents(
        row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
      );

      try { await msg.edit({ embeds: [finalEmbed], components: [disabledRow] }); } catch {}
    }, durationMs);

    return res.status(200).json({
      ok: true,
      poll: { count: picked.length, titles: picked.map(m => formatMovieLine(m)) },
    });
  } catch (e) {
    console.error('POST /gpt/votar error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// STATS: GET /gpt/stats
app.get('/gpt/stats', (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM movies`).get().c;
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='pending'`).get().c;
    const watched = db.prepare(`SELECT COUNT(*) AS c FROM movies WHERE status='watched'`).get().c;

    return res.status(200).json({ ok: true, total, pending, watched });
  } catch (e) {
    console.error('GET /gpt/stats error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Railway: escucha el PORT que te da Railway (si no, 8080)
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 HTTP server listening on ${PORT}`));
// DECIR: POST /gpt/decir  { mensaje: "..." }
app.post('/gpt/decir', async (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const mensaje = String(req.body?.mensaje ?? '').trim();
    if (!mensaje) return res.status(400).json({ ok: false, error: 'Missing "mensaje"' });

    if (!GPT_CHANNEL_ID) {
      return res.status(400).json({ ok: false, error: 'GPT_CHANNEL_ID not set' });
    }

    const canal = await client.channels.fetch(GPT_CHANNEL_ID).catch(() => null);
    if (!canal || !canal.send) {
      return res.status(500).json({ ok: false, error: 'Channel fetch/send failed' });
    }

    await canal.send(mensaje);

    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    console.error('POST /gpt/decir error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// =======================
// DISCORD LOGIN
// =======================
client.login(DISCORD_TOKEN);
