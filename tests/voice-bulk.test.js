'use strict';

/**
 * ADM2 — /voice : plan d'un rassemblement (planMoves) et contrôle des droits de l'auteur DANS le
 * vocal concerné (assertVoiceAuthority, surcharge de refus).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const voice = require('../src/commands/voice/voice');

const { planMoves, assertVoiceAuthority } = voice;
const member = (id, { bot = false, channelId = 'A' } = {}) => ({ id, user: { id, bot }, voice: { channelId } });

test('planMoves : salon fermé ignoré (occupants non lus), bots ignorés sauf demande, hiérarchie, déjà dans la cible', () => {
  const closedMembers = { get length() { throw new Error('occupants d\'un salon fermé lus'); } };
  const sources = [
    { id: 'A', allowed: true, members: [member('1'), member('2', { bot: true }), member('3')] },
    { id: 'B', allowed: true, members: [member('4', { channelId: 'B' }), member('5', { channelId: 'T' })] },
    { id: 'P', allowed: false, members: closedMembers },
    { id: 'T', allowed: true, members: [member('6', { channelId: 'T' })] },
  ];
  const plan = planMoves({ sources, targetId: 'T', canAct: (m) => m.id !== '3' });
  assert.deepEqual(plan.moves.map((m) => [m.member.id, m.fromId]), [['1', 'A'], ['4', 'B']]);
  assert.deepEqual(plan.skipped, { hierarchy: 1, bots: 1, inTarget: 1 });
  assert.equal(plan.skippedChannels, 1);
  assert.equal(plan.truncated, 0);
  const withBots = planMoves({ sources: sources.filter((s) => s.id !== 'P'), targetId: 'T', includeBots: true, canAct: () => true });
  assert.deepEqual(withBots.moves.map((m) => m.member.id), ['1', '2', '3', '4']);
});

test('planMoves : 100 déplacements au plus, le reste compté', () => {
  const many = Array.from({ length: 150 }, (_, i) => member(String(i)));
  const plan = planMoves({ sources: [{ id: 'A', allowed: true, members: many }], targetId: 'T', canAct: () => true });
  assert.equal(plan.moves.length, 100);
  assert.equal(plan.truncated, 50);
  assert.equal(planMoves({ sources: [{ id: 'A', allowed: true, members: many }], targetId: 'T', canAct: () => true, max: 10 }).moves.length, 10);
});

test('assertVoiceAuthority : une surcharge de refus dans le vocal bloque, même avec la permission sur le serveur', () => {
  const interaction = { member: { id: 'mod' } };
  const denied = { toString: () => '#privé', permissionsFor: () => new PermissionsBitField(P.ViewChannel) };
  const allowed = { toString: () => '#ouvert', permissionsFor: () => new PermissionsBitField(P.ViewChannel | P.MoveMembers | P.MuteMembers) };
  const hidden = { toString: () => '#caché', permissionsFor: () => new PermissionsBitField(P.MoveMembers) };
  assert.throws(() => assertVoiceAuthority(interaction, denied, P.MoveMembers, 'déplacer des membres'), /Voir le salon/);
  assert.throws(() => assertVoiceAuthority(interaction, hidden, P.MoveMembers, 'déplacer des membres'), /Vous ne pouvez pas/);
  assert.doesNotThrow(() => assertVoiceAuthority(interaction, allowed, P.MoveMembers, 'déplacer des membres'));
  assert.doesNotThrow(() => assertVoiceAuthority(interaction, allowed, P.MuteMembers, 'couper le micro'));
});

test('/voice : sous-commande rassembler déclarée (vers, depuis, bots) et bouton « Renvoyer chacun » routé', () => {
  const sub = voice.data.toJSON().options.find((o) => o.name === 'rassembler');
  assert.deepEqual(sub.options.map((o) => o.name), ['vers', 'depuis', 'bots']);
  assert.ok(sub.options.every((o) => !o.required));
  assert.equal(typeof voice.buttons.scatter, 'function');
  assert.equal(voice.data.toJSON().default_member_permissions, String(P.MoveMembers));
});
