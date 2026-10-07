'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, ChannelType, PermissionFlagsBits } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { StrikeRepository } = require('../src/database/repositories/StrikeRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ModerationService } = require('../src/services/ModerationService');
const { StrikeService, escalationReason } = require('../src/services/StrikeService');
const warn = require('../src/commands/moderation/warn');

const UID = '123456789012345678';

function setup() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update('g1', { moderation: { dmOnSanction: false } });
  const repo = new SanctionRepository(db);
  const moderation = new ModerationService({ sanctions: repo, config, logging: { send: async () => {} } });
  const strikes = new StrikeService(new StrikeRepository(db), config);
  return { db, config, repo, moderation, strikes };
}

/** Faux serveur + membre cible (kick/ban/timeout simulés) et interaction /warn. */
function world(env, perms) {
  const guild = { id: 'g1', ownerId: 'owner', name: 'G' };
  const roles = (position) => ({ highest: { position }, cache: new Map() });
  const me = { id: 'bot', guild, roles: roles(100) };
  const actions = [];
  const target = {
    id: UID,
    guild,
    roles: roles(1),
    kickable: true,
    bannable: true,
    moderatable: true,
    user: { id: UID, toString: () => `<@${UID}>`, send: async () => null },
    kick: async () => actions.push('kick'),
    timeout: async (ms) => actions.push(`timeout:${ms}`),
  };
  guild.members = { me, fetch: async () => target };
  guild.bans = { create: async () => actions.push('ban') };
  const replies = [];
  const interaction = {
    guild,
    member: { id: 'mod', guild, roles: roles(50) },
    user: { id: 'mod', tag: 'mod', username: 'mod' },
    memberPermissions: new PermissionsBitField(perms),
    options: { getUser: () => target.user, getString: () => 'raison' },
    async deferReply() {},
    async editReply(p) { replies.push(p); },
  };
  const client = { services: { config: env.config, moderation: env.moderation, strikes: env.strikes } };
  return { interaction, client, actions, replies };
}

const escalationField = (reply) => reply.embeds[0].toJSON().fields.find((f) => f.name.includes('Escalade'))?.value;

test('H2 pendingEscalation : plus haut palier atteint et pas encore appliqué', () => {
  const { strikes } = setup();
  assert.equal(strikes.pendingEscalation('g1', 2, 0), null);
  assert.equal(strikes.pendingEscalation('g1', 3, 0).action, 'mute');
  assert.equal(strikes.pendingEscalation('g1', 4, 3), null); // déjà appliqué : pas de réapplication
  assert.equal(strikes.pendingEscalation('g1', 6, 3).action, 'kick'); // >= seuil, pas seulement ===
  assert.equal(strikes.pendingEscalation('g1', 8, 3).action, 'ban'); // le plus sévère atteint
  assert.equal(strikes.pendingEscalation('g1', 8, 7), null);
});

test('H2 appliedEscalationLevel lit les paliers dans l\'historique (ancien format compris)', () => {
  const { repo, moderation } = setup();
  assert.equal(moderation.appliedEscalationLevel('g1', UID), 0);
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'timeout', reason: 'Escalade automatique (3 strikes)' });
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'kick', reason: escalationReason({ strikes: 5 }) });
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'warn', reason: 'Escalade automatique (palier de 9 strikes) — non, simple warn' });
  repo.create({ guildId: 'g1', userId: 'autre', moderatorId: 'm', type: 'ban', reason: escalationReason({ strikes: 7 }) });
  assert.equal(moderation.appliedEscalationLevel('g1', UID), 9);
});

test('H2 /warn : escalade non appliquée sans la permission de l\'invocateur, puis rattrapée', async () => {
  const env = setup();
  env.strikes.repo.set('g1', UID, 4); // le prochain warn atteint le palier « kick » (5)
  const noKick = world(env, ['ModerateMembers']);
  await warn.execute(noKick.interaction, noKick.client);
  assert.deepEqual(noKick.actions, []);
  const text = escalationField(noKick.replies[0]);
  assert.match(text, /Palier de \*\*5 strikes\*\* atteint/);
  assert.match(text, /Expulser des membres/);

  // Warn suivant (6 strikes) par un modérateur qui a la permission : le palier manqué est appliqué.
  const withKick = world(env, ['ModerateMembers', 'KickMembers']);
  await warn.execute(withKick.interaction, withKick.client);
  assert.deepEqual(withKick.actions, ['kick']);
  assert.match(escalationField(withKick.replies[0]), /expulsé/);
  const kick = env.repo.listByUser('g1', UID).find((s) => s.type === 'kick');
  assert.equal(kick.moderator_id, 'mod');

  // Warn suivant (7 strikes → ban) : le kick n'est pas réappliqué ; ban exige « Bannir ».
  const again = world(env, ['ModerateMembers', 'KickMembers']);
  await warn.execute(again.interaction, again.client);
  assert.deepEqual(again.actions, []);
  assert.match(escalationField(again.replies[0]), /Bannir des membres/);
});

test('H2 /warn : un palier appliqué ne l\'est pas à nouveau au warn suivant', async () => {
  const env = setup();
  env.strikes.repo.set('g1', UID, 2);
  const w1 = world(env, ['ModerateMembers']);
  await warn.execute(w1.interaction, w1.client);
  assert.deepEqual(w1.actions, ['timeout:3600000']);
  const w2 = world(env, ['ModerateMembers']);
  await warn.execute(w2.interaction, w2.client);
  assert.deepEqual(w2.actions, []);
  assert.equal(escalationField(w2.replies[0]), undefined);
});

test('M4 mute() désactive les mutes actifs précédents du membre (et seulement les siens)', async () => {
  const env = setup();
  const role = { id: 'muted' };
  const guild = { id: 'g1', ownerId: 'owner', name: 'G', roles: { cache: new Map([['muted', role]]) }, channels: { cache: new Map() } };
  guild.roles.cache.find = (fn) => [...guild.roles.cache.values()].find(fn);
  env.config.update('g1', { moderation: { mutedRoleId: 'muted' } });
  const roles = (position) => ({ highest: { position }, cache: new Map(), add: async () => {} });
  guild.members = { me: { id: 'bot', guild, roles: roles(100) } };
  const target = { id: UID, guild, roles: roles(1), user: { id: UID, send: async () => null } };
  env.repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'mute', expiresAt: Date.now() + 1000 });
  env.repo.create({ guildId: 'g1', userId: 'autre', moderatorId: 'm', type: 'mute', expiresAt: Date.now() + 1000 });
  await env.moderation.mute(guild, target, { id: 'mod', guild, roles: roles(50) }, 'r', 60_000);
  const active = env.repo.listActiveByType('g1', 'mute');
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((s) => s.user_id).sort(), [UID, 'autre'].sort());
  assert.equal(active.find((s) => s.user_id === UID).duration_ms, 60_000);
});

test('ensureMutedRole ne réécrit pas un overwrite déjà en place', async () => {
  const env = setup();
  const role = { id: 'muted' };
  env.config.update('g1', { moderation: { mutedRoleId: 'muted' } });
  const edits = [];
  const channel = (id, type, denyBits) => ({
    id,
    type,
    permissionOverwrites: {
      cache: new Map(denyBits == null ? [] : [['muted', { deny: new PermissionsBitField(denyBits) }]]),
      edit: async (_r, perms) => edits.push([id, perms]),
    },
  });
  const F = PermissionFlagsBits;
  const done = channel('a', ChannelType.GuildText, F.SendMessages | F.AddReactions | F.SendMessagesInThreads);
  const partial = channel('b', ChannelType.GuildText, F.SendMessages);
  const fresh = channel('c', ChannelType.GuildVoice, null);
  const guild = { id: 'g1', roles: { cache: new Map([['muted', role]]) }, channels: { cache: new Map([['a', done], ['b', partial], ['c', fresh]]) } };
  await env.moderation.ensureMutedRole(guild);
  assert.deepEqual(edits.map(([id]) => id), ['b', 'c']);
  assert.deepEqual(Object.keys(edits[1][1]).sort(), ['AddReactions', 'SendMessages', 'Speak']);
});

test('SanctionRepository.deactivateActive filtre par membre en SQL', () => {
  const { repo } = setup();
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'tempban' });
  repo.create({ guildId: 'g1', userId: 'autre', moderatorId: 'm', type: 'tempban' });
  assert.equal(repo.deactivateActive('g1', UID, 'tempban'), 1);
  assert.deepEqual(repo.listActiveByType('g1', 'tempban').map((s) => s.user_id), ['autre']);
});
