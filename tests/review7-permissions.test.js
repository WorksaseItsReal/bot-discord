'use strict';

/**
 * Revue n° 7 — lot fx7-permissions (unitaires).
 * S34 : la délégation qui AUTORISE une action d'un composant « cmd:<commande>: » est mémorisée sur
 * l'interaction (symbole GRANT), pour que interactionCreate la journalise (permissionUse) après
 * l'exécution, comme pour une commande slash. Rien n'est mémorisé quand la délégation n'a servi à
 * rien (permission native, délégation insuffisante, refus).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { CommandHandler } = require('../src/core/CommandHandler');
const { ConfigService } = require('../src/services/ConfigService');
const { PermissionService } = require('../src/services/PermissionService');
const access = require('../src/utils/access');
const { requirePermission } = require('../src/services/ModerationService');

const COMMANDS = new CommandHandler().loadAll(path.join(__dirname, '..', 'src', 'commands'));

const G = '100000000000000001';
const OWNER = '100000000000000010';
const MEMBER = '100000000000000013';
const OTHER = '100000000000000014';
const L1 = '200000000000000001';

function world() {
  const rows = new Map();
  const config = new ConfigService({ get: (id) => rows.get(id) ?? null, set: (id, data) => rows.set(id, data), delete: (id) => rows.delete(id) });
  const roles = new Map();
  const guild = { id: G, ownerId: OWNER, roles: { cache: roles, everyone: null }, members: { cache: new Map(), me: null }, channels: { cache: new Map() } };
  const sent = [];
  const logging = { send: async (...args) => { sent.push(args); return true; } };
  const client = { config: { ownerIds: [], securTrustBotOwners: false }, commands: COMMANDS, services: { config } };
  guild.client = client;
  for (const [id, position] of [[G, 0], [L1, 2]]) roles.set(id, { id, name: `r${id.slice(-2)}`, position, managed: false, guild, permissions: new PermissionsBitField(0n) });
  client.services.permissions = new PermissionService({ client, config, logging });
  config.update(G, { permissions: { levels: { l1: { roles: [L1] } }, commands: { slowmode: 1, pseudo: 1, clear: 1 } } });
  const member = (id, roleIds = [], perms = []) => {
    const m = { id, user: { id }, guild, client, roles: { cache: new Map(roleIds.map((r) => [r, roles.get(r)])), highest: { position: 2 } }, permissions: new PermissionsBitField(perms) };
    guild.members.cache.set(id, m);
    return m;
  };
  return { client, guild, member, sent, svc: client.services.permissions };
}

/** Faux clic de bouton. */
function click(w, member, customId) {
  return {
    customId, guildId: G, channelId: '300000000000000001', guild: w.guild, client: w.client, member, user: { id: member.id, toString: () => `<@${member.id}>` },
    memberPermissions: member.permissions, inGuild: () => true, isButton: () => true, isAnySelectMenu: () => false, isModalSubmit: () => false,
  };
}

const chan = (bits) => ({ permissionsFor: () => new PermissionsBitField(bits) });

test('S34 : hasPermission / requirePermission mémorisent la délégation qui a autorisé le clic, et seulement elle', () => {
  const w = world();
  const delegated = w.member(MEMBER, [L1]);

  // Délégation utilisée (bouton « Annuler » de /pseudo) : mémorisée.
  const undo = click(w, delegated, `cmd:pseudo:undo:${OTHER}:`);
  assert.equal(undo[access.GRANT], undefined);
  requirePermission(undo, 'ManageNicknames');
  assert.equal(undo[access.GRANT]?.key, 'pseudo', 'délégation de /pseudo mémorisée');
  assert.equal(undo[access.GRANT].flags, P.ManageNicknames);
  assert.equal(undo[access.GRANT].level, 1);

  // Délégation insuffisante (/clear ne couvre pas « Gérer les salons ») : rien de mémorisé.
  const wrong = click(w, delegated, 'cmd:clear:x');
  assert.equal(access.hasPermission(wrong, 'ManageChannels'), false);
  assert.equal(wrong[access.GRANT], undefined, 'délégation qui n\'a rien autorisé : non mémorisée');

  // Permission native : la délégation ne sert pas, rien de mémorisé.
  const native = click(w, w.member(OTHER, [L1], ['ManageNicknames']), `cmd:pseudo:undo:${MEMBER}:`);
  assert.equal(access.hasPermission(native, 'ManageNicknames'), true);
  assert.equal(native[access.GRANT], undefined, 'permission native : aucune délégation mémorisée');

  // Sans niveau : refus, rien de mémorisé.
  const none = click(w, w.member(OTHER, []), `cmd:pseudo:undo:${MEMBER}:`);
  assert.throws(() => requirePermission(none, 'ManageNicknames'), /Gérer les pseudos/);
  assert.equal(none[access.GRANT], undefined);

  // Mémo d'une AUTRE commande (forgé) : jamais remplacé ni utilisé.
  const forged = click(w, delegated, 'cmd:slowmode:set:1:0:2');
  const other = Object.freeze({ key: 'clear', flags: P.ManageMessages, level: 1, rank: 1 });
  forged[access.GRANT] = other;
  assert.equal(access.hasPermission(forged, 'ManageChannels'), false);
  assert.equal(forged[access.GRANT], other);
});

test('S34 : memberCanIn mémorise la délégation qui couvre la permission manquante dans le salon, pas un accès natif ni un refus', () => {
  const w = world();
  const delegated = w.member(MEMBER, [L1]);

  const used = click(w, delegated, 'cmd:slowmode:set:1:0:2');
  assert.equal(access.memberCanIn(used, chan(['ViewChannel']), [P.ManageChannels]), true);
  assert.equal(used[access.GRANT]?.key, 'slowmode');

  const nativeIn = click(w, delegated, 'cmd:slowmode:set:1:0:2');
  assert.equal(access.memberCanIn(nativeIn, chan(['ViewChannel', 'ManageChannels']), [P.ManageChannels]), true);
  assert.equal(nativeIn[access.GRANT], undefined, 'permission native dans le salon');

  const hidden = click(w, delegated, 'cmd:slowmode:set:1:0:2');
  assert.equal(access.memberCanIn(hidden, chan([]), [P.ManageChannels]), false);
  assert.equal(hidden[access.GRANT], undefined, 'salon invisible : refus, rien de mémorisé');

  const sensitive = click(w, delegated, 'cmd:slowmode:set:1:0:2');
  assert.equal(access.memberCanIn(sensitive, chan(['ViewChannel']), [P.ManageChannels, P.ManageRoles]), false);
  assert.equal(sensitive[access.GRANT], undefined);
});

test('S34 : logUse d\'un bouton délégué précise qu\'il s\'agit d\'un bouton (sans sous-commande)', async () => {
  const w = world();
  const i = click(w, w.member(MEMBER, [L1]), 'cmd:slowmode:set:1:0:2');
  assert.equal(access.hasPermission(i, 'ManageChannels'), true);
  assert.equal(await w.svc.logUse(i, i[access.GRANT]), true);
  assert.equal(w.sent.length, 1);
  const [guildId, category, embed, , ctx] = w.sent[0];
  assert.equal(guildId, G);
  assert.equal(category, 'security');
  assert.deepEqual(ctx, { event: 'permissionUse' });
  const description = embed.toJSON().description;
  assert.match(description, /\*\*\/slowmode\*\* \(bouton\)/);
  assert.match(description, /Gérer les salons/);
});
