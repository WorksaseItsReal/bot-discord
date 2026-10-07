'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, MessageFlagsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { buttonRows, actionButton, TONES } = require('../src/utils/ui');

const unban = require('../src/commands/moderation/unban');
const untimeout = require('../src/commands/moderation/untimeout');
const unmute = require('../src/commands/moderation/unmute');
const lock = require('../src/commands/moderation/lock');
const pseudo = require('../src/commands/moderation/pseudo');
const sanctions = require('../src/commands/moderation/sanctions');
const antiraid = require('../src/commands/security/antiraid');
const automod = require('../src/commands/automod/automod');
const lockdown = require('../src/commands/security/lockdown');

function configService() {
  const { db } = memoryDb();
  return new ConfigService(new GuildConfigRepository(db));
}

/** Fausse interaction de bouton : enregistre les réponses. */
function fakeButton({ perms = [], customId = 'cmd:x:y', guild = {}, client = {}, message } = {}) {
  const calls = { update: [], followUp: [], reply: [] };
  return {
    calls,
    customId,
    guildId: 'g1',
    guild: { id: 'g1', ownerId: 'owner', ...guild },
    member: { id: 'u9', roles: { highest: { position: 10 } } },
    user: { id: 'u9', tag: 'alice', username: 'alice', toString: () => '<@u9>' },
    memberPermissions: new PermissionsBitField(perms),
    message: message ?? { components: [], flags: new MessageFlagsBitField(0) },
    client,
    async update(p) { calls.update.push(p); },
    async followUp(p) { calls.followUp.push(p); },
    async reply(p) { calls.reply.push(p); },
    async deferUpdate() {},
    async deferReply() {},
    async editReply(p) { calls.update.push(p); },
  };
}

const customIds = (payload) => payload.components.flatMap((r) => (r.toJSON?.() ?? r).components.map((c) => c.custom_id ?? c.url));

test('Débannir : refusé sans « Bannir des membres », aucune action exécutée', async () => {
  let called = false;
  const client = { services: { moderation: { unban: async () => { called = true; } } } };
  const i = fakeButton({ perms: ['ModerateMembers'], client });
  await assert.rejects(unban.buttons.revoke(i, client, ['123']), { name: 'UserError' });
  assert.equal(called, false);
});

test('Débannir : fige le bouton et publie la carte de levée', async () => {
  const client = { services: { moderation: { unban: async () => ({ ok: true, user: null }) } } };
  const rows = buttonRows(actionButton({ command: 'unban', action: 'revoke', args: ['123'], label: 'Débannir' }));
  const i = fakeButton({
    perms: ['BanMembers'],
    client,
    customId: 'cmd:unban:revoke:123',
    guild: { members: { me: { permissions: new PermissionsBitField(['BanMembers']) } } },
    message: { components: rows, flags: new MessageFlagsBitField(0) },
  });
  await unban.buttons.revoke(i, client, ['123']);
  assert.equal(i.calls.update[0].components[0].components[0].disabled, true);
  const card = i.calls.followUp[0].embeds[0].toJSON();
  assert.equal(card.color, TONES.success);
  assert.ok(customIds(i.calls.followUp[0]).includes('cmd:sanctions:history:123'));
  assert.ok(customIds(i.calls.followUp[0]).some((id) => id.startsWith('cmd:_:delete')));
});

test('Retirer le timeout / Démuter : permission revérifiée puis état du membre', async () => {
  const client = { services: { moderation: {} } };
  await assert.rejects(untimeout.buttons.revoke(fakeButton({ client }), client, ['5']), { name: 'UserError' });
  await assert.rejects(unmute.buttons.revoke(fakeButton({ client }), client, ['5']), { name: 'UserError' });
  const member = { id: '5', isCommunicationDisabled: () => false };
  const i = fakeButton({ perms: ['ModerateMembers'], client, guild: { members: { fetch: async () => member } } });
  await assert.rejects(untimeout.buttons.revoke(i, client, ['5']), /plus en timeout/);
});

test('Déverrouiller / Verrouiller : « Gérer les salons » exigée, rendu inverse avec 🗑️', async () => {
  let locked = null;
  const channel = { id: 'c1', guildId: 'g1', toString: () => '<#c1>', permissionsFor: () => new PermissionsBitField(['ManageChannels']) };
  const client = { services: { lockdown: { lockChannel: async (c) => { locked = c; } } } };
  const guild = { channels: { cache: new Map([['c1', channel]]) } };
  await assert.rejects(lock.buttons.run(fakeButton({ client, guild }), client, ['c1', 'owner1']), { name: 'UserError' });
  assert.equal(locked, null);
  const i = fakeButton({ perms: ['ManageChannels'], client, guild });
  await lock.buttons.run(i, client, ['c1', 'owner1']);
  assert.equal(locked, channel);
  const ids = customIds(i.calls.update[0]);
  assert.deepEqual(ids, ['cmd:unlock:run:c1:owner1', 'cmd:_:delete:owner1']);
});

test('AntiRaid / AutoMod : interrupteurs réservés à la permission déclarée par la commande', async () => {
  const config = configService();
  const client = { services: { config } };
  await assert.rejects(antiraid.buttons.toggle(fakeButton({ perms: ['ManageGuild'], client }), client, ['on']), { name: 'UserError' });
  const i = fakeButton({ perms: ['Administrator'], client });
  await antiraid.buttons.toggle(i, client, ['on']);
  assert.equal(config.get('g1').antiraid.enabled, true);
  assert.ok(customIds(i.calls.update[0]).includes('cmd:antiraid:toggle:off'));

  await assert.rejects(automod.buttons.toggle(fakeButton({ client }), client, ['on']), { name: 'UserError' });
  const j = fakeButton({ perms: ['ManageGuild'], client });
  await automod.buttons.toggle(j, client, ['on']);
  assert.equal(config.get('g1').automod.enabled, true);
  const desc = j.calls.update[0].embeds[0].toJSON().description;
  assert.ok(desc.includes('🔴 **Anti-spam**'));
});

test('Lockdown et Sanctions : permissions revérifiées', async () => {
  const client = { services: {} };
  await assert.rejects(lockdown.buttons.disable(fakeButton({ perms: ['ManageChannels'], client }), client), { name: 'UserError' });
  await assert.rejects(sanctions.buttons.history(fakeButton({ client }), client, ['1']), { name: 'UserError' });
  await assert.rejects(pseudo.buttons.undo(fakeButton({ client }), client, ['1', '']), { name: 'UserError' });
});

test('statut AutoMod : libellé de filtre lisible', () => {
  assert.equal(automod.filterLine('antiSpam', { enabled: true, action: 'timeout', duration: '5m' }), '🟢 **Anti-spam** · Timeout (5m)');
  assert.equal(automod.filterLine('antiLink', { enabled: false, action: 'delete' }), '🔴 **Anti-liens** · Suppression');
});

test('historique : une ligne claire par sanction', () => {
  const line = sanctions.sanctionLine({ id: 7, type: 'tempban', created_at: Date.now(), moderator_id: '2', duration_ms: 86_400_000, reason: 'Raid', active: 1, expires_at: Date.now() + 1000 });
  assert.match(line, /Bannissement temporaire/);
  assert.match(line, /#7/);
  assert.match(line, /En cours/);
  assert.match(line, /-# par <@2> · 1j · Raid/);
});
