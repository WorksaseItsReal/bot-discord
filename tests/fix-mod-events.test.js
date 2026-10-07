'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditLogEvent } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { ModerationService } = require('../src/services/ModerationService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { AntiRaidService } = require('../src/services/AntiRaidService');
const banEvents = require('../src/events/banEvents');
const channelEvents = require('../src/events/channelEvents');
const roleEvents = require('../src/events/roleEvents');

const UID = '123456789012345678';
const EXEC = '223456789012345678';
const event = (list, name) => list.find((e) => e.name === name);

function moderationService() {
  const { db } = memoryDb();
  const sanctions = new SanctionRepository(db);
  const config = { get: () => ({ moderation: { dmOnSanction: false } }) };
  return { sanctions, svc: new ModerationService({ sanctions, config, logging: { send: async () => {} } }) };
}

/** Client minimal : logs capturés, audit log illisible (pas de ViewAuditLog). */
function fakeClient(moderation) {
  const sent = [];
  const destructive = [];
  return {
    sent,
    destructive,
    user: { id: 'bot' },
    services: {
      moderation,
      logging: { send: async (...a) => sent.push(a) },
      antiraid: { handleDestructive: async (...a) => destructive.push(a) },
    },
    repositories: {},
  };
}

const banOf = (guildId = 'g1') => ({
  guild: { id: guildId, members: { me: { permissions: { has: () => false } } } },
  user: { id: UID, toString: () => `<@${UID}>`, displayAvatarURL: () => null },
  reason: null,
});

test('M2 ban / unban du bot : marqués avant l\'appel API, pas de log en double', async () => {
  const { svc } = moderationService();
  const client = fakeClient(svc);
  const guild = {
    id: 'g1',
    name: 'G',
    bans: {
      create: async () => { await event(banEvents, 'guildBanAdd').execute(client, banOf()); },
      fetch: async () => ({ user: { id: UID } }),
      remove: async () => { await event(banEvents, 'guildBanRemove').execute(client, banOf()); },
    },
  };
  await svc.ban(guild, { id: UID, send: async () => null }, { id: 'm' }, 'r');
  await svc.unban(guild, UID, { id: 'm' }, 'r');
  assert.equal(client.sent.length, 0);
  // Ban externe (non marqué) : journalisé.
  await event(banEvents, 'guildBanAdd').execute(client, banOf('g2'));
  assert.equal(client.sent.length, 1);
});

test('M2 un ban du bot qui échoue retire sa marque', async () => {
  const { svc } = moderationService();
  const guild = { id: 'g1', name: 'G', bans: { create: async () => { throw new Error('Missing Permissions'); } } };
  await assert.rejects(svc.ban(guild, { id: UID, send: async () => null }, { id: 'm' }, 'r'));
  assert.equal(svc.isRecentBotAction('ban', 'g1', UID), false);
});

test('M2 marque expirée (TTL) : l\'événement est de nouveau journalisé', () => {
  const { svc } = moderationService();
  svc.markBotAction('ban', 'g1', UID, -1);
  assert.equal(svc.isRecentBotAction('ban', 'g1', UID), false);
});

test('M2 AntiRaid alimenté par guildAuditLogEntryCreate (une entrée = une action)', async () => {
  const client = fakeClient(null);
  const audit = event(banEvents, 'guildAuditLogEntryCreate');
  const guild = { id: 'g1' };
  await audit.execute(client, { action: AuditLogEvent.ChannelDelete, executorId: EXEC }, guild);
  await audit.execute(client, { action: AuditLogEvent.RoleDelete, executorId: EXEC }, guild);
  await audit.execute(client, { action: AuditLogEvent.MemberBanAdd, executorId: EXEC }, guild);
  await audit.execute(client, { action: AuditLogEvent.MessageDelete, executorId: EXEC }, guild);
  await audit.execute(client, { action: AuditLogEvent.ChannelDelete, executorId: null }, guild);
  assert.deepEqual(client.destructive.map(([, id, type]) => [id, type]), [[EXEC, 'channelDelete'], [EXEC, 'roleDelete'], [EXEC, 'ban']]);

  // Les événements channelDelete / roleDelete / guildBanAdd ne comptent plus (pas de double comptage).
  const entries = [{ targetId: 'c', executorId: EXEC, createdTimestamp: Date.now() }];
  const auditGuild = { id: 'g1', members: { me: { permissions: { has: () => true } } }, fetchAuditLogs: async () => ({ entries }) };
  await event(channelEvents, 'channelDelete').execute(client, { id: 'c', name: 'c', guild: auditGuild, parent: null });
  await event(roleEvents, 'roleDelete').execute(client, { id: 'c', name: 'r', guild: auditGuild, colors: {} });
  await event(banEvents, 'guildBanAdd').execute(client, { ...banOf(), guild: auditGuild });
  assert.equal(client.destructive.length, 3);
});

test('AntiRaid : fenêtres d\'actions destructrices vides purgées', async () => {
  const config = { get: () => ({ antiraid: { enabled: true, channelDeleteThreshold: 99, destructiveWindowSeconds: 1 }, whitelist: { users: [], roles: [] } }) };
  const svc = new AntiRaidService({ client: { user: { id: 'bot' }, services: {} }, config, logging: { send: async () => {} } });
  const guild = { id: 'g1', ownerId: 'owner', members: { fetch: async () => null } };
  await svc.handleDestructive(guild, EXEC, 'channelDelete');
  assert.equal(svc.destructiveWindows.size, 1);
  svc.pruneWindows(Date.now() + 5_000);
  assert.equal(svc.destructiveWindows.size, 0);
});

test('Scheduler : débannissement marqué comme action du bot', async () => {
  const { svc, sanctions } = moderationService();
  sanctions.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'tempban', expiresAt: Date.now() - 1 });
  let marked = null;
  const guild = { id: 'g1', available: true, bans: { remove: async () => { marked = svc.isRecentBotAction('unban', 'g1', UID); } } };
  const client = { guilds: { cache: new Map([['g1', guild]]) }, services: { moderation: svc }, repositories: {} };
  await new SchedulerService({ client, sanctions, reminders: { findDue: () => [] } }).tick();
  assert.equal(marked, true);
  assert.equal(sanctions.listActiveByType('g1', 'tempban').length, 0);
});

test('Scheduler : sanctions d\'un serveur quitté désactivées seulement quand le client est prêt', async () => {
  const { sanctions } = moderationService();
  sanctions.create({ guildId: 'gone', userId: UID, moderatorId: 'm', type: 'tempban', expiresAt: Date.now() - 1 });
  const notReady = { guilds: { cache: new Map() }, services: {}, repositories: {}, isReady: () => false };
  await new SchedulerService({ client: notReady, sanctions, reminders: { findDue: () => [] } }).tick();
  assert.equal(sanctions.listActiveByType('gone', 'tempban').length, 1);
  const ready = { ...notReady, isReady: () => true };
  await new SchedulerService({ client: ready, sanctions, reminders: { findDue: () => [] } }).tick();
  assert.equal(sanctions.listActiveByType('gone', 'tempban').length, 0);
});
