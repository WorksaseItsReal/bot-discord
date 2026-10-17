'use strict';

/**
 * Revue n° 6 — lot « cœur » : régressions (passerelle, purge des serveurs quittés,
 * scheduler, événements, interactions, arrêt).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { _resetFatalState, setShutdownHook } = require('../src/core/errors');
const { snapshot } = require('../src/core/healthServer');

// ---------- R1 : fermeture définitive de la passerelle ----------

test('R1 : shardDisconnect (4004/4011/4014, non récupérable) → arrêt propre puis exit(1)', async () => {
  _resetFatalState();
  const events = require('../src/events/clientEvents');
  const handler = events.find((e) => e.name === 'shardDisconnect');
  const order = [];
  setShutdownHook(async () => order.push('shutdown'));
  const realExit = process.exit;
  process.exit = (code) => order.push(`exit:${code}`);
  try {
    await handler.execute({}, { code: 4004 }, 0);
  } finally {
    process.exit = realExit;
    _resetFatalState();
  }
  assert.deepEqual(order, ['shutdown', 'exit:1']);
});

test('R1 : /healthz « unavailable » si une shard n\'est plus connectée (isReady() figé à vrai)', () => {
  const shards = new Map([[0, { status: 5 }]]); // Status.Disconnected
  const client = {
    isReady: () => true,
    ws: { ping: 40, shards },
    guilds: { cache: { size: 1 } },
    uptime: 1000,
    database: { db: { prepare: () => ({ get: () => 1 }) } },
  };
  assert.equal(snapshot(client).ready, false);
  assert.equal(snapshot(client).status, 'unavailable');
  shards.set(0, { status: 0 }); // Status.Ready
  assert.equal(snapshot(client).status, 'ok');
});

// ---------- R2 / R3 / R98 / R99 : purge des serveurs quittés ----------

const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { SchedulerService, LEFT_GUILD_RETENTION_MS } = require('../src/services/SchedulerService');

const G = '100000000000000001';
const OTHER = '100000000000000002';

/** Tables de la base (hors tables internes de SQLite). */
function allTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' ORDER BY name").all().map((r) => r.name);
}
const columnsOf = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all();
const hasGuildId = (db, t) => columnsOf(db, t).some((c) => c.name === 'guild_id');

/**
 * Une ligne dans CHAQUE table pour le serveur n° n (1 ou 2) : tous les entiers valent n (ids,
 * clés étrangères comprises), les textes « colonne-n ». Parents d'abord (clés étrangères).
 */
function seedEveryTable(db, guildId, n) {
  const tables = allTables(db);
  const fk = (t) => db.prepare(`PRAGMA foreign_key_list("${t}")`).all().length > 0;
  for (const t of [...tables.filter((x) => !fk(x)), ...tables.filter(fk)]) {
    const cols = columnsOf(db, t);
    const values = cols.map((c) => {
      if (c.name === 'guild_id') return guildId;
      if (/INT|REAL|NUM/i.test(c.type)) return n;
      return `${c.name}-${n}`;
    });
    db.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
  }
}

function leftGuildWorld() {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const config = new ConfigService(repo);
  seedEveryTable(db, G, 1);
  seedEveryTable(db, OTHER, 2);
  config.update(G, { locale: 'fr' });
  config.update(OTHER, { locale: 'fr' });
  return { db, repo, config };
}

test('R2 : 30 jours après le départ, TOUTES les tables à guild_id (et leurs filles) sont purgées ; les autres serveurs intacts', async () => {
  const { GuildPurgeRepository } = require('../src/database/repositories/GuildPurgeRepository');
  const { db, repo, config } = leftGuildWorld();
  config.markLeft(G, Date.now() - LEFT_GUILD_RETENTION_MS - 60_000);
  const forgotten = [];
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[OTHER, { id: OTHER, available: true }]]) },
    repositories: { guildConfig: repo, guildPurge: new GuildPurgeRepository(db) },
    services: { config, afk: { forgetGuild: (id) => forgotten.push(['afk', id]) }, highlights: { forgetGuild: (id) => forgotten.push(['highlights', id]) } },
  };
  await new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } }).tick();

  const kept = allTables(db).filter((t) => hasGuildId(db, t)).filter((t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE guild_id = ?`).get(G).n > 0);
  assert.deepEqual(kept, [], `lignes du serveur quitté conservées : ${kept.join(', ')}`);
  const lost = allTables(db).filter((t) => hasGuildId(db, t)).filter((t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE guild_id = ?`).get(OTHER).n === 0);
  assert.deepEqual(lost, [], `lignes d'un AUTRE serveur supprimées : ${lost.join(', ')}`);
  // Tables filles (sans guild_id) : celles du serveur quitté (id 1) supprimées, celles de l'autre (id 2) gardées.
  for (const [table, column] of [['giveaway_entries', 'giveaway_id'], ['giveaway_winners', 'giveaway_id'], ['suggestion_votes', 'suggestion_id'], ['feed_items', 'feed_id'], ['project_members', 'project_id'], ['project_tasks', 'project_id']]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 1`).get().n, 0, `${table} du serveur quitté`);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 2`).get().n, 1, `${table} de l'autre serveur`);
  }
  // Rappel de l'utilisateur : détaché du serveur (plus de salon), toujours livré en MP.
  assert.deepEqual(db.prepare('SELECT guild_id, channel_id FROM reminders WHERE id = 1').get(), { guild_id: null, channel_id: null });
  // Caches mémoire des services vidés.
  assert.deepEqual(forgotten, [['afk', G], ['highlights', G]]);
});

test('R2 : toute table sans guild_id est une table fille classée (sinon elle échapperait à la purge)', () => {
  const { CHILD_TABLES, GLOBAL_TABLES } = require('../src/database/repositories/GuildPurgeRepository');
  const { db } = memoryDb();
  const known = new Set([...CHILD_TABLES.map(([t]) => t), ...GLOBAL_TABLES]);
  const orphans = allTables(db).filter((t) => !hasGuildId(db, t) && !known.has(t));
  assert.deepEqual(orphans, [], 'classez la table dans CHILD_TABLES (GuildPurgeRepository) ou GLOBAL_TABLES');
});

test('R2 : départ daté même sans configuration (ou configuration corrompue)', () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const config = new ConfigService(repo);
  const client = { services: { config } };
  require('../src/events/guildDelete').execute(client, { id: G, name: 'Sans config' });
  assert.equal(typeof repo.get(G)?._leftAt, 'number', 'serveur sans config : départ non daté, jamais purgé');
  db.prepare('INSERT INTO guild_config (guild_id, data, updated_at) VALUES (?, ?, ?)').run(OTHER, '{abîmé', Date.now());
  require('../src/events/guildDelete').execute(client, { id: OTHER, name: 'Config corrompue' });
  assert.equal(repo.findLeftBefore(Date.now() + 1).includes(OTHER), true, 'config corrompue : départ non daté');
});

test('R3 : serveur quitté pendant un arrêt du bot → départ daté au démarrage (si aucun serveur indisponible)', async () => {
  const { GuildPurgeRepository } = require('../src/database/repositories/GuildPurgeRepository');
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const config = new ConfigService(repo);
  const HERE = '100000000000000003';
  config.update(HERE, { locale: 'fr' });
  // Le serveur fantôme n'a qu'une sanction (aucune config) ; un autre a une config datée mais le bot y est revenu hors ligne.
  db.prepare("INSERT INTO sanctions (guild_id, user_id, moderator_id, type, active, created_at) VALUES (?, 'u', 'm', 'warn', 1, ?)").run(G, Date.now());
  config.update(OTHER, { locale: 'fr' });
  config.markLeft(OTHER, Date.now() - 5 * 86_400_000);
  const outage = { id: HERE, available: false };
  const cache = new Map([[HERE, outage], [OTHER, { id: OTHER, available: true }]]);
  const client = { isReady: () => true, guilds: { cache }, repositories: { guildConfig: repo, guildPurge: new GuildPurgeRepository(db) }, services: { config } };
  const scheduler = new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } });
  await scheduler.tick();
  assert.equal(repo.get(G)?._leftAt, undefined, 'un serveur indisponible : la liste n\'est pas sûre, rien n\'est daté');
  outage.available = true;
  await scheduler.tick();
  assert.equal(typeof repo.get(G)?._leftAt, 'number', 'serveur quitté hors ligne jamais daté');
  assert.equal(repo.get(HERE)?._leftAt, undefined);
  assert.equal(repo.get(OTHER)?._leftAt, undefined, 'bot revenu hors ligne : purge non annulée');
});

test('R98 : membre parti pendant un arrêt → absence et alertes effacées au rattrapage des départs', async () => {
  const { Collection, IntentsBitField } = require('discord.js');
  const { intents } = require('../src/config/intents');
  const { AfkRepository } = require('../src/database/repositories/AfkRepository');
  const { HighlightRepository } = require('../src/database/repositories/HighlightRepository');
  const { AfkService } = require('../src/services/AfkService');
  const { HighlightService } = require('../src/services/HighlightService');
  const departures = require('../src/events/departuresReconcile');
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const afkRepo = new AfkRepository(db);
  const hlRepo = new HighlightRepository(db);
  for (const u of ['A', 'D']) {
    afkRepo.set({ guildId: G, userId: u, reason: 'vacances' });
    hlRepo.save({ guildId: G, userId: u, words: ['mon prénom'] });
  }
  const guild = { id: G, available: true, memberCount: 1, members: { cache: new Collection([['A', {}]]), fetch: async () => {} } };
  const client = { options: { intents: new IntentsBitField(intents) }, guilds: { cache: new Collection([[G, guild]]) }, repositories: { afk: afkRepo, highlights: hlRepo }, services: {} };
  client.services.afk = new AfkService({ client, afk: afkRepo, config });
  client.services.highlights = new HighlightService({ client, highlights: hlRepo, config });
  assert.equal(client.services.afk.isAfk(G, 'D'), true);
  await departures.reconcileGuild(client, guild);
  assert.equal(afkRepo.get(G, 'D'), null, 'absence du membre parti conservée');
  assert.equal(hlRepo.get(G, 'D'), null, 'alertes du membre parti conservées');
  assert.equal(client.services.afk.isAfk(G, 'D'), false);
  assert.notEqual(afkRepo.get(G, 'A'), null, 'membre présent : absence conservée');
  assert.notEqual(hlRepo.get(G, 'A'), null);
});

test('R99 : clés étrangères vers sanctions indexées (mod_notes, sanction_edits)', () => {
  const { db } = memoryDb();
  for (const table of ['mod_notes', 'sanction_edits']) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE sanction_id = ?`).all(1).map((r) => r.detail).join(' | ');
    assert.match(plan, /SEARCH \S+ USING (COVERING )?INDEX \S+ \(sanction_id=\?\)/, `${table} : parcours complet (${plan})`);
  }
});

// ---------- R13 / R97 / R110 : échéances du scheduler ----------

const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');

const apiError = (code) => Object.assign(new Error(`api ${code}`), { code });

/** Serveur et scheduler pour des levées échues (tempban / mute). */
function expiryWorld({ type = 'tempban', count = 1, late = 1000, botPerms = null, botTop = 10, mutedPos = 1, unban, removeRole } = {}) {
  const { db } = memoryDb();
  const sanctions = new SanctionRepository(db);
  for (let i = 0; i < count; i++) sanctions.create({ guildId: G, userId: `u${i}`, moderatorId: 'm', type, expiresAt: Date.now() - late });
  const calls = { unban: 0, removeRole: 0 };
  const logs = [];
  const member = (id) => ({ id, user: { id }, toString: () => `<@${id}>`, roles: { cache: new Map([['muted', {}]]), remove: async () => { calls.removeRole += 1; return removeRole?.(); } } });
  const me = botPerms === null ? null : { permissions: new PermissionsBitField(botPerms), roles: { highest: { position: botTop } } };
  const guild = {
    id: G,
    available: true,
    bans: { remove: async () => { calls.unban += 1; return unban?.(); } },
    members: { me, fetch: async (id) => member(id) },
    roles: { cache: new Map([['muted', { id: 'muted', position: mutedPos }]]) },
  };
  const cache = new Map([[G, guild]]);
  const client = {
    user: { id: 'bot' },
    isReady: () => true,
    guilds: { cache },
    repositories: {},
    services: {
      config: { get: () => ({ moderation: { mutedRoleId: 'muted' } }) },
      logging: { send: async (...args) => { logs.push(args); return true; } },
    },
  };
  const scheduler = new SchedulerService({ client, sanctions, reminders: { findDue: () => [] } });
  return { sanctions, scheduler, calls, logs, guild, cache };
}

test('R13 : tempban échu sans « Bannir des membres » → aucun appel Discord (403 inutile), sanction gardée', async () => {
  const w = expiryWorld({ botPerms: PermissionFlagsBits.SendMessages });
  await w.scheduler.tick();
  assert.equal(w.calls.unban, 0, 'débannissement tenté sans la permission');
  assert.equal(w.sanctions.listActiveByType(G, 'tempban').length, 1);
});

test('R13 : mute échu, rôle Muted au-dessus du bot → aucun appel Discord, sanction gardée', async () => {
  const w = expiryWorld({ type: 'mute', botPerms: PermissionFlagsBits.ManageRoles, botTop: 1, mutedPos: 5 });
  await w.scheduler.tick();
  assert.equal(w.calls.removeRole, 0, 'retrait tenté malgré la hiérarchie');
  assert.equal(w.sanctions.listActiveByType(G, 'mute').length, 1);
});

test('R13 : levée en échec → nouvel essai différé (backoff), pas à chaque tick', async () => {
  const w = expiryWorld({ unban: () => { throw apiError(50013); } });
  await w.scheduler.tick();
  await w.scheduler.tick();
  await w.scheduler.tick();
  assert.equal(w.calls.unban, 1, `réessai toutes les 30 s : ${w.calls.unban} appels`);
  assert.equal(w.sanctions.listActiveByType(G, 'tempban').length, 1, 'sanction gardée pour un nouvel essai');
});

test('R13 : levées en échec plafonnées par passage', async () => {
  const w = expiryWorld({ count: 60, unban: () => { throw apiError(500); } });
  await w.scheduler.tick();
  assert.ok(w.calls.unban <= 25, `${w.calls.unban} appels en un passage`);
});

test('R13 : levée impossible depuis plus de 24 h → staff prévenu une seule fois (logs Modération)', async () => {
  const w = expiryWorld({ late: 25 * 3_600_000, unban: () => { throw apiError(50013); } });
  await w.scheduler.tick();
  w.scheduler.expiryRetries.clear(); // backoff écoulé
  await w.scheduler.tick();
  assert.equal(w.calls.unban, 2);
  assert.equal(w.logs.length, 1, `alertes : ${w.logs.length}`);
  assert.equal(w.logs[0][1], 'moderation');
  assert.match(JSON.stringify(w.logs[0][2].toJSON?.() ?? w.logs[0][2]), /24 h/);
  assert.equal(w.sanctions.listActiveByType(G, 'tempban').length, 1, 'toujours retentée (permission rétablie → levée)');
});

test('R97 : bot retiré puis réinvité → tempban et mute échus pendant l\'absence levés au retour', async () => {
  for (const type of ['tempban', 'mute']) {
    const w = expiryWorld({ type });
    const guild = w.cache.get(G);
    w.cache.delete(G); // le bot n'est plus sur le serveur
    await w.scheduler.tick();
    assert.equal(w.sanctions.listActiveByType(G, type).length, 1, `${type} clos sans action pendant l'absence`);
    w.cache.set(G, guild); // réinvité
    w.scheduler.expiryRetries?.clear();
    await w.scheduler.tick();
    assert.equal(type === 'tempban' ? w.calls.unban : w.calls.removeRole, 1, `${type} jamais levé au retour`);
    assert.equal(w.sanctions.listActiveByType(G, type).length, 0);
  }
});

test('R97 : /lock duree et rôle temporaire échus pendant l\'absence du bot → gardés actifs', async () => {
  const { TimedActionRepository } = require('../src/database/repositories/TimedActionRepository');
  const { TimedLockService } = require('../src/services/TimedLockService');
  const { TempRoleRepository } = require('../src/database/repositories/TempRoleRepository');
  const { TempRoleService } = require('../src/services/TempRoleService');
  const { db } = memoryDb();
  const client = { isReady: () => true, guilds: { cache: new Map() }, services: {}, repositories: {} };
  const timed = new TimedActionRepository(db);
  const lockId = timed.schedule({ guildId: G, channelId: 'c1', kind: 'lock', expiresAt: Date.now() - 1000 });
  await new TimedLockService({ client, timed }).processDue();
  assert.equal(timed.byId(lockId).active, 1, `lock clos « ${timed.byId(lockId).end_reason} » : salon verrouillé à vie au retour`);
  const tempRoles = new TempRoleRepository(db);
  const { id } = tempRoles.upsert({ guildId: G, userId: 'u1', roleId: 'r1', moderatorId: 'm', expiresAt: Date.now() - 1000 });
  await new TempRoleService({ client, tempRoles }).processDue();
  assert.equal(tempRoles.byId(id).active, 1, `rôle temporaire clos « ${tempRoles.byId(id).end_reason} » : gardé à vie au retour`);
});

test('R110 : un tirage de giveaway lent ne bloque pas le scheduler (débans, rappels) ; pas de double fin', async () => {
  let release;
  const ends = [];
  const client = {
    isReady: () => true,
    guilds: { cache: new Map() },
    repositories: { giveaways: { findDue: () => [{ id: 7, guild_id: G }] } },
    services: { giveaways: { end: (id) => { ends.push(id); return new Promise((r) => { release = r; }); } } },
  };
  let reminderPasses = 0;
  const scheduler = new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => { reminderPasses += 1; return []; } } });
  const first = scheduler.tick();
  const done = await Promise.race([first.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
  assert.equal(done, true, 'tick bloqué par le tirage du giveaway');
  await scheduler.tick();
  assert.equal(reminderPasses, 2, 'ticks suivants sautés');
  assert.deepEqual(ends, [7], 'giveaway en cours de tirage relancé');
  // L'arrêt attend le tirage en cours (écritures en base).
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopped, false, 'stop() n\'attend pas le tirage en cours');
  release();
  await stopping;
  assert.equal(stopped, true);
});
