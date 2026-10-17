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
