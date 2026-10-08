'use strict';

/**
 * Revue n° 2 — modération et sécurité : tests de non-régression.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, MessageFlagsBitField, AuditLogEvent, ChannelType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { DatabaseManager } = require('../src/database');
const { migrations } = require('../src/database/schema');
const { SanctionRepository, isEnforced } = require('../src/database/repositories/SanctionRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ModerationService } = require('../src/services/ModerationService');
const { AntiRaidService, RECENT_JOIN_MS } = require('../src/services/AntiRaidService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { channelForCommand } = require('../src/services/LockdownService');
const { isSafeArg } = require('../src/components/cmd');
const auditLogs = require('../src/events/auditLogs');
const banEvents = require('../src/events/banEvents');

const sanctions = require('../src/commands/moderation/sanctions');
const pseudo = require('../src/commands/moderation/pseudo');
const unban = require('../src/commands/moderation/unban');
const unmute = require('../src/commands/moderation/unmute');
const banlist = require('../src/commands/moderation/banlist');
const clear = require('../src/commands/moderation/clear');
const lockall = require('../src/commands/moderation/lockall');
const derank = require('../src/commands/roles/derank');
const massrole = require('../src/commands/roles/massrole');
const role = require('../src/commands/roles/role');
const { hasForbiddenPermissions } = require('../src/commands/roles/rolemenu');
const whitelist = require('../src/commands/security/whitelist');
const { simulate } = require('../src/commands/security/antiraid');

const UID = '123456789012345678';
const MOD = '223456789012345678';
const OTHER_MOD = '323456789012345678';
const HOUR = 3_600_000;

// ---------------------------------------------------------------- fabriques

function configService(patch = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update('g1', { moderation: { dmOnSanction: false }, ...patch });
  return config;
}

function moderationEnv({ antiraid = null, configPatch } = {}) {
  const { db } = memoryDb();
  const repo = new SanctionRepository(db);
  const config = configService(configPatch);
  const logs = [];
  const logging = { send: async (...a) => { logs.push(a); return true; } };
  const moderation = new ModerationService({ sanctions: repo, config, logging, antiraid });
  return { db, repo, config, logs, moderation };
}

/** Serveur + modérateur + cible (hiérarchie valide). */
function world({ banned = false } = {}) {
  const guild = { id: 'g1', ownerId: 'owner', name: 'G' };
  const roles = (position, cache = new Map()) => ({ highest: { position }, cache });
  const me = { id: 'bot', guild, roles: roles(100), permissions: new PermissionsBitField(['BanMembers']) };
  const actions = [];
  const target = {
    id: UID,
    guild,
    roles: roles(1),
    bannable: true,
    kickable: true,
    moderatable: true,
    joinedTimestamp: Date.now() - 30 * 24 * HOUR,
    user: { id: UID, toString: () => `<@${UID}>`, send: async () => null },
    timeout: async (ms) => actions.push(`timeout:${ms}`),
  };
  guild.members = { me, cache: new Map([[UID, target]]), fetch: async () => target };
  guild.bans = {
    fetch: async (id) => (banned && id === UID ? { user: { id: UID } } : Promise.reject(Object.assign(new Error('Unknown Ban'), { code: 10026 }))),
    create: async (id) => actions.push(`ban:${id}`),
    remove: async (id) => actions.push(`unban:${id}`),
  };
  guild.roles = { cache: new Collection() };
  const moderator = { id: MOD, guild, roles: roles(50) };
  return { guild, me, target, moderator, actions };
}

/** Message de confirmation dont le délai expire (aucun clic) : confirm() renvoie false. */
function timeoutPrompt() {
  return { id: 'prompt', awaitMessageComponent: async () => { throw new Error('timeout'); }, edit: async () => {} };
}

// ---------------------------------------------------------------- 1. /sanctions remove|clear

function sanctionsSetup({ perms = ['ModerateMembers'], user = MOD, confirmDangerous = false } = {}) {
  const env = moderationEnv();
  const resets = [];
  const client = {
    repositories: { sanctions: env.repo },
    services: {
      strikes: { reset: (...a) => resets.push(a), getCount: () => 0 },
      logging: { send: async (...a) => { env.logs.push(a); return true; } },
      config: { get: () => ({ moderation: { confirmDangerous } }) },
    },
  };
  const interaction = (sub, { id, member } = {}) => {
    const calls = { reply: [], editReply: [] };
    return {
      calls,
      id: 'i1',
      guild: { id: 'g1' },
      user: { id: user, tag: 'modo', username: 'modo', toString: () => `<@${user}>` },
      memberPermissions: new PermissionsBitField(perms),
      options: { getSubcommand: () => sub, getInteger: () => id, getUser: () => member },
      async reply(p) { this.replied = true; calls.reply.push(p); return p.fetchReply ? timeoutPrompt() : undefined; },
      async editReply(p) { calls.editReply.push(p); },
    };
  };
  return { ...env, client, interaction, resets };
}

const member = { id: UID, toString: () => `<@${UID}>`, username: 'bob' };
const titleOf = (log) => log[2].toJSON().title;

test('1 /sanctions remove : auteur ou « Gérer le serveur », log « Sanction supprimée »', async () => {
  const s = sanctionsSetup({ user: OTHER_MOD });
  const id = s.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'warn', reason: 'spam' });
  await assert.rejects(sanctions.execute(s.interaction('remove', { id }), s.client), /Seul l'auteur[\s\S]*la supprimer/);
  assert.ok(s.repo.get('g1', id), 'conservée');

  const author = sanctionsSetup({ user: MOD });
  const id2 = author.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'warn', reason: 'spam' });
  await sanctions.execute(author.interaction('remove', { id: id2 }), author.client);
  assert.equal(author.repo.get('g1', id2), undefined);
  assert.equal(author.logs.length, 1);
  assert.equal(author.logs[0][1], 'moderation');
  assert.deepEqual(author.logs[0][4], { event: 'sanction' });
  assert.match(titleOf(author.logs[0]), /Sanction supprimée/);

  const admin = sanctionsSetup({ user: OTHER_MOD, perms: ['ModerateMembers', 'ManageGuild'] });
  const id3 = admin.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'warn' });
  await sanctions.execute(admin.interaction('remove', { id: id3 }), admin.client);
  assert.equal(admin.repo.get('g1', id3), undefined);
});

test('1 /sanctions remove|clear : un ban définitif actif est « en vigueur » (/unban d\'abord)', async () => {
  assert.equal(isEnforced({ active: 1, type: 'ban', expires_at: null }), true);
  assert.equal(isEnforced({ active: 0, type: 'ban', expires_at: null }), false);
  const s = sanctionsSetup({ perms: ['ModerateMembers', 'ManageGuild'] });
  const ban = s.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'ban' });
  await assert.rejects(sanctions.execute(s.interaction('remove', { id: ban }), s.client), /encore en vigueur[\s\S]*levez-la d'abord avec \/unban/);
  await assert.rejects(sanctions.execute(s.interaction('clear', { member }), s.client), /levez-la d'abord avec \/unban/);
  assert.equal(s.repo.count('g1', UID), 1);
  s.repo.deactivateActive('g1', UID, 'ban', { by: MOD });
  await sanctions.execute(s.interaction('remove', { id: ban }), s.client);
  assert.equal(s.repo.count('g1', UID), 0);
});

test('1 /sanctions clear : « Gérer le serveur », confirmation si confirmDangerous, log « Casier effacé »', async () => {
  const noPerm = sanctionsSetup();
  noPerm.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'warn' });
  await assert.rejects(sanctions.execute(noPerm.interaction('clear', { member }), noPerm.client), /Gérer le serveur/);
  assert.equal(noPerm.repo.count('g1', UID), 1);

  const confirmEnv = sanctionsSetup({ perms: ['ModerateMembers', 'ManageGuild'], confirmDangerous: true });
  confirmEnv.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'warn' });
  const i = confirmEnv.interaction('clear', { member });
  await sanctions.execute(i, confirmEnv.client);
  assert.match(i.calls.reply[0].embeds[0].toJSON().title, /Confirmation requise/);
  assert.equal(confirmEnv.repo.count('g1', UID), 1, 'délai dépassé : rien n\'est effacé');
  assert.equal(confirmEnv.resets.length, 0);

  const ok = sanctionsSetup({ perms: ['ModerateMembers', 'ManageGuild'] });
  ok.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'warn' });
  await sanctions.execute(ok.interaction('clear', { member }), ok.client);
  assert.equal(ok.repo.count('g1', UID), 0);
  assert.match(titleOf(ok.logs[0]), /Casier effacé/);
  assert.deepEqual(ok.logs[0][4], { event: 'sanction' });
});

// ---------------------------------------------------------------- 2. /tempban d'un utilisateur déjà banni + scheduler

test('2 tempban : refusé si l\'utilisateur est déjà banni (aucun appel bans.create, rien en base)', async () => {
  const { moderation, repo } = moderationEnv();
  const w = world({ banned: true });
  await assert.rejects(
    moderation.ban(w.guild, w.target.user, w.moderator, 'r', { durationMs: HOUR, targetMember: w.target }),
    /déjà banni[\s\S]*\/unban/,
  );
  assert.deepEqual(w.actions, []);
  assert.equal(repo.count('g1', UID), 0);
  // Utilisateur non banni : tempban normal.
  const free = world();
  await moderation.ban(free.guild, free.target.user, free.moderator, 'r', { durationMs: HOUR, targetMember: free.target });
  assert.deepEqual(free.actions, [`ban:${UID}`]);
});

function schedulerSetup({ guildExtra = {} } = {}) {
  const { db } = memoryDb();
  const repo = new SanctionRepository(db);
  const actions = [];
  const logs = [];
  const member = {
    user: { id: UID },
    toString: () => `<@${UID}>`,
    roles: { cache: new Map([['muted', {}]]), remove: async () => actions.push('role-removed') },
  };
  const guild = {
    id: 'g1',
    available: true,
    members: { fetch: async () => member },
    bans: { remove: async (id) => actions.push(`unban:${id}`) },
    ...guildExtra,
  };
  const client = {
    user: { id: 'bot' },
    isReady: () => true,
    guilds: { cache: new Map([['g1', guild]]) },
    repositories: {},
    services: {
      config: { get: () => ({ moderation: { mutedRoleId: 'muted' } }) },
      logging: { send: async (...a) => { logs.push(a); return true; } },
    },
  };
  const scheduler = new SchedulerService({ client, sanctions: repo, reminders: { findDue: () => [] } });
  return { repo, scheduler, actions, logs };
}

test('2 scheduler : pas de débannissement si un ban définitif est actif (tempban clos)', async () => {
  const { repo, scheduler, actions } = schedulerSetup();
  repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'ban' });
  const tb = repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'tempban', expiresAt: Date.now() - 1 });
  await scheduler.tick();
  assert.deepEqual(actions, []);
  assert.equal(repo.get('g1', tb).active, 0);
  assert.equal(repo.listActiveByType('g1', 'ban').length, 1, 'le ban définitif reste actif');
});

test('2 tempban : une ligne « ban » périmée (Discord ne voit pas de ban) est close au tempban', async () => {
  const { moderation, repo } = moderationEnv();
  const w = world();
  repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'ban' });
  await moderation.ban(w.guild, w.target.user, w.moderator, 'r', { durationMs: HOUR, targetMember: w.target });
  assert.equal(repo.listActiveByType('g1', 'ban').length, 0);
  assert.equal(repo.listActiveByType('g1', 'tempban').length, 1);
});

test('scheduler : la sanction est relue avant d\'agir (levée ou prolongée pendant le tick)', async () => {
  const { repo, scheduler, actions } = schedulerSetup();
  const tb = repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'tempban', expiresAt: Date.now() - 1 });
  const findDue = repo.findDue.bind(repo);
  // Entre la lecture des échéances et le traitement : la sanction est levée par un modérateur.
  repo.findDue = (...a) => {
    const rows = findDue(...a);
    repo.deactivateActive('g1', UID, 'tempban', { by: MOD });
    return rows;
  };
  await scheduler.tick();
  assert.deepEqual(actions, []);
  assert.equal(repo.get('g1', tb).revoked_by, MOD);
});

test('scheduler : remute pendant le tick → l\'ancien mute est clos, le rôle reste', async () => {
  const { repo, scheduler, actions, logs } = schedulerSetup();
  const old = repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'mute', expiresAt: Date.now() - 1 });
  const findDue = repo.findDue.bind(repo);
  let fresh;
  repo.findDue = (...a) => {
    const rows = findDue(...a);
    if (!fresh) fresh = repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'mute', expiresAt: Date.now() + HOUR });
    return rows;
  };
  await scheduler.tick();
  assert.deepEqual(actions, [], 'le rôle Muted n\'est pas retiré');
  assert.equal(repo.get('g1', old).active, 0);
  assert.equal(repo.get('g1', fresh).active, 1);
  assert.equal(logs.length, 0);
});

// ---------------------------------------------------------------- 3. /pseudo bouton « Annuler »

test('3 /pseudo : l\'ancien pseudo encodé passe le routeur (isSafeArg) et se décode', () => {
  for (const nick of ['50% off', 'a/b\\c?#', 'Zoé 🎉', 'x:y', '..']) {
    const btn = pseudo.undoButton(UID, nick);
    const [, , , , encoded] = btn.toJSON().custom_id.split(':');
    assert.ok(isSafeArg(encoded), `${nick} → ${encoded}`);
    assert.equal(pseudo.decodeNick(encoded), nick);
  }
  assert.equal(pseudo.decodeNick(''), '');
  // Ancien format (encodeURIComponent) toléré.
  assert.equal(pseudo.decodeNick('Zo%C3%A9'), 'Zoé');
  assert.equal(pseudo.decodeNick('%E0%A4%A'), null);
});

// ---------------------------------------------------------------- 4+5. AntiRaid : bans faits via le bot

function raidEnv(cfg = {}) {
  const alerts = [];
  const executor = {
    id: MOD,
    roles: { cache: new Collection([['r1', { id: 'r1', editable: true, permissions: new PermissionsBitField([]), toString: () => '<@&r1>' }]]), remove: async () => {} },
    user: { id: MOD, toString: () => `<@${MOD}>`, displayAvatarURL: () => null },
  };
  const guild = {
    id: 'g1',
    ownerId: 'owner',
    members: { cache: new Map(), fetch: async () => executor },
    roles: { everyone: { id: 'g1', permissions: new PermissionsBitField([]) } },
  };
  const antiraidCfg = { enabled: true, banThreshold: 2, destructiveWindowSeconds: 10, punishExecutor: 'strip', joinThreshold: 50, joinWindowSeconds: 10, ...cfg };
  const config = { get: () => ({ antiraid: antiraidCfg, whitelist: { users: [], roles: [] } }) };
  const client = { user: { id: 'bot' }, services: {}, channels: { fetch: async () => null } };
  const service = new AntiRaidService({ client, config, logging: { send: async (...a) => alerts.push(a) } });
  return { service, guild, alerts, executor, client };
}

test('4+5 ModerationService.ban signale le modérateur à l\'AntiRaid (cible ancienne)', async () => {
  const calls = [];
  const antiraid = { handleDestructive: async (...a) => calls.push(a) };
  const { moderation } = moderationEnv({ antiraid });
  const w = world();
  await moderation.ban(w.guild, w.target.user, w.moderator, 'r', { targetMember: w.target });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], MOD);
  assert.equal(calls[0][2], 'ban');
  assert.equal(calls[0][3].targetId, UID);
  assert.equal(calls[0][3].targetJoinedAt, w.target.joinedTimestamp);
  // Un échec de la détection ne fait pas échouer le ban.
  const failing = moderationEnv({ antiraid: { handleDestructive: async () => { throw new Error('boom'); } } });
  await failing.moderation.ban(world().guild, w.target.user, w.moderator, 'r', {});
});

test('4+5 AntiRaid : bans de membres anciens comptés, bans d\'arrivants récents (< 10 min) ignorés', async () => {
  const recent = raidEnv();
  for (let n = 0; n < 3; n += 1) {
    await recent.service.handleDestructive(recent.guild, MOD, 'ban', { targetId: `${n}`, targetJoinedAt: Date.now() - 60_000 });
  }
  assert.equal(recent.alerts.length, 0, 'bannir des raiders ne déclenche rien');

  const old = raidEnv();
  await old.service.handleDestructive(old.guild, MOD, 'ban', { targetId: 'a', targetJoinedAt: Date.now() - RECENT_JOIN_MS - 1000 });
  await old.service.handleDestructive(old.guild, MOD, 'ban', { targetId: 'b', targetJoinedAt: Date.now() - RECENT_JOIN_MS - 1000 });
  assert.equal(old.alerts.length, 1);
  assert.match(old.alerts[0][2].toJSON().title, /Activité destructrice/);
});

test('4+5 audit log (ban manuel) : arrivant récent mémorisé à son arrivée → non compté', async () => {
  const env = raidEnv();
  env.client.services.antiraid = env.service;
  for (const id of ['r1', 'r2', 'r3']) {
    await env.service.handleJoin({ id, guild: env.guild, user: { id, bot: false, createdTimestamp: Date.now() - 365 * 86_400_000 }, roles: { cache: new Map() } });
  }
  const destructive = banEvents.find((e) => e.name === 'guildAuditLogEntryCreate');
  for (const id of ['r1', 'r2', 'r3']) {
    await destructive.execute(env.client, { action: AuditLogEvent.MemberBanAdd, executorId: MOD, targetId: id }, env.guild);
  }
  assert.equal(env.alerts.length, 0);
  // Cibles inconnues (membres anciens) : comptées.
  for (const id of ['o1', 'o2']) {
    await destructive.execute(env.client, { action: AuditLogEvent.MemberBanAdd, executorId: MOD, targetId: id }, env.guild);
  }
  assert.equal(env.alerts.length, 1);
});

// ---------------------------------------------------------------- 6. AntiRaid « strip »

const alertFields = (alert) => alert[2].toJSON().fields.map((f) => `${f.name}=${f.value}`).join('\n');

test('6 strip : aucun rôle retirable → échec signalé dans l\'alerte', async () => {
  const env = raidEnv({ banThreshold: 1 });
  env.executor.roles.cache = new Collection([['high', { id: 'high', editable: false, permissions: new PermissionsBitField([]), toString: () => '<@&high>' }]]);
  await env.service.handleDestructive(env.guild, MOD, 'ban', { targetId: 'x', targetJoinedAt: 1 });
  const text = alertFields(env.alerts[0]);
  assert.match(text, /Aucune \(échec ou désactivée\)/);
  assert.match(text, /Aucun rôle n'a pu être retiré/);
});

test('6 strip : un rôle restant donne une permission dangereuse → échec signalé', async () => {
  const env = raidEnv({ banThreshold: 1 });
  const removed = [];
  env.executor.roles.cache = new Collection([
    ['low', { id: 'low', editable: true, permissions: new PermissionsBitField([]), toString: () => '<@&low>' }],
    ['mod', { id: 'mod', editable: false, permissions: new PermissionsBitField(['BanMembers']), toString: () => '<@&mod>' }],
  ]);
  env.executor.roles.remove = async (roles) => removed.push(...roles.keys());
  await env.service.handleDestructive(env.guild, MOD, 'ban', { targetId: 'x', targetJoinedAt: 1 });
  assert.deepEqual(removed, ['low']);
  const text = alertFields(env.alerts[0]);
  assert.match(text, /Aucune \(échec ou désactivée\)/);
  assert.match(text, /permissions dangereuses via <@&mod>/);

  const clean = raidEnv({ banThreshold: 1 });
  await clean.service.handleDestructive(clean.guild, MOD, 'ban', { targetId: 'x', targetJoinedAt: 1 });
  assert.match(alertFields(clean.alerts[0]), /Rôles retirés/);
});

test('AntiRaid : marque « action du bot » retirée si la sanction échoue', async () => {
  const marks = [];
  const env = raidEnv({ minAccountAgeDays: 7, newAccountAction: 'ban', punishExecutor: 'ban', banThreshold: 1 });
  env.client.services.moderation = {
    markBotAction: (...a) => marks.push(['mark', ...a]),
    unmarkBotAction: (...a) => marks.push(['unmark', ...a]),
  };
  const fail = async () => { throw new Error('Missing Permissions'); };
  const newbie = { id: 'n1', guild: env.guild, user: { id: 'n1', bot: false, createdTimestamp: Date.now() - 86_400_000 }, roles: { cache: new Map() }, ban: fail, kick: fail };
  assert.deepEqual(await env.service.handleJoin(newbie), { punished: false });
  assert.deepEqual(marks.map((m) => m.slice(0, 4)), [['mark', 'ban', 'g1', 'n1'], ['unmark', 'ban', 'g1', 'n1']]);
  marks.length = 0;
  env.executor.ban = fail;
  await env.service.handleDestructive(env.guild, MOD, 'ban', { targetId: 'x', targetJoinedAt: 1 });
  assert.deepEqual(marks.map((m) => m[0]), ['mark', 'unmark']);
});

// ---------------------------------------------------------------- 7. mute levé à la main

test('7 /unmute : rôle déjà retiré mais mute actif en base → ligne désactivée (au lieu d\'un refus)', async () => {
  const { moderation, repo, logs } = moderationEnv();
  const w = world();
  await assert.rejects(moderation.unmute(w.guild, w.target, w.moderator), /n'est pas mute/);
  const id = repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'mute' });
  const res = await moderation.unmute(w.guild, w.target, w.moderator, 'r');
  assert.equal(res.dbOnly, true);
  assert.equal(repo.get('g1', id).active, 0);
  assert.deepEqual(logs[0][4], { event: 'revocation' });
});

function auditEnv() {
  const env = moderationEnv({ configPatch: { moderation: { dmOnSanction: false, mutedRoleId: 'muted' } } });
  const guild = { id: 'g1', roles: { cache: new Map([['muted', { id: 'muted' }]]) }, members: { cache: new Map() } };
  const client = {
    user: { id: 'bot' },
    users: { fetch: async () => null },
    services: { moderation: env.moderation, logging: { wouldLog: () => false, send: async () => {} } },
  };
  return { ...env, guild, client };
}

test('7 audit log : rôle Muted retiré par un tiers → mute désactivé ; par le bot → inchangé', async () => {
  const env = auditEnv();
  const id = env.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'mute' });
  const entry = (executorId) => ({ action: AuditLogEvent.MemberRoleUpdate, targetId: UID, executorId, changes: [{ key: '$remove', new: [{ id: 'muted' }] }] });
  await auditLogs.execute(env.client, entry('bot'), env.guild);
  assert.equal(env.repo.get('g1', id).active, 1);
  await auditLogs.execute(env.client, entry('human'), env.guild);
  const row = env.repo.get('g1', id);
  assert.equal(row.active, 0);
  assert.equal(row.revoked_by, 'human');
});

test('timeout : retiré à la main → désactivé ; nouveau /timeout remplace l\'ancien', async () => {
  const env = auditEnv();
  const id = env.repo.create({ guildId: 'g1', userId: UID, moderatorId: MOD, type: 'timeout', expiresAt: Date.now() + HOUR });
  await auditLogs.execute(env.client, { action: AuditLogEvent.MemberUpdate, targetId: UID, executorId: 'human', changes: [{ key: 'communication_disabled_until', old: new Date().toISOString() }] }, env.guild);
  assert.equal(env.repo.get('g1', id).active, 0);

  const { moderation, repo } = moderationEnv();
  const w = world();
  const first = await moderation.timeout(w.guild, w.target, w.moderator, 'a', HOUR);
  const second = await moderation.timeout(w.guild, w.target, w.moderator, 'b', 2 * HOUR);
  assert.equal(repo.get('g1', first.id).active, 0);
  assert.equal(repo.get('g1', second.id).active, 1);
});

// ---------------------------------------------------------------- 8. ensureMutedRole

test('8 ensureMutedRole : salons configurés à la création seulement, là où le bot a Voir + Gérer les permissions', async () => {
  const { moderation, config } = moderationEnv();
  const edits = [];
  const chan = (id, perms) => ({
    id,
    type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(perms),
    permissionOverwrites: { cache: new Map(), edit: async () => edits.push(id) },
  });
  const created = { id: 'muted' };
  const roles = new Collection();
  const guild = {
    id: 'g1',
    members: { me: { id: 'bot' } },
    roles: { cache: roles, create: async () => { roles.set('muted', created); return created; } },
    channels: { cache: new Map([['ok', chan('ok', ['ViewChannel', 'ManageRoles'])], ['blind', chan('blind', ['ManageRoles'])], ['ro', chan('ro', ['ViewChannel'])]]) },
  };
  assert.equal(await moderation.ensureMutedRole(guild), created);
  assert.deepEqual(edits, ['ok']);
  assert.equal(config.get('g1').moderation.mutedRoleId, 'muted');
  await moderation.ensureMutedRole(guild);
  assert.deepEqual(edits, ['ok'], 'aucun nouveau parcours au /mute suivant');
});

// ---------------------------------------------------------------- 9. acquittement avant les appels API

test('9 boutons de levée : deferUpdate AVANT les appels API ; /unban : deferReply avant', async () => {
  const order = [];
  const target = { id: UID, user: { id: UID, toString: () => `<@${UID}>` } };
  const client = { services: { moderation: { unmute: async () => order.push('api') } } };
  const i = {
    customId: `cmd:unmute:revoke:${UID}`,
    guildId: 'g1',
    guild: { id: 'g1', members: { fetch: async () => { order.push('fetch'); return target; } } },
    member: { id: MOD },
    user: { id: MOD, tag: 'modo', username: 'modo' },
    memberPermissions: new PermissionsBitField(['ModerateMembers']),
    message: { components: [], flags: new MessageFlagsBitField(0) },
    async deferUpdate() { this.deferred = true; order.push('defer'); },
    async editReply() { order.push('edit'); },
    async update() { order.push('update'); },
    async followUp() { order.push('followUp'); },
  };
  await unmute.buttons.revoke(i, client, [UID]);
  assert.deepEqual(order, ['defer', 'fetch', 'api', 'edit', 'followUp']);

  const steps = [];
  const slash = {
    guild: { id: 'g1' },
    member: { id: MOD },
    user: { id: MOD },
    options: { getString: (n) => (n === 'user_id' ? UID : null) },
    async deferReply() { steps.push('defer'); },
    async editReply() { steps.push('edit'); },
  };
  await unban.execute(slash, { services: { moderation: { unban: async () => { steps.push('api'); return { user: target.user }; } } } });
  assert.deepEqual(steps, ['defer', 'api', 'edit']);
});

// ---------------------------------------------------------------- 10. confirmDangerous

function rolesWorld({ confirmDangerous = false } = {}) {
  const guild = { id: 'g1', ownerId: 'owner' };
  const removed = [];
  const logs = [];
  const r = (id, extra = {}) => ({ id, editable: true, position: 5, toString: () => `<@&${id}>`, ...extra });
  const target = {
    id: UID,
    guild,
    roles: {
      highest: { position: 5 },
      cache: new Collection([['g1', r('g1')], ['a', r('a')], ['muted', r('muted')], ['top', r('top', { editable: false })]]),
      remove: async (roles) => removed.push(...roles.keys()),
    },
    displayAvatarURL: () => null,
  };
  guild.members = { fetch: async () => target, me: { id: 'bot', guild, roles: { highest: { position: 100 } } } };
  const client = {
    services: {
      config: { get: () => ({ moderation: { confirmDangerous } }) },
      moderation: { mutedRole: () => ({ id: 'muted' }) },
      logging: { send: async (...a) => { logs.push(a); } },
    },
  };
  const calls = { reply: [], editReply: [] };
  const interaction = {
    id: 'i1',
    guild,
    member: { id: MOD, guild, roles: { highest: { position: 50 } } },
    user: { id: MOD, tag: 'modo', toString: () => `<@${MOD}>` },
    options: { getUser: () => ({ id: UID, toString: () => `<@${UID}>`, username: 'bob' }), getString: () => null },
    async reply(p) { this.replied = true; calls.reply.push(p); return p.fetchReply ? timeoutPrompt() : undefined; },
    async editReply(p) { calls.editReply.push(p); },
  };
  return { client, interaction, removed, logs, calls };
}

test('10 /derank : ne retire pas le rôle Muted, journalisé en modération', async () => {
  const w = rolesWorld();
  await derank.execute(w.interaction, w.client);
  assert.deepEqual(w.removed, ['a']);
  assert.equal(w.logs.length, 1);
  assert.equal(w.logs[0][1], 'moderation');
  assert.deepEqual(w.logs[0][4], { event: 'sanction' });
});

test('10 confirmDangerous : /derank, /massrole, /role delete et /lockall demandent confirmation', async () => {
  const d = rolesWorld({ confirmDangerous: true });
  await derank.execute(d.interaction, d.client);
  assert.match(d.calls.reply[0].embeds[0].toJSON().title, /Confirmation requise/);
  assert.deepEqual(d.removed, [], 'délai dépassé : aucun rôle retiré');
  assert.equal(d.logs.length, 0);

  // /role delete
  let deleted = false;
  const r = rolesWorld({ confirmDangerous: true });
  const target = { id: 'rid', name: 'Rôle', position: 1, managed: false, members: new Map(), colors: {}, hexColor: '#000000', toString: () => '<@&rid>', delete: async () => { deleted = true; } };
  r.interaction.options = { getSubcommand: () => 'delete', getRole: () => target };
  r.interaction.guild.members.me.roles.highest.position = 100;
  r.interaction.memberPermissions = new PermissionsBitField(['ManageRoles']);
  await role.execute(r.interaction, r.client);
  assert.equal(deleted, false);
  assert.match(r.calls.reply[0].embeds[0].toJSON().title, /Confirmation requise/);

  // /massrole
  const m = rolesWorld({ confirmDangerous: true });
  let fetched = false;
  m.interaction.guild.members.fetch = async () => { fetched = true; return new Collection(); };
  m.interaction.options = { getString: (n) => (n === 'action' ? 'add' : null), getRole: () => ({ id: 'rid', position: 1, managed: false, toString: () => '<@&rid>' }) };
  await massrole.execute(m.interaction, m.client);
  assert.equal(fetched, false, 'aucun membre traité sans confirmation');
  assert.equal(massrole.running.size, 0);

  // /lockall
  const l = rolesWorld({ confirmDangerous: true });
  let enabled = false;
  l.client.services.lockdown = { enable: async () => { enabled = true; return 3; } };
  l.interaction.memberPermissions = new PermissionsBitField(['Administrator']);
  await lockall.execute(l.interaction, l.client);
  assert.equal(enabled, false);
});

// ---------------------------------------------------------------- escalade (migration 10)

test('migration 10 : palier repris des sanctions d\'escalade, jamais d\'un warn imitant le format', () => {
  const manager = new DatabaseManager(':memory:');
  const db = manager.connect();
  // Rejoue l'état « avant migration 10 » : colonne retirée, lignes anciennes, puis migration.
  db.exec('DROP INDEX IF EXISTS idx_sanctions_escalation; ALTER TABLE sanctions DROP COLUMN escalation_step;');
  const insert = db.prepare("INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, active, created_at) VALUES ('g1', ?, 'm', ?, ?, 1, 0)");
  insert.run('u1', 'kick', 'Escalade automatique (palier de 5 strikes)');
  insert.run('u1', 'timeout', 'Escalade automatique (3 strikes)');
  insert.run('u2', 'warn', 'Escalade automatique (palier de 99 strikes)');
  insert.run('u3', 'ban', 'Escalade automatique (palier de x strikes)');
  db.exec(migrations.find((m) => m.id === 10).up);
  const repo = new SanctionRepository(db);
  assert.equal(repo.maxEscalationStep('g1', 'u1'), 5);
  assert.equal(repo.maxEscalationStep('g1', 'u2'), 0, 'warn falsifié ignoré');
  assert.equal(repo.maxEscalationStep('g1', 'u3'), 0);
});

// ---------------------------------------------------------------- basses

test('simulation AntiRaid : lockdown sans « Gérer les rôles » signalé', () => {
  const perms = new PermissionsBitField(['ManageChannels', 'ViewAuditLog', 'KickMembers', 'BanMembers']);
  const { warnings } = simulate({ enabled: true, action: 'lockdown', joinThreshold: 5, joinWindowSeconds: 10, punishExecutor: 'none' }, perms);
  assert.ok(warnings.some((w) => /Gérer les rôles/.test(w)));
});

test('/whitelist add : @everyone et rôles gérés refusés', async () => {
  const config = configService();
  const client = { services: { config } };
  const mk = (r) => ({ guild: { id: 'g1' }, options: { getSubcommand: () => 'add', getUser: () => null, getRole: () => r }, reply: async () => {} });
  await assert.rejects(whitelist.execute(mk({ id: 'g1', toString: () => '@everyone' }), client), /@everyone/);
  await assert.rejects(whitelist.execute(mk({ id: 'r1', managed: true, toString: () => '<@&r1>' }), client), /géré/);
  assert.deepEqual(config.get('g1').whitelist.roles, []);
});

test('/lock, /hide… : « Gérer les permissions » exigée du modérateur sur le salon', () => {
  const channel = (perms) => ({ id: 'c1', toString: () => '<#c1>', permissionsFor: () => new PermissionsBitField(perms) });
  const mk = (c) => ({ options: { getChannel: () => null }, channel: c, member: {}, guild: { channels: { cache: new Map() } } });
  assert.throws(() => channelForCommand(mk(channel(['ManageChannels'])), 'salon', { overwrites: true }), /Gérer les permissions/);
  assert.ok(channelForCommand(mk(channel(['ManageChannels', 'ManageRoles'])), 'salon', { overwrites: true }));
  // Sans l'option (slowmode…), « Gérer les salons » suffit.
  assert.ok(channelForCommand(mk(channel(['ManageChannels']))));
});

test('rolemenu : permissions vocales, fils et événements interdites', () => {
  for (const flag of ['MuteMembers', 'DeafenMembers', 'MoveMembers', 'ManageThreads', 'ManageEvents']) {
    assert.equal(hasForbiddenPermissions({ permissions: new PermissionsBitField([flag]) }), true, flag);
  }
  assert.equal(hasForbiddenPermissions({ permissions: new PermissionsBitField(['SendMessages']) }), false);
});

test('/banlist : pagination au-delà de 1 000 bans (bornée)', async () => {
  const total = 2_345;
  const all = Array.from({ length: total }, (_, n) => ({ user: { id: String(100_000_000_000_000_000n + BigInt(n)) } }));
  const calls = [];
  const guild = {
    bans: {
      fetch: async ({ limit, after }) => {
        calls.push(after ?? null);
        const start = after ? all.findIndex((b) => b.user.id === after) + 1 : 0;
        return new Collection(all.slice(start, start + limit).map((b) => [b.user.id, b]));
      },
    },
  };
  const { list, truncated } = await banlist.fetchAllBans(guild);
  assert.equal(list.length, total);
  assert.equal(truncated, false);
  assert.equal(calls.length, 3);
  const capped = await banlist.fetchAllBans(guild, { limit: 1000, max: 2000 });
  assert.equal(capped.list.length, 2000);
  assert.equal(capped.truncated, true);
});

test('/clear : salon non résolu → UserError (pas de crash)', async () => {
  const i = { channel: null, options: { getInteger: () => 5, getUser: () => null }, deferReply: async () => { throw new Error('ne doit pas être appelé'); } };
  await assert.rejects(clear.execute(i), { name: 'UserError' });
});

test('/massrole : dernière édition protégée', async () => {
  const members = new Collection([['m1', { user: { bot: false }, roles: { cache: new Map(), add: async () => {} } }]]);
  let edits = 0;
  const i = {
    createdTimestamp: Date.now(),
    guild: { id: 'g9', members: { fetch: async () => members, me: { roles: { highest: { position: 100 } } } }, ownerId: MOD },
    user: { id: MOD },
    member: { roles: { highest: { position: 50 } } },
    options: { getString: (n) => (n === 'action' ? 'add' : null), getRole: () => ({ id: 'rid', position: 1, managed: false, toString: () => '<@&rid>' }) },
    async deferReply() {},
    async fetchReply() { return null; },
    async editReply() { edits += 1; if (edits > 1) throw new Error('Unknown Message'); },
  };
  await massrole.execute(i, { services: { config: { get: () => ({ moderation: {} }) } } });
  assert.equal(edits, 2);
});
