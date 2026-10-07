'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, MessageFlagsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { ModerationService, resolveTargetMember, assertReason } = require('../src/services/ModerationService');
const { channelForButton, channelForCommand } = require('../src/services/LockdownService');

const unban = require('../src/commands/moderation/unban');
const untimeout = require('../src/commands/moderation/untimeout');
const unmute = require('../src/commands/moderation/unmute');
const pseudo = require('../src/commands/moderation/pseudo');
const sanctions = require('../src/commands/moderation/sanctions');

const UID = '123456789012345678';
const OTHER = '987654321098765432';
const CID = '223456789012345678';
const FORGED = ['', '..', '../members/1', '123', 'abc', undefined];

function service() {
  const { db } = memoryDb();
  const repo = new SanctionRepository(db);
  const config = { get: () => ({ moderation: { dmOnSanction: false } }) };
  const logs = [];
  return { repo, logs, svc: new ModerationService({ sanctions: repo, config, logging: { send: async (...a) => logs.push(a) } }) };
}

function fakeButton({ perms = [], guild = {}, client = {} } = {}) {
  const calls = { update: [], followUp: [], reply: [] };
  return {
    calls,
    customId: 'cmd:x:y',
    guildId: 'g1',
    guild: { id: 'g1', ownerId: 'owner', members: { me: { permissions: new PermissionsBitField(['BanMembers']) }, fetch: async () => { throw new Error('fetch interdit'); } }, ...guild },
    member: { id: 'u9' },
    user: { id: 'u9', tag: 'alice', username: 'alice' },
    memberPermissions: new PermissionsBitField(perms),
    message: { components: [], flags: new MessageFlagsBitField(0) },
    client,
    async update(p) { calls.update.push(p); },
    async followUp(p) { calls.followUp.push(p); },
    async reply(p) { calls.reply.push(p); },
  };
}

test('H1 unban() : identifiant invalide refusé AVANT tout appel à bans.fetch', async () => {
  const { svc } = service();
  let fetched = 0;
  const guild = { id: 'g1', bans: { fetch: async () => { fetched += 1; return new Map(); }, remove: async () => {} } };
  for (const id of FORGED) await assert.rejects(svc.unban(guild, id, { id: 'm' }), { name: 'UserError' });
  assert.equal(fetched, 0);
});

test('H1 unban() : agit sur existing.user.id et refuse une réponse incohérente', async () => {
  const { svc, repo } = service();
  const removed = [];
  const guild = {
    id: 'g1',
    bans: {
      fetch: async (id) => (id === UID ? { user: { id: UID, toString: () => `<@${UID}>` } } : { user: { id: OTHER } }),
      remove: async (id) => removed.push(id),
    },
  };
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'tempban', expiresAt: Date.now() + 1000 });
  const { user } = await svc.unban(guild, UID, { id: 'm' }, 'r');
  assert.equal(user.id, UID);
  assert.deepEqual(removed, [UID]);
  assert.equal(repo.listActiveByType('g1', 'tempban').length, 0);
  assert.equal(svc.isRecentBotAction('unban', 'g1', UID), true);
  // Ban renvoyé pour un autre utilisateur : refus, aucun débannissement.
  await assert.rejects(svc.unban(guild, '111111111111111111', { id: 'm' }), /pas banni/);
  assert.deepEqual(removed, [UID]);
});

test('H1 boutons de levée : ID forgé refusé sans appel à l\'API', async () => {
  let called = false;
  const client = { services: { moderation: { unban: async () => { called = true; }, unmute: async () => { called = true; }, removeTimeout: async () => { called = true; } } } };
  for (const [cmd, perm] of [[unban, 'BanMembers'], [untimeout, 'ModerateMembers'], [unmute, 'ModerateMembers']]) {
    for (const id of FORGED) {
      await assert.rejects(cmd.buttons.revoke(fakeButton({ perms: [perm], client }), client, [id]), { name: 'UserError' });
    }
  }
  assert.equal(called, false);
});

test('H1 Débannir : la carte et le bouton Sanctions utilisent l\'utilisateur résolu', async () => {
  const client = { services: { moderation: { unban: async () => ({ ok: true, user: { id: UID, toString: () => `<@${UID}>` } }) } } };
  const i = fakeButton({ perms: ['BanMembers'], client });
  await unban.buttons.revoke(i, client, [UID]);
  const ids = i.calls.followUp[0].components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.ok(ids.includes(`cmd:sanctions:history:${UID}`));
});

test('H1 historique / pseudo / salon : identifiants forgés refusés', async () => {
  const client = { services: {}, users: { fetch: async () => { throw new Error('ne doit pas être appelé'); } } };
  for (const id of FORGED) {
    await assert.rejects(sanctions.buttons.history(fakeButton({ perms: ['ModerateMembers'], client }), client, [id]), /Bouton invalide/);
    await assert.rejects(pseudo.buttons.undo(fakeButton({ perms: ['ManageNicknames'], client }), client, [id, '']), /Bouton invalide/);
    const i = fakeButton({ guild: { channels: { cache: new Map() } }, client: { channels: { fetch: async () => { throw new Error('non'); } } } });
    await assert.rejects(channelForButton(i, id), /Bouton invalide/);
  }
});

test('M3 resolveTargetMember : données résolues, refus si incomplètes, null si absent', () => {
  const full = { id: UID, guild: {}, roles: { highest: { position: 1 } } };
  const mk = (member) => ({
    options: { getUser: () => ({ id: UID }), getMember: () => member },
    guild: { members: { cache: new Map() } },
  });
  assert.equal(resolveTargetMember(mk(full)), full);
  assert.equal(resolveTargetMember(mk(null)), null);
  assert.throws(() => resolveTargetMember(mk({ user: { id: UID }, roles: [UID] })), { name: 'UserError' });
});

test('M7 channelForCommand : « Gérer les salons » exigée sur le salon ciblé', () => {
  const allowed = { id: CID, permissionsFor: () => new PermissionsBitField(['ManageChannels']) };
  const denied = { id: OTHER, toString: () => `<#${OTHER}>`, permissionsFor: () => new PermissionsBitField([]) };
  const mk = (picked) => ({
    options: { getChannel: () => picked },
    channel: allowed,
    member: { id: 'u9' },
    guild: { channels: { cache: new Map([[CID, allowed], [OTHER, denied]]) } },
  });
  assert.equal(channelForCommand(mk({ id: CID })), allowed);
  assert.equal(channelForCommand(mk(null)), allowed);
  assert.throws(() => channelForCommand(mk({ id: OTHER })), /Gérer les salons/);
});

test('requireReason : raison exigée seulement si l\'option est active', () => {
  assert.doesNotThrow(() => assertReason({ moderation: { requireReason: false } }, null));
  assert.doesNotThrow(() => assertReason({ moderation: { requireReason: true } }, 'Spam'));
  assert.throws(() => assertReason({ moderation: { requireReason: true } }, '  '), { name: 'UserError' });
  assert.throws(() => assertReason({ moderation: { requireReason: true } }, null), /raison/);
});
