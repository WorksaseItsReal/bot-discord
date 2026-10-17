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
