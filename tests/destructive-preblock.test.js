'use strict';

/**
 * SEC5 — pré-blocage des destructions faites via le bot : /massrole (rôle sensible, count = nombre
 * de cibles, rôle whitelisté distribué par un non-owner), /logs remove et /compteurs (« Gérer les
 * salons » natif partout, salons récents non comptés, catégorie seulement si elle deviendrait vide),
 * /backup restore (exemption exigée pour tout module salons / rôles actif).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const massrole = require('../src/commands/roles/massrole');
const logs = require('../src/commands/configuration/logs');
const compteurs = require('../src/commands/configuration/compteurs');
const backup = require('../src/commands/configuration/backup');
const { snowflakeAt } = require('./e2e/lib/ids');

const G = '300000000000000001';
const OWNER = '300000000000000002';
const ADMIN = '300000000000000003';
const R_STAFF = '300000000000000010';
const R_PLAIN = '300000000000000011';
const R_WL = '300000000000000012';
const DAY = 86_400_000;

const perms = (bits) => new PermissionsBitField(bits);
function role(id, bits = 0n) {
  return { id, managed: false, permissions: perms(bits), guild: null, toString: () => `<@&${id}>` };
}

function guildWith(channels = []) {
  const cache = new Collection(channels.map((c) => [c.id, c]));
  const guild = { id: G, ownerId: OWNER, channels: { cache }, roles: { cache: new Collection() }, members: { cache: new Collection() } };
  return guild;
}

/** Faux salon : `can` décide si l'auteur y a « Gérer les salons ». */
const chan = (id, { parentId = null, ageMs = 2 * DAY, can = true } = {}) => ({
  id,
  parentId,
  createdTimestamp: Date.now() - ageMs,
  permissionsFor: () => perms(can ? P.ManageChannels | P.ViewChannel : P.ViewChannel),
});

// ---------------------------------------------------------------- /massrole

test('/massrole : rôle non sensible → aucun pré-contrôle ; sensible → roleAdd / roleRemove avec count = nombre de cibles', () => {
  const calls = [];
  const guild = guildWith();
  const staff = role(R_STAFF, P.KickMembers);
  const plain = role(R_PLAIN);
  staff.guild = guild;
  plain.guild = guild;
  const cfg = { whitelist: { users: [], roles: [R_WL] } };
  const secur = { assertAllowed: (ctx, type, opts) => calls.push([type, opts.count]), levelOpts: () => ({}), recordGrant: async () => null };
  const client = { services: { config: { get: () => cfg }, secur } };
  const interaction = { guild, user: { id: ADMIN } };
  assert.deepEqual(massrole.securityCheck(interaction, client, { action: 'add', role: plain, count: 40 }), { type: null, grants: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(massrole.securityCheck(interaction, client, { action: 'remove', role: staff, count: 5 }), { type: 'roleRemove', grants: false });
  assert.deepEqual(massrole.securityCheck(interaction, client, { action: 'add', role: staff, count: 7 }), { type: 'roleAdd', grants: false });
  assert.deepEqual(calls, [['roleRemove', 5], ['roleAdd', 7]]);
  assert.deepEqual(massrole.securityCheck(interaction, client, { action: 'remove', role: staff, count: 0 }), { type: null, grants: false }, 'aucune cible : rien à contrôler');

  // Refus du pré-contrôle : propagé (aucun changement ne doit suivre).
  secur.assertAllowed = () => { throw Object.assign(new Error('Action bloquée par la sécurité (Rôles retirés en masse)'), { isUserError: true }); };
  assert.throws(() => massrole.securityCheck(interaction, client, { action: 'remove', role: staff, count: 5 }), /Action bloquée/);
});

test('/massrole : rôle WHITELISTÉ distribué par un non-owner → accès en attente (10 cibles au plus) ; le propriétaire n\'est pas limité', () => {
  const guild = guildWith();
  const wl = role(R_WL);
  wl.guild = guild;
  const cfg = { whitelist: { users: [], roles: [R_WL] }, secur: { owners: [] } };
  const calls = [];
  const secur = { assertAllowed: (ctx, type, opts) => calls.push([type, opts.count]), levelOpts: () => ({ botOwnerIds: [], trustBotOwners: false, botId: null }), recordGrant: async () => null };
  const client = { services: { config: { get: () => cfg }, secur } };
  const admin = { guild, user: { id: ADMIN } };
  assert.deepEqual(massrole.securityCheck(admin, client, { action: 'add', role: wl, count: 3 }), { type: 'roleAdd', grants: true });
  assert.throws(() => massrole.securityCheck(admin, client, { action: 'add', role: wl, count: massrole.MAX_PENDING_GRANTS + 1 }), /rôle \*\*whitelisté\*\*.*réservé au propriétaire/);
  assert.deepEqual(calls, [['roleAdd', 3]], 'refus « whitelisté » levé AVANT le pré-contrôle');
  const owner = { guild, user: { id: OWNER } };
  assert.deepEqual(massrole.securityCheck(owner, client, { action: 'add', role: wl, count: 50 }), { type: 'roleAdd', grants: false });
  assert.deepEqual(massrole.securityCheck(admin, client, { action: 'remove', role: wl, count: 50 }), { type: 'roleRemove', grants: false }, 'retrait : aucun accès à suivre');
});

// ---------------------------------------------------------------- /logs remove

test('/logs remove : plan — salons créés présents, catégorie seulement si elle deviendrait vide, salons récents non comptés', () => {
  const cat = snowflakeAt(Date.now() - 3 * DAY);
  const a = chan('300000000000000101', { parentId: cat });
  const b = chan('300000000000000102', { parentId: cat, ageMs: 60_000 });
  const mine = chan('300000000000000103', { parentId: cat });
  const category = chan(cat);
  const guild = guildWith([a, b, mine, category]);
  const cfg = { logs: { createdChannels: [a.id, b.id, '300000000000000199'], categoryId: cat } };
  const client = { services: { config: { get: () => cfg } } };
  let plan = logs.removalPlan(client, guild);
  assert.deepEqual(plan.channels.map((c) => c.id), [a.id, b.id], 'catégorie supprimée alors qu\'elle garde un salon de l\'utilisateur');
  assert.equal(plan.counted, 1, 'salon tout juste créé compté');
  guild.channels.cache.delete(mine.id);
  plan = logs.removalPlan(client, guild);
  assert.deepEqual(plan.channels.map((c) => c.id), [a.id, b.id, cat]);
  assert.equal(plan.counted, 2);
});

test('/logs remove : « Gérer les salons » NATIF exigé au niveau du serveur ET dans chaque salon, sinon refus qui liste les salons', () => {
  const a = chan('300000000000000201');
  const b = chan('300000000000000202', { can: false });
  const member = { permissions: perms(P.ManageGuild) };
  assert.throws(() => logs.assertNativeManageChannels({ member }, [a]), /Gérer les salons.*au niveau du serveur/);
  member.permissions = perms(P.ManageGuild | P.ManageChannels);
  assert.throws(() => logs.assertNativeManageChannels({ member }, [a, b]), new RegExp(`<#${b.id}>.*aucun salon n'a été supprimé`));
  assert.doesNotThrow(() => logs.assertNativeManageChannels({ member }, [a]));
  // Administrateur : implique « Gérer les salons ».
  assert.doesNotThrow(() => logs.assertNativeManageChannels({ member: { permissions: perms(P.Administrator) } }, [a]));
  // Membre non résolu : repli sur les permissions natives de l'interaction (jamais une délégation).
  assert.throws(() => logs.assertNativeManageChannels({ member: null, memberPermissions: perms(P.ManageGuild) }, []), /Gérer les salons/);
});

// ---------------------------------------------------------------- /compteurs

test('/compteurs : plan de suppression — un compteur, ou tous plus la catégorie vide ; salons récents non comptés', () => {
  const cat = '300000000000000300';
  const m = chan('300000000000000301', { parentId: cat });
  const h = chan('300000000000000302', { parentId: cat, ageMs: 30_000 });
  const guild = guildWith([m, h, chan(cat)]);
  const cfg = { categoryId: cat, counters: { members: { channelId: m.id }, humans: { channelId: h.id }, bots: { channelId: '300000000000000399' } } };
  const client = { services: { counters: { cfg: () => cfg } } };
  const one = compteurs.deletionPlan(client, guild, 'members');
  assert.deepEqual(one.channels.map((c) => c.id), [m.id]);
  assert.equal(one.counted.length, 1);
  const all = compteurs.deletionPlan(client, guild);
  assert.deepEqual(all.channels.map((c) => c.id), [m.id, h.id, cat]);
  assert.deepEqual(all.counted.map((c) => c.id), [m.id, cat], 'compteur créé il y a 30 s compté');
});

// ---------------------------------------------------------------- /backup restore

test('/backup restore : bloquée si un module Secur salons / rôles est actif et que l\'auteur n\'en est pas exempté (log « Restauration bloquée »)', () => {
  const logged = [];
  let active = new Set();
  let level = 'membre';
  const cfg = { secur: { modules: { channelDelete: { mode: 'on' }, roleDelete: { mode: 'max' }, ban: { mode: 'on' } } } };
  const client = {
    services: {
      config: { get: () => cfg },
      logging: { send: async (...a) => { logged.push(a); } },
      secur: { covers: (gid, key) => active.has(key), levelOf: () => level },
    },
  };
  const interaction = { client, guild: { id: G, members: { cache: new Collection() } }, user: { id: ADMIN, bot: false }, member: null };
  active = new Set(['ban']);
  assert.doesNotThrow(() => backup.assertRestoreAllowed(interaction), 'module membres : sans rapport avec la restauration');
  active = new Set(['ban', 'channelDelete']);
  assert.throws(() => backup.assertRestoreAllowed(interaction), /Restauration bloquée par la sécurité : les modules Secur Suppression de salons sont actifs/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], 'security');
  assert.match(JSON.stringify(logged[0][2].toJSON?.() ?? logged[0][2]), /Restauration bloquée/);
  level = 'whitelist';
  assert.doesNotThrow(() => backup.assertRestoreAllowed(interaction), 'whitelisté exempté en on');
  active = new Set(['channelDelete', 'roleDelete']);
  assert.throws(() => backup.assertRestoreAllowed(interaction), /Suppression de rôles/, 'max : la whitelist ne suffit pas');
  level = 'owner';
  assert.doesNotThrow(() => backup.assertRestoreAllowed(interaction));
  // Sans Secur (service absent) : rien n'est bloqué.
  assert.doesNotThrow(() => backup.assertRestoreAllowed({ ...interaction, client: { services: {} } }));
});
