'use strict';

/**
 * Régressions de la revue n° 6 (lot modération) : tests unitaires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitingLift, isEnforced } = require('../src/database/repositories/SanctionRepository');

test('R12 awaitingLift : tempban ou mute actif échu = levée en attente ; timeout, levée ou futur : non', () => {
  const now = Date.now();
  const past = now - 1000;
  assert.equal(awaitingLift({ active: 1, type: 'tempban', expires_at: past }, now), true);
  assert.equal(awaitingLift({ active: 1, type: 'mute', expires_at: past }, now), true);
  assert.equal(awaitingLift({ active: 1, type: 'timeout', expires_at: past }, now), false); // expire côté Discord
  assert.equal(awaitingLift({ active: 0, type: 'tempban', expires_at: past }, now), false);
  assert.equal(awaitingLift({ active: 1, type: 'tempban', expires_at: now + 1000 }, now), false);
  assert.equal(awaitingLift({ active: 1, type: 'mute', expires_at: null }, now), false);
  assert.equal(isEnforced({ active: 1, type: 'tempban', expires_at: past }, now), false);
});

test('R16 syncMutedRole : refus complets en conférence ; un refus que le bot n\'a pas sur le serveur est omis (surcharge non rejetée)', async () => {
  const { PermissionsBitField, ChannelType } = require('discord.js');
  const { memoryDb } = require('./db.helper');
  const { ConfigService } = require('../src/services/ConfigService');
  const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
  const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
  const { ModerationService } = require('../src/services/ModerationService');
  const { db } = memoryDb();
  const moderation = new ModerationService({ sanctions: new SanctionRepository(db), config: new ConfigService(new GuildConfigRepository(db)), logging: { send: async () => {} } });
  const edits = [];
  const stage = {
    id: 's',
    type: ChannelType.GuildStageVoice,
    permissionsFor: () => new PermissionsBitField(['ViewChannel', 'ManageRoles']),
    permissionOverwrites: { cache: new Map(), edit: async (_r, perms) => edits.push(perms) },
  };
  const guildPerms = (flags) => ({ id: 'g1', members: { me: { id: 'bot', permissions: new PermissionsBitField(flags) } } });
  await moderation.syncMutedRole(guildPerms(['Administrator']), { id: 'muted' }, [stage]);
  assert.deepEqual(Object.keys(edits[0]).sort(), ['AddReactions', 'RequestToSpeak', 'SendMessages', 'Speak', 'Stream']);
  await moderation.syncMutedRole(guildPerms(['ManageRoles', 'SendMessages', 'AddReactions', 'Speak']), { id: 'muted' }, [stage]);
  assert.deepEqual(Object.keys(edits[1]).sort(), ['AddReactions', 'SendMessages', 'Speak']);
});

test('R22 audit log : rôle Muted retiré par le bot hors /unmute → mute levé ; mute échu laissé à la levée automatique', async () => {
  const { AuditLogEvent } = require('discord.js');
  const { memoryDb } = require('./db.helper');
  const { ConfigService } = require('../src/services/ConfigService');
  const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
  const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
  const { ModerationService } = require('../src/services/ModerationService');
  const auditLogs = require('../src/events/auditLogs');
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update('g1', { moderation: { mutedRoleId: 'muted' } });
  const repo = new SanctionRepository(db);
  const moderation = new ModerationService({ sanctions: repo, config, logging: { send: async () => {} } });
  const guild = { id: 'g1', roles: { cache: new Map([['muted', { id: 'muted' }]]) }, members: { cache: new Map() } };
  const client = { user: { id: 'bot' }, users: { fetch: async () => null }, services: { moderation, logging: { wouldLog: () => false, send: async () => {} } } };
  const removal = (userId) => ({ action: AuditLogEvent.MemberRoleUpdate, targetId: userId, executorId: 'bot', createdTimestamp: Date.now() + 1, changes: [{ key: '$remove', new: [{ id: 'muted' }] }] });
  const live = repo.create({ guildId: 'g1', userId: '111111111111111111', moderatorId: 'm', type: 'mute' });
  const due = repo.create({ guildId: 'g1', userId: '222222222222222222', moderatorId: 'm', type: 'mute', expiresAt: Date.now() - 1000 });
  await auditLogs.execute(client, removal('111111111111111111'), guild);
  await auditLogs.execute(client, removal('222222222222222222'), guild);
  const row = repo.get('g1', live);
  assert.equal(row.active, 0);
  assert.equal(row.revoked_by, 'bot');
  assert.equal(row.revoke_reason, 'Rôle Muted retiré via le bot');
  assert.equal(repo.get('g1', due).active, 1, 'levée automatique court-circuitée');
});

test('R24 FORBIDDEN_PERMISSIONS : toute permission Manage*/Create* de gestion et les statistiques du serveur', () => {
  const { PermissionFlagsBits: P } = require('discord.js');
  const { FORBIDDEN_PERMISSIONS } = require('../src/commands/roles/rolemenu');
  const memberCreates = new Set(['CreateInstantInvite', 'CreatePublicThreads', 'CreatePrivateThreads']);
  const expected = Object.keys(P).filter((k) => (/^Manage/.test(k) || (/^Create/.test(k) && !memberCreates.has(k))));
  expected.push('ViewCreatorMonetizationAnalytics', 'ViewGuildInsights', 'ViewAuditLog');
  for (const name of expected) assert.ok(FORBIDDEN_PERMISSIONS.includes(P[name]), `${name} absent`);
});
