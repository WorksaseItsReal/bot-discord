'use strict';

/**
 * Revue n° 7, tests unitaires : lot « divers » — report des salons bloqués des alertes de
 * mots-clés (S41), contrôle strict des actions de modération (S29).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { HighlightRepository } = require('../src/database/repositories/HighlightRepository');
const { ConfigService } = require('../src/services/ConfigService');
const channelRemap = require('../src/utils/channelRemap');
const path = require('node:path');
const { PermissionsBitField } = require('discord.js');
const { CommandHandler } = require('../src/core/CommandHandler');
const { PermissionService } = require('../src/services/PermissionService');
const { HighlightService } = require('../src/services/HighlightService');
const { ModerationService, requirePermission } = require('../src/services/ModerationService');
const { assertMemberPermissions } = require('../src/events/interactionCreate');
const access = require('../src/utils/access');

const COMMANDS = new CommandHandler().loadAll(path.join(__dirname, '..', 'src', 'commands'));

const G = '100000000000000001';
const OTHER = '100000000000000002';
const OLD = '200000000000000001';
const NEW = '200000000000000002';
const KEEP = '200000000000000003';
const U1 = '300000000000000001';
const U2 = '300000000000000002';
const U3 = '300000000000000003';

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const highlights = new HighlightRepository(db);
  highlights.save({ guildId: G, userId: U1, words: ['gadget'], blockedChannels: [KEEP, OLD], blockedUsers: [] });
  highlights.save({ guildId: G, userId: U2, words: ['bot'], blockedChannels: [KEEP], blockedUsers: [] });
  highlights.save({ guildId: OTHER, userId: U1, words: ['gadget'], blockedChannels: [OLD], blockedUsers: [] });
  // Donnée abîmée : jamais lue comme une liste, jamais réécrite.
  db.prepare("INSERT INTO highlights (guild_id, user_id, words, blocked_channels, updated_at) VALUES (?, ?, '[]', ?, 0)").run(G, U3, `pas du json ${OLD}`);
  return { db, config, highlights };
}

// ------------------------------------------------------------------ S41

test('S41 chaque colonne de LISTE de salons (…_channels) est classée dans channelRemap', () => {
  const { db } = memoryDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  const missing = [];
  for (const t of tables) {
    for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
      if (/channels$/.test(c.name) && !channelRemap.JSON_LISTS.includes(`${t}.${c.name}`)) missing.push(`${t}.${c.name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('S41 remapInPlace (/channel renouveler) : le salon bloqué des alertes de mots-clés suit le salon, autre serveur et donnée abîmée intacts', () => {
  const { db, config, highlights } = world();
  const report = channelRemap.remapInPlace(db, config, G, OLD, NEW);
  assert.deepEqual(highlights.get(G, U1).blockedChannels, [KEEP, NEW]);
  assert.deepEqual(highlights.get(G, U2).blockedChannels, [KEEP]);
  assert.deepEqual(highlights.get(OTHER, U1).blockedChannels, [OLD], 'autre serveur intact');
  assert.equal(db.prepare('SELECT blocked_channels FROM highlights WHERE guild_id = ? AND user_id = ?').get(G, U3).blocked_channels, `pas du json ${OLD}`);
  assert.equal(report.carried.highlights, 1);
  // Inverse (annulation après un échec) : état d'origine.
  channelRemap.remapInPlace(db, config, G, NEW, OLD);
  assert.deepEqual(highlights.get(G, U1).blockedChannels, [KEEP, OLD]);
});

test('S41 capture puis restore (salon recréé par Secur) : le salon bloqué passe au nouveau salon ; la capture le compte', () => {
  const { db, config, highlights } = world();
  const bundle = channelRemap.capture(db, config, G, OLD);
  assert.equal(bundle.rows['highlights.blocked_channels']?.length, 1);
  const out = channelRemap.restore(bundle, NEW);
  assert.ok(out.updated >= 1);
  assert.deepEqual(highlights.get(G, U1).blockedChannels, [KEEP, NEW]);
  assert.deepEqual(highlights.get(OTHER, U1).blockedChannels, [OLD]);
});

test('S41 un salon déjà présent dans la liste n\'y figure pas deux fois', () => {
  const { db, config, highlights } = world();
  highlights.save({ guildId: G, userId: U2, words: ['bot'], blockedChannels: [NEW, OLD], blockedUsers: [] });
  channelRemap.remapInPlace(db, config, G, OLD, NEW);
  assert.deepEqual(highlights.get(G, U2).blockedChannels, [NEW]);
});

test('S41 l\'index des alertes en mémoire se reconstruit après un report de salon bloqué', () => {
  const { db, config, highlights } = world();
  const svc = new HighlightService({ client: {}, highlights, config: { get: () => ({}) } });
  const before = svc.index(G);
  assert.equal(svc.index(G), before, 'index réutilisé tant que rien ne change');
  assert.ok([...before.members.get(U1).blockedChannels].includes(OLD));
  channelRemap.remapInPlace(db, config, G, OLD, NEW);
  const after = svc.index(G);
  assert.notEqual(after, before);
  assert.ok([...after.members.get(U1).blockedChannels].includes(NEW));
  assert.equal(svc.index(OTHER), svc.index(OTHER), 'autre serveur : index stable');
});

// ------------------------------------------------------------------ S29

const OWNER = '400000000000000010';
const MOD = '400000000000000012';
const ADMIN = '400000000000000011';
const L3 = '500000000000000003';

/** Faux serveur + client (même modèle que tests/perm-levels.test.js). */
function permWorld(permissions) {
  const rows = new Map();
  const config = new ConfigService({ get: (id) => rows.get(id) ?? null, set: (id, data) => rows.set(id, data), delete: (id) => rows.delete(id) });
  const roles = new Map();
  const guild = { id: G, ownerId: OWNER, roles: { cache: roles, everyone: null }, members: { cache: new Map(), me: null }, channels: { cache: new Map() } };
  const client = { config: { ownerIds: [] }, commands: COMMANDS, user: { id: '400000000000000099' }, repositories: {}, services: { config } };
  guild.client = client;
  roles.set(G, { id: G, name: '@everyone', position: 0, guild, permissions: new PermissionsBitField(0n) });
  roles.set(L3, { id: L3, name: 'n3', position: 2, guild, permissions: new PermissionsBitField(0n) });
  client.services.permissions = new PermissionService({ client, config });
  config.update(G, { permissions: { levels: { l3: { roles: [L3] } }, strict: true, ...permissions } });
  const member = (id, roleIds = [], perms = []) => {
    const m = { id, user: { id, bot: false }, guild, client, roles: { cache: new Map(roleIds.map((r) => [r, roles.get(r)])), highest: { position: roleIds.length ? 2 : 0 } }, permissions: new PermissionsBitField(perms) };
    guild.members.cache.set(id, m);
    return m;
  };
  const click = (m, customId) => ({ customId, guildId: G, guild, client, member: m, user: { id: m.id }, memberPermissions: m.permissions, inGuild: () => true });
  const menu = (m, commandName) => ({ commandName, guildId: G, guild, client, member: m, user: { id: m.id }, memberPermissions: m.permissions, inGuild: () => true });
  return { guild, client, member, click, menu, config };
}

test('S29 boutons : la restriction de la commande du customId ne vaut que pour une permission que cette commande déclare', () => {
  const w = permWorld({ commands: { automod: 3, ban: 3 } });
  const mod = w.member(MOD, [], ['ModerateMembers', 'BanMembers', 'ManageGuild']);
  // /automod déclare « Gérer le serveur » : lever une quarantaine (Exclure temporairement) ou bannir n'en dépend pas.
  assert.doesNotThrow(() => requirePermission(w.click(mod, `cmd:automod:qlift:${MOD}`), 'ModerateMembers'));
  assert.doesNotThrow(() => requirePermission(w.click(mod, `cmd:automod:qban:${MOD}`), 'BanMembers'));
  // Les boutons de configuration de /automod restent restreints.
  assert.throws(() => requirePermission(w.click(mod, 'cmd:automod:toggle:on'), 'ManageGuild'), /\/automod\*\* est réservée au \*\*niveau 3/);
  // /ban déclare « Bannir » : son bouton Débannir reste restreint (comportement d'avant).
  assert.throws(() => requirePermission(w.click(mod, `cmd:ban:unban:${MOD}`), 'BanMembers'), /niveau 3/);
  // Rang suffisant : accès.
  const l3 = w.member(ADMIN, [L3], ['ManageGuild']);
  assert.doesNotThrow(() => requirePermission(w.click(l3, 'cmd:automod:toggle:on'), 'ManageGuild'));
});

test('S29 action : bannir est refusé à un rang insuffisant quel que soit le chemin ; bot, Administrateur et modérateur hors cache exemptés', async () => {
  const w = permWorld({ commands: { ban: 3, tempban: 2 } });
  const mod = w.member(MOD, [], ['BanMembers']);
  assert.equal(access.strictActionLevelMissing(w.client, w.guild, mod, 'ban'), 3);
  assert.throws(() => access.assertStrictAction(w.client, w.guild, mod, 'ban'), /\/ban\*\* est réservée au \*\*niveau 3/);
  assert.throws(() => access.assertStrictAction(w.client, w.guild, { id: MOD, username: 'mod' }, 'ban'), /niveau 3/, 'User en cache : relu sur le serveur');
  assert.doesNotThrow(() => access.assertStrictAction(w.client, w.guild, w.client.user, 'ban'), 'action du bot');
  assert.doesNotThrow(() => access.assertStrictAction(w.client, w.guild, { id: '400000000000000077' }, 'ban'), 'hors cache');
  assert.doesNotThrow(() => access.assertStrictAction(w.client, w.guild, w.member(ADMIN, [], ['Administrator']), 'ban'));
  assert.doesNotThrow(() => access.assertStrictAction(w.client, w.guild, mod, 'kick'), 'commande non attribuée');
  // ModerationService : refus AVANT toute requête (aucun appel au serveur factice).
  const calls = [];
  w.guild.bans = { create: async () => calls.push('ban'), fetch: async () => null };
  const moderation = new ModerationService({ sanctions: {}, config: w.config, logging: { send: async () => {} } });
  await assert.rejects(() => moderation.ban(w.guild, { id: '400000000000000088' }, mod, 'raison'), /\/ban\*\* est réservée/);
  await assert.rejects(() => moderation.ban(w.guild, { id: '400000000000000088' }, mod, 'raison', { durationMs: 60_000 }), /\/tempban\*\* est réservée au \*\*niveau 2/);
  assert.deepEqual(calls, []);
  w.config.update(G, { permissions: { strict: false } });
  assert.equal(access.strictActionLevelMissing(w.client, w.guild, mod, 'ban'), 0, 'mode strict coupé');
});

test('S29 menus contextuels : contrôle natif d\'abord, puis le mode strict de la commande reproduite (strictKey)', () => {
  const w = permWorld({ commands: { sanctions: 2 } });
  const ctx = COMMANDS.get('Sanctions du membre');
  assert.equal(ctx.strictKey, 'sanctions');
  assert.equal(COMMANDS.get('Note de modération').strictKey, 'sanctions');
  const mod = w.member(MOD, [], ['ModerateMembers']);
  assert.throws(() => access.assertCommandAccess(w.client, w.menu(mod, 'Sanctions du membre'), ctx, assertMemberPermissions), /\/sanctions\*\* est réservée au \*\*niveau 2/);
  // Sans la permission native : le refus natif (pas le message du mode strict).
  const plain = w.member('400000000000000013', [], []);
  assert.throws(() => access.assertCommandAccess(w.client, w.menu(plain, 'Sanctions du membre'), ctx, assertMemberPermissions), (err) => !/niveau 2/.test(err.message));
  // Rang suffisant, ou mode strict coupé : accès.
  assert.equal(access.assertCommandAccess(w.client, w.menu(w.member(ADMIN, [L3], ['ModerateMembers']), 'Sanctions du membre'), ctx, assertMemberPermissions), null);
  w.config.update(G, { permissions: { strict: false } });
  assert.equal(access.assertCommandAccess(w.client, w.menu(mod, 'Sanctions du membre'), ctx, assertMemberPermissions), null);
});
