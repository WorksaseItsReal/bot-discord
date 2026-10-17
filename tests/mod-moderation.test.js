'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { LockRepository } = require('../src/database/repositories/LockRepository');
const { ModerationService } = require('../src/services/ModerationService');
const { LockdownService, bitToState } = require('../src/services/LockdownService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { AutoModService } = require('../src/services/AutoModService');

const noopLogging = { send: async () => {} };
const SEND = PermissionFlagsBits.SendMessages;

// ---------- ModerationService ----------

function modService({ dm = true } = {}) {
  const { db } = memoryDb();
  const sanctions = new SanctionRepository(db);
  const config = { get: () => ({ moderation: { dmOnSanction: dm } }) };
  return { sanctions, svc: new ModerationService({ sanctions, config, logging: noopLogging }) };
}

function fakeUser(id = 'u1') {
  const dm = { deleted: false, delete: async () => { dm.deleted = true; } };
  return { id, dm, send: async () => dm, toString: () => `<@${id}>` };
}

test('ban() échoué : aucune sanction enregistrée et DM retiré', async () => {
  const { sanctions, svc } = modService();
  const user = fakeUser();
  const guild = { id: 'g1', name: 'G', bans: { create: async () => { throw new Error('Missing Permissions'); } } };
  await assert.rejects(svc.ban(guild, user, { id: 'm1' }, 'raison', { durationMs: 60_000 }));
  assert.equal(sanctions.listByUser('g1', 'u1').length, 0);
  assert.equal(user.dm.deleted, true);
});

test('ban() permanent désactive le ban temporaire actif', async () => {
  const { sanctions, svc } = modService({ dm: false });
  const user = fakeUser();
  const guild = { id: 'g1', name: 'G', bans: { create: async () => {} } };
  await svc.ban(guild, user, { id: 'm1' }, 'r1', { durationMs: 60_000 });
  assert.equal(sanctions.listActiveByType('g1', 'tempban').length, 1);
  await svc.ban(guild, user, { id: 'm1' }, 'r2');
  assert.equal(sanctions.listActiveByType('g1', 'tempban').length, 0);
  assert.equal(sanctions.listActiveByType('g1', 'ban').length, 1);
});

test('kick() refuse un membre non expulsable', async () => {
  const { svc } = modService();
  const guild = { id: 'g1', ownerId: 'owner' };
  const role = (position) => ({ highest: { position } });
  const me = { id: 'bot', guild, roles: role(10) };
  guild.members = { me };
  const target = { id: 't', guild, roles: role(1), kickable: false };
  const mod = { id: 'm', guild, roles: role(5) };
  await assert.rejects(svc.kick(guild, target, mod, 'x'), { name: 'UserError' });
});

// ---------- LockdownService ----------

function fakeChannel(id, { allow = 0n, deny = 0n } = {}) {
  const everyone = { id: 'g1' };
  const ow = { allow, deny };
  const channel = {
    id,
    guild: { id: 'g1', roles: { everyone } },
    isThread: () => false,
    permissionOverwrites: {
      cache: new Map([[everyone.id, { allow: { bitfield: ow.allow }, deny: { bitfield: ow.deny } }]]),
      edits: [],
      async edit(_target, perms) {
        this.edits.push(perms);
        const cur = this.cache.get(everyone.id);
        if (perms.SendMessages === false) cur.deny.bitfield |= SEND;
      },
    },
  };
  return channel;
}

test('bitToState restaure true / false / null', () => {
  assert.equal(bitToState(SEND.toString(), '0'), true);
  assert.equal(bitToState('0', SEND.toString()), false);
  assert.equal(bitToState('0', '0'), null);
});

test('lock deux fois puis unlock restaure l\'état d\'origine (salon en lecture seule)', async () => {
  const { db } = memoryDb();
  const locks = new LockRepository(db);
  const svc = new LockdownService({ locks, logging: noopLogging });
  const ch = fakeChannel('c1', { deny: SEND });
  await svc.lockChannel(ch, null, 'x');
  await svc.lockChannel(ch, null, 'x');
  await svc.unlockChannel(ch);
  assert.equal(ch.permissionOverwrites.edits.at(-1).SendMessages, false);
  assert.equal(locks.list('g1').length, 0);
});

test('disable() ne touche que les salons verrouillés par un lockdown (les /lock individuels restent)', async () => {
  const { db } = memoryDb();
  const locks = new LockRepository(db);
  const svc = new LockdownService({ locks, logging: noopLogging });
  const locked = fakeChannel('c1');
  const other = fakeChannel('c2');
  const manual = fakeChannel('c3');
  await svc.lockChannel(locked, null, 'x', { scope: 'lockdown' });
  await svc.lockChannel(manual, null, 'x');
  const guild = { id: 'g1', channels: { cache: new Map([['c1', locked], ['c2', other], ['c3', manual]]) } };
  assert.equal(svc.status(guild), 1);
  assert.equal(await svc.disable(guild, 'mod'), 1);
  assert.equal(other.permissionOverwrites.edits.length, 0);
  assert.equal(manual.permissionOverwrites.edits.length, 1); // seulement le lock
  assert.equal(locked.permissionOverwrites.edits.at(-1).SendMessages, null);
  assert.deepEqual(locks.list('g1').map((l) => l.channel_id), ['c3']);
});

test('lock refuse un fil', async () => {
  const svc = new LockdownService({ locks: {}, logging: noopLogging });
  const thread = { guild: { id: 'g1' }, isThread: () => true };
  await assert.rejects(svc.lockChannel(thread, null, 'x'), { name: 'UserError' });
});

// ---------- SchedulerService ----------

function schedulerWith(removeImpl) {
  const { db } = memoryDb();
  const sanctions = new SanctionRepository(db);
  sanctions.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'tempban', expiresAt: Date.now() - 1 });
  const guild = { id: 'g1', available: true, bans: { remove: removeImpl } };
  const client = { guilds: { cache: new Map([['g1', guild]]) }, services: {}, repositories: {} };
  const reminders = { findDue: () => [] };
  return { sanctions, scheduler: new SchedulerService({ client, sanctions, reminders }) };
}

test('scheduler : ban temporaire gardé actif si le débannissement échoue', async () => {
  const { sanctions, scheduler } = schedulerWith(async () => { throw Object.assign(new Error('x'), { code: 50013 }); });
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'tempban').length, 1);
});

test('scheduler : 10026 Unknown Ban désactive la sanction', async () => {
  const { sanctions, scheduler } = schedulerWith(async () => { throw Object.assign(new Error('x'), { code: 10026 }); });
  await scheduler.tick();
  assert.equal(sanctions.listActiveByType('g1', 'tempban').length, 0);
});

test('scheduler : ticks concurrents ne traitent pas deux fois la même échéance', async () => {
  let calls = 0;
  const { scheduler } = schedulerWith(async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); });
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(calls, 1);
});

// ---------- AutoModService ----------

const msg = (content) => ({ guild: { id: 'g1' }, author: { id: 'u1' }, content });

test('antiFlood utilise sa propre limite et l\'action d\'un filtre désactivé n\'est jamais appliquée', () => {
  const svc = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const filters = {
    antiSpam: { enabled: false, limit: 2, windowSeconds: 60, action: 'timeout' },
    antiFlood: { enabled: true, limit: 3, windowSeconds: 60, action: 'delete' },
  };
  assert.equal(svc.inspect(msg('a'), filters), null);
  assert.equal(svc.inspect(msg('b'), filters), null);
  const hit = svc.inspect(msg('c'), filters);
  assert.equal(hit?.action, 'delete');
  // Réinitialisé après la violation : pas de sanction au message suivant
  assert.equal(svc.inspect(msg('d'), filters), null);
});

test('le tracker AutoMod est purgé des membres inactifs', () => {
  const svc = new AutoModService({ config: {}, logging: {}, moderation: {} });
  svc.inspect(msg('a'), { antiSpam: { enabled: true, limit: 5, windowSeconds: 5 } });
  assert.equal(svc.tracker.size, 1);
  svc.prune(Date.now() + 60 * 60 * 1000);
  assert.equal(svc.tracker.size, 0);
});
