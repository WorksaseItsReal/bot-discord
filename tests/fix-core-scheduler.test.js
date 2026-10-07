'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { ReminderRepository } = require('../src/database/repositories/ReminderRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { SchedulerService, LEFT_GUILD_RETENTION_MS } = require('../src/services/SchedulerService');

const apiError = (code) => Object.assign(new Error(`api ${code}`), { code });

// ---------- Mutes expirés ----------

function muteSetup({ fetchMember, removeRole, hasRole = true }) {
  const { db } = memoryDb();
  const sanctions = new SanctionRepository(db);
  sanctions.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'mute', expiresAt: Date.now() - 1 });
  const logs = [];
  const member = {
    user: { id: 'u1' },
    toString: () => '<@u1>',
    roles: { cache: new Map(hasRole ? [['muted', {}]] : []), remove: removeRole ?? (async () => {}) },
  };
  const guild = { id: 'g1', available: true, members: { fetch: fetchMember ?? (async () => member) } };
  const client = {
    user: { id: 'bot' },
    guilds: { cache: new Map([['g1', guild]]) },
    repositories: {},
    services: {
      config: { get: () => ({ moderation: { mutedRoleId: 'muted' } }) },
      logging: { send: async (...args) => { logs.push(args); return true; } },
    },
  };
  const scheduler = new SchedulerService({ client, sanctions, reminders: { findDue: () => [] } });
  return { sanctions, scheduler, logs };
}

test('mute expiré : rôle retiré → désactivé + log « revocation »', async () => {
  const { sanctions, scheduler, logs } = muteSetup({});
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'mute').length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], 'moderation');
  assert.deepEqual(logs[0][4], { event: 'revocation' });
});

test('mute expiré : échec du retrait → gardé actif, aucune carte « unmute »', async () => {
  const { sanctions, scheduler, logs } = muteSetup({ removeRole: async () => { throw apiError(50013); } });
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'mute').length, 1);
  assert.equal(logs.length, 0);
});

test('mute expiré : fetch du membre en erreur transitoire → gardé actif', async () => {
  const { sanctions, scheduler } = muteSetup({ fetchMember: async () => { throw apiError(500); } });
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'mute').length, 1);
});

test('mute expiré : 10007 Unknown Member → désactivé sans log', async () => {
  const { sanctions, scheduler, logs } = muteSetup({ fetchMember: async () => { throw apiError(10007); } });
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'mute').length, 0);
  assert.equal(logs.length, 0);
});

test('mute expiré : membre sans le rôle → désactivé sans log', async () => {
  const { sanctions, scheduler, logs } = muteSetup({ hasRole: false });
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'mute').length, 0);
  assert.equal(logs.length, 0);
});

test('ban temporaire expiré : log avec ctx « revocation »', async () => {
  const { db } = memoryDb();
  const sanctions = new SanctionRepository(db);
  sanctions.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'tempban', expiresAt: Date.now() - 1 });
  const logs = [];
  const guild = { id: 'g1', available: true, bans: { remove: async () => {} } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) }, repositories: {}, services: { logging: { send: async (...a) => logs.push(a) } } };
  await new SchedulerService({ client, sanctions, reminders: { findDue: () => [] } }).tick();
  assert.deepEqual(logs[0][4], { event: 'revocation' });
});

// ---------- Rappels ----------

function reminderSetup({ channelSend, channelFetch, userSend, userFetch, remindAt = Date.now() - 1000, channelId = 'c1' }) {
  const { db } = memoryDb();
  const reminders = new ReminderRepository(db);
  const id = reminders.create({ guildId: 'g1', channelId, userId: 'u1', message: 'boire', remindAt });
  const sent = [];
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(['channel', p]); return channelSend?.(p); } };
  const user = { id: 'u1', send: async (p) => { sent.push(['dm', p]); return userSend?.(p); } };
  const client = {
    guilds: { cache: new Map() },
    repositories: {},
    services: {},
    channels: { fetch: channelFetch ?? (async () => channel) },
    users: { fetch: userFetch ?? (async () => user) },
  };
  const scheduler = new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders });
  return { reminders, scheduler, sent, id };
}

test('rappel : livré dans le salon puis supprimé', async () => {
  const { reminders, scheduler, sent } = reminderSetup({});
  await scheduler.tick();
  assert.deepEqual(sent.map((s) => s[0]), ['channel']);
  assert.equal(reminders.listByUser('u1').length, 0);
});

test('rappel : salon en échec → MP, puis supprimé', async () => {
  const { reminders, scheduler, sent } = reminderSetup({ channelSend: async () => { throw apiError(50013); } });
  await scheduler.tick();
  assert.deepEqual(sent.map((s) => s[0]), ['channel', 'dm']);
  assert.equal(reminders.listByUser('u1').length, 0);
});

test('rappel : erreurs transitoires → gardé pour le prochain tick', async () => {
  const { reminders, scheduler } = reminderSetup({
    channelFetch: async () => { throw apiError(500); },
    userFetch: async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); },
  });
  await scheduler.tick();
  assert.equal(reminders.listByUser('u1').length, 1);
});

test('rappel : salon supprimé et MP fermés → abandonné (injoignable)', async () => {
  const { reminders, scheduler } = reminderSetup({
    channelFetch: async () => { throw apiError(10003); },
    userSend: async () => { throw apiError(50007); },
  });
  await scheduler.tick();
  assert.equal(reminders.listByUser('u1').length, 0);
});

test('rappel : non délivrable plus de 24 h après l\'échéance → abandonné', async () => {
  const transient = { channelFetch: async () => { throw apiError(500); }, userFetch: async () => { throw apiError(500); } };
  const recent = reminderSetup({ ...transient, remindAt: Date.now() - 3_600_000 });
  await recent.scheduler.tick();
  assert.equal(recent.reminders.listByUser('u1').length, 1);
  const old = reminderSetup({ ...transient, remindAt: Date.now() - 25 * 3_600_000 });
  await old.scheduler.tick();
  assert.equal(old.reminders.listByUser('u1').length, 0);
});

// ---------- Étapes isolées, stop(), auto-backup ----------

test('scheduler : une étape en échec n\'empêche pas les suivantes', async () => {
  let remindersRan = false;
  const client = { guilds: { cache: new Map() }, repositories: {}, services: {} };
  const sanctions = { findDue: () => { throw new Error('db locked'); } };
  const reminders = { findDue: () => { remindersRan = true; return []; } };
  await new SchedulerService({ client, sanctions, reminders }).tick();
  assert.equal(remindersRan, true);
});

test('scheduler : stop() attend la fin du tick en cours', async () => {
  let release;
  let finished = false;
  const client = { guilds: { cache: new Map() }, repositories: {}, services: {} };
  const reminders = {
    findDue: () => [{ id: 1, user_id: 'u', channel_id: null, message: 'x', remind_at: Date.now() }],
    deleteById: () => { finished = true; },
  };
  client.users = { fetch: async () => ({ send: () => new Promise((r) => { release = r; }) }) };
  const scheduler = new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders });
  const tickPromise = scheduler.tick();
  await new Promise((r) => setTimeout(r, 5));
  let stopped = false;
  const stopPromise = scheduler.stop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stopped, false, 'stop() attend le tick');
  release();
  await stopPromise;
  await tickPromise;
  assert.equal(finished, true);
});

test('auto-backup : créateur null (sauvegarde automatique)', async () => {
  const created = [];
  const guild = { id: 'g1' };
  const client = {
    user: { id: 'bot' },
    guilds: { cache: new Map([['g1', guild]]) },
    repositories: {},
    services: {
      backup: { create: (g, user, name) => created.push({ user, name }) },
      config: { get: () => ({ autobackup: { enabled: true, lastRun: 0, intervalHours: 24 } }), update: () => {} },
    },
  };
  await new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } }).tick();
  assert.deepEqual(created, [{ user: null, name: 'Auto-backup' }]);
});

// ---------- Purge des serveurs quittés ----------

test('purge : config supprimée 30 jours après le départ, sauf retour du bot', async () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const config = new ConfigService(repo);
  config.update('old', { locale: 'en' });
  config.update('recent', { locale: 'en' });
  config.update('back', { locale: 'en' });
  config.update('stay', { locale: 'en' });
  const longAgo = Date.now() - LEFT_GUILD_RETENTION_MS - 1000;
  config.markLeft('old', longAgo);
  config.markLeft('back', longAgo);
  config.markLeft('recent', Date.now() - 1000);
  // Une ligne corrompue ne fait pas échouer la requête.
  db.prepare('INSERT INTO guild_config (guild_id, data, updated_at) VALUES (?, ?, ?)').run('broken', '{oops', Date.now());

  const client = {
    isReady: () => true,
    guilds: { cache: new Map([['back', {}], ['stay', {}]]) },
    repositories: { guildConfig: repo },
    services: { config },
  };
  await new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } }).tick();
  assert.equal(repo.get('old'), null);
  assert.equal(repo.get('recent').locale, 'en');
  assert.equal(repo.get('back')._leftAt, undefined);
  assert.equal(repo.get('stay').locale, 'en');
});

test('purge : jamais tant que le client n\'est pas prêt', async () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const config = new ConfigService(repo);
  config.update('old', { locale: 'en' });
  config.markLeft('old', 1);
  const client = { isReady: () => false, guilds: { cache: new Map() }, repositories: { guildConfig: repo }, services: { config } };
  await new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } }).tick();
  assert.equal(repo.get('old').locale, 'en');
});

test('guildDelete date le départ, guildCreate l\'annule', () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const config = new ConfigService(repo);
  config.update('g', { locale: 'en' });
  const client = { services: { config } };
  require('../src/events/guildDelete').execute(client, { id: 'g', name: 'G' });
  assert.equal(typeof repo.get('g')._leftAt, 'number');
  // Panne (serveur indisponible) : pas un départ.
  config.update('h', { locale: 'en' });
  require('../src/events/guildDelete').execute(client, { id: 'h', available: false });
  assert.equal(repo.get('h')._leftAt, undefined);
  require('../src/events/guildCreate').execute(client, { id: 'g', name: 'G', memberCount: 1 });
  assert.equal(repo.get('g')._leftAt, undefined);
  assert.equal(repo.get('g').locale, 'en');
});
