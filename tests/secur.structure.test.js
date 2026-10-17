'use strict';

/**
 * SEC4 — modules Secur « Structure » : planificateurs purs, instantanés bornés, report des
 * identifiants (idMap), rôles gérés jamais recréés, prédicat de rôle sensible, ordre audit /
 * événement, types de salons jamais recréés, écouteurs prepend.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const S = require('../src/utils/secur');
const St = require('../src/services/secur/structure');
const { SecurRegistry } = require('../src/services/secur/registry');
const { defaultGuildConfig } = require('../src/config/defaults');

const MODULES_DIR = path.join(__dirname, '..', 'src', 'services', 'secur', 'modules');
const byKey = Object.fromEntries([].concat(...['channels', 'roles', 'server', 'webhooks', 'expressions'].map((f) => [].concat(require(path.join(MODULES_DIR, `${f}.js`))))).map((m) => [m.key, m]));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Collection minimale (Map + some). */
function coll(list = []) {
  const m = new Map(list.map((x) => [x.id, x]));
  m.some = (fn) => [...m.values()].some(fn);
  return m;
}
const bits = (n) => ({ bitfield: BigInt(n) });

/** Serveur factice (cache seulement). */
function makeGuild({ channels = [], roles = [], members = [], features = [], me = null } = {}) {
  const guild = { id: 'g1', ownerId: 'owner', features, maximumBitrate: 96_000, channels: { cache: coll(channels) }, roles: { cache: coll(roles) }, members: { cache: coll(members), me }, emojis: { cache: coll() }, stickers: { cache: coll() } };
  for (const x of [...channels, ...roles, ...members]) x.guild = guild;
  return guild;
}
function makeChannel(id, { name = id, type = 0, parentId = null, overwrites = [] } = {}) {
  return {
    id, name, type, parentId, rawPosition: 3, topic: 'sujet', nsfw: false, rateLimitPerUser: 0,
    isThread: () => false,
    permissionOverwrites: { cache: coll(overwrites.map((o) => ({ id: o.id, type: o.type ?? 0, allow: bits(o.allow ?? 0), deny: bits(o.deny ?? 0) }))) },
  };
}
function makeClient({ tickets = [], cfg = clone(defaultGuildConfig) } = {}) {
  return {
    user: { id: 'bot' },
    repositories: {
      tickets: { getByChannel: (id) => (tickets.includes(id) ? { channel_id: id } : undefined) },
      modmail: { getByChannel: () => undefined },
      tempVoice: { get: () => undefined },
    },
    services: { config: { get: () => cfg } },
  };
}
const ctxFor = (client, key, cfg = client.services.config.get('g1'), extra = {}) => ({ client, service: { open: new Map() }, cfg, moduleCfg: S.moduleConfig(cfg, key), at: Date.now(), ...extra });

/* -------------------------------------------------------------------- */
/* Registre                                                               */
/* -------------------------------------------------------------------- */

test('registre : les 5 fichiers de SEC4 chargent 11 modules déclarés, sans échec', () => {
  const registry = new SecurRegistry().load(MODULES_DIR);
  assert.deepEqual(registry.failures, []);
  const mine = ['channelCreate', 'channelDelete', 'channelUpdate', 'roleCreate', 'roleDelete', 'roleUpdate', 'roleAdd', 'roleRemove', 'webhook', 'serverUpdate', 'expressions'];
  for (const key of mine) assert.ok(registry.has(key), `${key} non chargé`);
  assert.equal(registry.forType(25).length >= 2, true, 'roleAdd et roleRemove partagent l\'audit 25');
  assert.deepEqual(registry.get('expressions').auditTypes, [62, 92]);
  for (const key of mine) {
    const mod = registry.get(key);
    assert.equal(typeof mod.undo, 'function');
    assert.equal(typeof mod.describe, 'function');
    assert.equal(typeof mod.targetKey, 'function');
  }
});

/* -------------------------------------------------------------------- */
/* Planificateurs purs                                                    */
/* -------------------------------------------------------------------- */

test('diff de permissions : bits gagnés, permission DANGEROUS, surcharge à risque', () => {
  assert.equal(St.gainedBits(P.ViewChannel, P.ViewChannel | P.SendMessages), P.SendMessages);
  assert.equal(St.gainedBits(P.Administrator, 0n), 0n);
  assert.equal(St.grantsDangerous('0', String(P.Administrator)), true);
  assert.equal(St.grantsDangerous(String(P.KickMembers), String(P.KickMembers | P.SendMessages)), false, 'permission déjà présente');
  assert.equal(St.grantsDangerous('0', String(P.AddReactions)), false);
  assert.equal(St.overwriteRisk({ before: null, after: { allow: String(P.ManageRoles), deny: '0' } }), true);
  assert.equal(St.overwriteRisk({ before: null, after: { allow: String(P.AttachFiles), deny: '0' } }), false);
  assert.equal(St.overwriteRisk({ isEveryone: true, before: { allow: '0', deny: String(P.ViewChannel) }, after: { allow: '0', deny: '0' } }), true, 'refus « Voir » d\'@everyone retiré');
  assert.equal(St.overwriteRisk({ isEveryone: true, before: { allow: '0', deny: String(P.ViewChannel) }, after: null }), true, 'surcharge d\'@everyone supprimée');
  assert.equal(St.overwriteRisk({ isEveryone: false, before: { allow: '0', deny: String(P.ViewChannel) }, after: null }), false, 'refus d\'un autre rôle : bénin');
  assert.equal(St.overwriteRisk({ isEveryone: true, before: { allow: '0', deny: String(P.AddReactions) }, after: { allow: '0', deny: '0' } }), false);
});

test('filtres ignoreBenign (salons) et dangerousOnly (rôles) : « on » ne garde que le sensible, « max » tout', () => {
  const ch = [{ key: 'topic', old: 'a', new: 'b' }, { key: 'name', old: 'général', new: 'pirate' }, { key: 'nsfw', old: false, new: false }, { key: 'available_tags', old: [], new: [{ name: 'x' }] }, { key: 'position', old: 1, new: 2 }];
  assert.deepEqual(St.filterChannelChanges(ch, { lenient: true }).map((c) => c.key), ['name']);
  assert.deepEqual(St.filterChannelChanges(ch, { lenient: false }).map((c) => c.key), ['topic', 'name', 'available_tags'], 'position ignorée, valeur inchangée ignorée');
  const role = [{ key: 'color', old: 1, new: 2 }, { key: 'permissions', old: '0', new: String(P.SendMessages) }];
  assert.deepEqual(St.filterRoleChanges(role, { lenient: true }), [], 'aucun bit DANGEROUS gagné');
  assert.deepEqual(St.filterRoleChanges([...role, { key: 'permissions', old: '0', new: String(P.BanMembers) }], { lenient: true }).map((c) => c.new), [String(P.BanMembers)]);
  assert.deepEqual(St.filterRoleChanges(role, { lenient: false }).map((c) => c.key), ['color', 'permissions']);
  // isLenient : option à vrai ET mode « on » ; le mode « max » est toujours strict.
  const cfg = clone(defaultGuildConfig);
  cfg.secur.modules.channelUpdate.mode = 'on';
  assert.equal(St.isLenient({ cfg, moduleCfg: S.moduleConfig(cfg, 'channelUpdate') }, 'channelUpdate', 'ignoreBenign'), true);
  cfg.secur.modules.channelUpdate.mode = 'max';
  assert.equal(St.isLenient({ cfg, moduleCfg: S.moduleConfig(cfg, 'channelUpdate') }, 'channelUpdate', 'ignoreBenign'), false);
});

test('serveur : clés restaurables, images au mieux, alertes seules, le reste ignoré ; adresse CDN de l\'ancien hash', () => {
  const plan = St.planServerRestore([
    { key: 'name', old: 'A', new: 'B' },
    { key: 'verification_level', old: 2, new: 0 },
    { key: 'icon_hash', old: 'abc12345', new: 'def67890' },
    { key: 'vanity_url_code', old: 'moi', new: 'pirate' },
    { key: 'mfa_level', old: 1, new: 0 },
    { key: 'widget_enabled', old: false, new: true },
    { key: 'description', old: 'x', new: 'x' },
  ]);
  assert.deepEqual(plan.restore.map((c) => c.key), ['name', 'verification_level']);
  assert.deepEqual(plan.images.map((c) => [c.key, c.field]), [['icon_hash', 'icon']]);
  assert.deepEqual(plan.alertOnly.map((c) => c.key), ['vanity_url_code', 'mfa_level']);
  assert.equal(St.guildImageUrl('g1', 'icon', 'abc12345'), 'https://cdn.discordapp.com/icons/g1/abc12345.png?size=4096');
  assert.equal(St.guildImageUrl('g1', 'icon', 'a_abc12345'), 'https://cdn.discordapp.com/icons/g1/a_abc12345.gif?size=4096');
  assert.equal(St.guildImageUrl('g1', 'banner', '../../etc'), null, 'hash invalide refusé');
  assert.equal(byKey.serverUpdate.classify({ changes: [{ key: 'widget_enabled', old: false, new: true }] }), null);
});

test('recréation : charge utile du salon (type 13 sans communauté, débit borné) et du rôle (permissions du bot, position sous lui, emoji avec ROLE_ICONS)', () => {
  const stage = St.buildChannelCreate({ name: 'conf', type: 13, bitrate: 384_000, userLimit: 50, topic: 'non', position: 4 }, { community: false, maximumBitrate: 96_000, parentId: 'cat' });
  assert.equal(stage.type, 2);
  assert.equal(stage.bitrate, 96_000);
  assert.equal(stage.topic, undefined, 'sujet d\'un vocal');
  assert.equal(stage.parent, 'cat');
  assert.equal(St.buildChannelCreate({ name: 'cat', type: 4 }).parent, undefined, 'catégorie avec parent');
  const role = St.buildRoleCreate({ name: 'Staff', permissions: String(P.Administrator | P.KickMembers | P.SendMessages), position: 9, unicodeEmoji: '🛡️', colors: { primary: 5 } }, { botAdmin: false, botPermissions: P.KickMembers | P.SendMessages, roleIcons: false, maxPosition: 4 });
  assert.equal(role.permissions, P.KickMembers | P.SendMessages, 'permissions au-delà de celles du bot');
  assert.equal(role.position, 4);
  assert.equal(role.unicodeEmoji, undefined);
  assert.deepEqual(role.colors, { primaryColor: 5 });
  assert.equal('color' in role, false, '« color » est déprécié');
  assert.equal(St.buildRoleCreate({ name: 'x', permissions: String(P.Administrator), unicodeEmoji: '🛡️' }, { botAdmin: true, roleIcons: true }).unicodeEmoji, '🛡️');
});

test('idMap appliquée aux surcharges : cibles recréées reportées, disparues ignorées, bits limités au masque du bot', () => {
  const idMap = new Map([['oldRole', 'newRole']]);
  const live = new Set(['newRole', 'everyone', 'user1']);
  const resolve = (id) => {
    const mapped = idMap.get(id) ?? id;
    return live.has(mapped) ? mapped : null;
  };
  const out = St.mapOverwrites([
    { id: 'oldRole', type: 0, allow: String(P.ViewChannel | P.ManageRoles), deny: '0' },
    { id: 'gone', type: 0, allow: '1', deny: '0' },
    { id: 'everyone', type: 0, allow: '0', deny: String(P.ViewChannel) },
    { id: 'user1', type: 1, allow: String(P.SendMessages), deny: '0' },
  ], resolve, P.ViewChannel | P.SendMessages);
  assert.deepEqual(out.map((o) => o.id), ['newRole', 'everyone', 'user1']);
  assert.equal(out[0].allow, P.ViewChannel, 'bit hors masque conservé');
  assert.equal(out[1].deny, P.ViewChannel);
  assert.equal(out[2].type, 1);
});

/* -------------------------------------------------------------------- */
/* Instantanés bornés                                                     */
/* -------------------------------------------------------------------- */

test('instantanés bornés : 500 par serveur (les plus anciens sortent), 120 s ; orphelins et surcharges 30 s ; serveur oublié', () => {
  let now = 1_000_000;
  const store = new St.StructureStore({ now: () => now });
  for (let i = 0; i < St.MAX_SNAPSHOTS + 20; i += 1) store.put('g1', 'channel', `c${i}`, { id: `c${i}` });
  assert.equal(store.count('g1'), St.MAX_SNAPSHOTS);
  assert.equal(store.get('g1', 'channel', 'c0'), null, 'le plus ancien gardé');
  assert.ok(store.get('g1', 'channel', `c${St.MAX_SNAPSHOTS + 19}`));
  now += St.SNAPSHOT_TTL_MS;
  assert.equal(store.get('g1', 'channel', `c${St.MAX_SNAPSHOTS + 19}`), null, 'instantané expiré servi');
  store.noteOrphan('g1', 'child', 'cat');
  store.noteRemovedOverwrite('g1', 'chan', { id: 'role', allow: '1', deny: '0' });
  store.setRemap('g1', 'old', 'new');
  store.markDeleted('g1', 'cat', 'u1');
  assert.deepEqual(store.orphansOf('g1', 'cat'), ['child']);
  assert.equal(store.orphanParentOf('g1', 'child'), 'cat');
  assert.equal(store.removedOverwritesOf('g1', 'role').length, 1);
  assert.equal(store.remapOf('g1', 'old'), 'new');
  assert.equal(store.deletedBy('g1', 'cat'), 'u1');
  now += St.BUFFER_TTL_MS;
  assert.deepEqual(store.orphansOf('g1', 'cat'), []);
  assert.equal(store.removedOverwritesOf('g1', 'role').length, 0);
  assert.equal(store.remapOf('g1', 'old'), 'new', 'report gardé 120 s');
  const small = new St.StructureStore({ now: () => now, maxBuffered: 3, maxGuilds: 2 });
  for (let i = 0; i < 10; i += 1) small.noteOrphan('g1', `o${i}`, 'cat');
  assert.equal(small.orphansOf('g1', 'cat').length, 3, 'orphelins non bornés');
  small.put('g2', 'role', 'r', {});
  small.put('g3', 'role', 'r', {});
  assert.equal(small.guilds.size, 2, 'serveurs non bornés');
  small.forgetGuild('g3');
  assert.equal(small.get('g3', 'role', 'r'), null);
});

test('instantané d\'un rôle : membres lus dans member._roles (discord.js ne les nettoie pas), surcharges du cache et du tampon', () => {
  const store = new St.StructureStore();
  const role = { id: 'r1', name: 'Staff', permissions: bits(P.KickMembers), colors: { primaryColor: 7 }, rawPosition: 4, tags: null };
  const members = [{ id: 'm1', _roles: ['r1'] }, { id: 'm2', _roles: [] }, { id: 'm3', _roles: ['x', 'r1'] }];
  const guild = makeGuild({ roles: [], members, channels: [makeChannel('c1', { overwrites: [{ id: 'r1', allow: P.ViewChannel }] }), makeChannel('c2')] });
  role.guild = guild;
  store.noteRemovedOverwrite('g1', 'c2', { id: 'r1', allow: String(P.SendMessages), deny: '0' });
  const snap = St.captureRole(makeClient(), role, store);
  assert.deepEqual(snap.members, ['m1', 'm3']);
  assert.deepEqual(snap.overwrites.map((o) => o.channelId).sort(), ['c1', 'c2']);
  assert.equal(snap.permissions, String(P.KickMembers));
  assert.equal(snap.colors.primary, 7);
});

/* -------------------------------------------------------------------- */
/* Rôles gérés, rôle sensible                                             */
/* -------------------------------------------------------------------- */

test('rôles gérés (bot, intégration, booster, abonnement) jamais recréés ; rôle géré supprimé jamais compté', async () => {
  const base = { managed: false, tags: {} };
  assert.equal(St.protectedRoleKind({ ...base, managed: true }), 'managed');
  assert.equal(St.protectedRoleKind({ ...base, tags: { botId: '1' } }), 'managed');
  assert.equal(St.protectedRoleKind({ ...base, tags: { integrationId: '1' } }), 'managed');
  assert.equal(St.protectedRoleKind({ ...base, tags: { premiumSubscriberRole: true } }), 'managed');
  assert.equal(St.protectedRoleKind({ ...base, tags: { subscriptionListingId: '1' } }), 'subscription');
  assert.equal(St.protectedRoleKind({ ...base, tags: { availableForPurchase: true } }), 'subscription');
  assert.equal(St.protectedRoleKind({ ...base, tags: { guildConnections: true } }), 'subscription');
  assert.equal(St.protectedRoleKind(base), null);

  const client = makeClient();
  const guild = makeGuild();
  const store = St.storeFor(client);
  store.put('g1', 'role', 'botrole', { id: 'botrole', name: 'AutreBot', managed: true, tags: { botId: 'b' }, source: 'cache' });
  assert.equal(byKey.roleDelete.classify({ action: 32, targetId: 'botrole', executorId: 'u1', changes: [] }, guild, ctxFor(client, 'roleDelete')), null, 'rôle géré compté');
  store.put('g1', 'role', 'sub', { id: 'sub', name: 'Abonnés', managed: false, tags: { subscriptionListingId: 's' }, source: 'cache' });
  const res = byKey.roleDelete.classify({ action: 32, targetId: 'sub', executorId: 'u1', changes: [] }, guild, ctxFor(client, 'roleDelete'));
  assert.ok(res, 'rôle d\'abonnement supprimé : compté');
  let created = 0;
  guild.roles.create = async () => { created += 1; };
  const undo = await byKey.roleDelete.undo(guild, res.record, ctxFor(client, 'roleDelete', undefined, { idMap: new Map() }));
  assert.equal(undo.ok, false);
  assert.match(undo.note, /jamais recréé : rôle d'abonnement/);
  const none = await byKey.roleDelete.undo(guild, { roleId: 'inconnu', name: 'Fantôme', snapshot: null }, ctxFor(client, 'roleDelete', undefined, { idMap: new Map() }));
  assert.match(none.note, /jamais recréé : aucun instantané/);
  assert.equal(created, 0);
});

test('isSensitiveRole : un rôle de niveau 1 n\'est pas sensible (niveau 2 oui) ; roleAdd ne sanctionne pas un rôle de niveau 1', () => {
  const levelOf = (_g, id) => ({ lvl1: 1, lvl2: 2 }[id] ?? 0);
  const plain = (id) => ({ id, permissions: bits(0n), guild: { id: 'g1', channels: { cache: coll() } } });
  assert.equal(S.isSensitiveRole(plain('lvl1'), {}, { levelOf }), false);
  assert.equal(S.isSensitiveRole(plain('lvl2'), {}, { levelOf }), true);
  const client = makeClient();
  client.services.permissions = { levelOf };
  const roles = ['lvl1', 'lvl2'].map((id) => ({ id, name: id, managed: false, permissions: { any: () => false } }));
  const guild = makeGuild({ roles });
  const entry = (id) => ({ action: 25, targetId: 'm1', executorId: 'u1', changes: [{ key: '$add', new: [{ id, name: id }] }] });
  assert.equal(byKey.roleAdd.classify(entry('lvl1'), guild, ctxFor(client, 'roleAdd')), null);
  assert.deepEqual(byKey.roleAdd.classify(entry('lvl2'), guild, ctxFor(client, 'roleAdd')).record.roles, ['lvl2']);
  // Rôle de whitelist sans permission dangereuse : laissé aux accès en attente de SEC1.
  const cfg = clone(defaultGuildConfig);
  cfg.whitelist.roles = ['wl'];
  const wl = makeGuild({ roles: [{ id: 'wl', name: 'wl', managed: false, permissions: { any: () => false } }] });
  assert.equal(byKey.roleAdd.classify(entry('wl'), wl, ctxFor(makeClient({ cfg }), 'roleAdd', cfg)), null);
  // roleRemove : retirer ce rôle à un tiers (dérank du staff) compte ; à soi-même, non.
  const removal = { action: 25, targetId: 'm1', executorId: 'u1', changes: [{ key: '$remove', new: [{ id: 'wl' }] }] };
  assert.ok(byKey.roleRemove.classify(removal, wl, ctxFor(makeClient({ cfg }), 'roleRemove', cfg)));
  assert.equal(byKey.roleRemove.classify({ ...removal, targetId: 'u1' }, wl, ctxFor(makeClient({ cfg }), 'roleRemove', cfg)), null);
  // Rôles retirés AU BOT : compté d'emblée au seuil.
  const toBot = byKey.roleRemove.classify({ ...removal, targetId: 'bot' }, wl, ctxFor(makeClient({ cfg }), 'roleRemove', cfg));
  assert.equal(toBot.weight, S.effectiveLimit(cfg, 'roleRemove'));
  assert.equal(toBot.record.bot, true);
});

/* -------------------------------------------------------------------- */
/* Ordre audit / événement, types jamais recréés                          */
/* -------------------------------------------------------------------- */

test('audit reçu AVANT l\'événement → instantané pris dans le cache (et le type en base) ; l\'événement suivant ne le dégrade pas', () => {
  const client = makeClient();
  const channel = makeChannel('c1', { name: 'annonces', parentId: 'cat', overwrites: [{ id: 'g1', deny: P.ViewChannel }] });
  const guild = makeGuild({ channels: [channel] });
  const ctx = ctxFor(client, 'channelDelete');
  const res = byKey.channelDelete.classify({ action: 12, targetId: 'c1', executorId: 'u1', changes: [] }, guild, ctx);
  assert.equal(res.record.snapshot.source, 'cache');
  assert.equal(res.record.snapshot.kind, 'normal');
  assert.equal(res.record.snapshot.parentId, 'cat');
  assert.equal(res.record.snapshot.overwrites[0].deny, String(P.ViewChannel));
  assert.equal(St.storeFor(client).get('g1', 'channel', 'c1'), res.record.snapshot);
  assert.equal(St.storeFor(client).deletedBy('g1', 'c1'), 'u1');
  // Ni cache ni instantané : changes en dernier recours, type indéterminable (jamais recréé).
  const late = byKey.channelDelete.classify({ action: 12, targetId: 'c9', executorId: 'u1', changes: [{ key: 'name', old: 'perdu' }, { key: 'type', old: 0 }] }, makeGuild(), ctxFor(makeClient(), 'channelDelete'));
  assert.equal(late.record.snapshot.source, 'audit');
  assert.equal(late.record.snapshot.kind, null);
  // Rôle : audit avant l'événement → rôle, membres et surcharges encore en cache.
  const role = { id: 'r1', name: 'Staff', permissions: bits(P.ManageChannels), colors: { primaryColor: 0 }, rawPosition: 2, managed: false, tags: null };
  const g2 = makeGuild({ roles: [role], members: [{ id: 'm1', _roles: ['r1'] }] });
  const c2 = makeClient();
  const r = byKey.roleDelete.classify({ action: 32, targetId: 'r1', executorId: 'u1', changes: [] }, g2, ctxFor(c2, 'roleDelete'));
  assert.deepEqual(r.record.snapshot.members, ['m1']);
  // Emoji : audit avant l'événement → pris dans le cache.
  const g3 = makeGuild();
  g3.emojis.cache.set('e1', { id: 'e1', name: 'gadget', animated: false, roles: { cache: new Map() } });
  const e = byKey.expressions.classify({ action: 62, targetId: 'e1', executorId: 'u1', changes: [] }, g3, ctxFor(makeClient(), 'expressions'));
  assert.equal(e.record.snapshot.url, 'https://cdn.discordapp.com/emojis/e1.png');
});

test('type ticket (ou indéterminable) → jamais recréé ; type déterminé en base et en configuration', async () => {
  const cfg = clone(defaultGuildConfig);
  cfg.statsCounters = { categoryId: null, counters: { members: { enabled: true, channelId: 'cnt' } } };
  const client = makeClient({ tickets: ['t1'], cfg });
  assert.equal(St.channelKind(client, { id: 't1', guild: { id: 'g1' } }), 'ticket');
  assert.equal(St.channelKind(client, { id: 'cnt', guild: { id: 'g1' } }), 'compteur');
  assert.equal(St.channelKind(client, { id: 'x', guild: { id: 'g1' }, isThread: () => true }), 'fil');
  assert.equal(St.channelKind(client, { id: 'x', guild: { id: 'g1' } }, { never: { applications: 1 } }), 'entretien');
  assert.equal(St.channelKind({ services: {} }, { id: 'x', guild: { id: 'g1' } }), null, 'sans base : indéterminable');
  const guild = makeGuild({ me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } });
  let created = 0;
  guild.channels.create = async () => { created += 1; return { id: 'new' }; };
  for (const kind of ['ticket', 'modmail', 'tempvoice', 'compteur', null]) {
    const res = await byKey.channelDelete.undo(guild, { channelId: 'c', snapshot: { id: 'c', name: 'x', type: 0, kind } }, ctxFor(client, 'channelDelete', cfg, { idMap: new Map() }));
    assert.equal(res.ok, false);
    assert.match(res.note, /jamais recréé/);
  }
  assert.equal(created, 0, 'salon recréé');
});

test('recréation : plafond de 50 salons par incident ; catégorie supprimée par le même auteur recréée d\'abord', async () => {
  const client = makeClient();
  const calls = [];
  const guild = makeGuild({ me: { permissions: { has: () => true } } });
  guild.channels.create = async (opts) => {
    const id = `new-${calls.length}`;
    calls.push(opts);
    guild.channels.cache.set(id, { id, name: opts.name, parentId: opts.parent ?? null, guild });
    return { id };
  };
  const store = St.storeFor(client);
  store.put('g1', 'channel', 'cat', { id: 'cat', name: 'Catégorie', type: 4, kind: 'normal', overwrites: [], children: [] });
  store.markDeleted('g1', 'cat', 'u1');
  const ctx = ctxFor(client, 'channelDelete', undefined, { idMap: new Map() });
  const child = await byKey.channelDelete.undo(guild, { channelId: 'c1', executorId: 'u1', snapshot: { id: 'c1', name: 'enfant', type: 0, parentId: 'cat', kind: 'normal', overwrites: [] } }, ctx);
  assert.equal(child.ok, true);
  assert.equal(calls[0].type, 4, 'catégorie non recréée d\'abord');
  assert.equal(calls[1].parent, 'new-0');
  const again = await byKey.channelDelete.undo(guild, { channelId: 'cat', executorId: 'u1', snapshot: store.get('g1', 'channel', 'cat') }, ctx);
  assert.equal(again.ok, true);
  assert.equal(calls.length, 2, 'catégorie recréée deux fois');
  // Un autre auteur : la catégorie n'est pas recréée pour lui.
  const other = await byKey.channelDelete.undo(guild, { channelId: 'c2', executorId: 'u2', snapshot: { id: 'c2', name: 'x', type: 0, parentId: 'cat2', kind: 'normal', overwrites: [] } }, ctx);
  assert.equal(other.ok, true);
  assert.equal(calls[2].parent, null);
  for (let i = 3; i < St.MAX_CHANNEL_RECREATIONS; i += 1) await byKey.channelDelete.undo(guild, { channelId: `z${i}`, snapshot: { id: `z${i}`, name: 'z', type: 0, kind: 'normal', overwrites: [] } }, ctx);
  assert.equal(calls.length, St.MAX_CHANNEL_RECREATIONS);
  const over = await byKey.channelDelete.undo(guild, { channelId: 'last', snapshot: { id: 'last', name: 'z', type: 0, kind: 'normal', overwrites: [] } }, ctx);
  assert.match(over.note, /Plafond de 50 recréations/);
});

/* -------------------------------------------------------------------- */
/* Autres classements                                                     */
/* -------------------------------------------------------------------- */

test('webhooks : suivi toléré en « on », supprimé en « max » ; modification comptée en « max » seulement ; suppression : sanction seule', async () => {
  const cfg = clone(defaultGuildConfig);
  const client = makeClient({ cfg });
  const guild = makeGuild();
  const entry = (action, type) => ({ action, targetId: 'w1', executorId: 'u1', changes: [{ key: 'type', [action === 52 ? 'old' : 'new']: type }] });
  cfg.secur.modules.webhook.mode = 'on';
  assert.equal(byKey.webhook.classify(entry(50, 2), guild, ctxFor(client, 'webhook', cfg)), null);
  assert.ok(byKey.webhook.classify(entry(50, 1), guild, ctxFor(client, 'webhook', cfg)));
  assert.equal(byKey.webhook.classify(entry(51, 1), guild, ctxFor(client, 'webhook', cfg)), null);
  const del = byKey.webhook.classify(entry(52, 1), guild, ctxFor(client, 'webhook', cfg));
  assert.equal(del.record.sanctionOnly, true);
  const res = await byKey.webhook.undo(guild, del.record, ctxFor(client, 'webhook', cfg, { idMap: new Map() }));
  assert.equal(res.ok, false);
  Object.assign(cfg.secur.modules.webhook, S.presetPatch('max', defaultGuildConfig.secur.modules).webhook);
  assert.ok(byKey.webhook.classify(entry(50, 2), guild, ctxFor(client, 'webhook', cfg)));
  assert.ok(byKey.webhook.classify(entry(51, 1), guild, ctxFor(client, 'webhook', cfg)));
});

test('surcharges (13/14/15) en « on » : seules celles à risque comptent ; avant / après reconstitués', () => {
  const cfg = clone(defaultGuildConfig);
  cfg.secur.modules.channelUpdate.mode = 'on';
  const client = makeClient({ cfg });
  const channel = makeChannel('c1', { overwrites: [{ id: 'r1', allow: P.ViewChannel | P.ManageRoles }] });
  const guild = makeGuild({ channels: [channel] });
  const ctx = ctxFor(client, 'channelUpdate', cfg);
  const benign = { action: 13, targetId: 'c1', executorId: 'u1', extra: { id: 'r2', type: '0' }, changes: [{ key: 'id', new: 'r2' }, { key: 'type', new: 0 }, { key: 'allow', new: String(P.AttachFiles) }, { key: 'deny', new: '0' }] };
  assert.equal(byKey.channelUpdate.classify(benign, guild, ctx), null);
  const risky = { action: 14, targetId: 'c1', executorId: 'u1', extra: { id: 'r1', type: '0' }, changes: [{ key: 'allow', old: String(P.ViewChannel), new: String(P.ViewChannel | P.ManageRoles) }] };
  const res = byKey.channelUpdate.classify(risky, guild, ctx);
  assert.deepEqual(res.record.before, { allow: String(P.ViewChannel), deny: '0' });
  assert.deepEqual(res.record.after, { allow: String(P.ViewChannel | P.ManageRoles), deny: '0' });
  assert.equal(res.record.targetType, 0);
  const opened = { action: 15, targetId: 'c1', executorId: 'u1', extra: { id: 'g1', type: '0' }, changes: [{ key: 'id', old: 'g1' }, { key: 'type', old: 0 }, { key: 'allow', old: '0' }, { key: 'deny', old: String(P.ViewChannel) }] };
  const open = byKey.channelUpdate.classify(opened, guild, ctx);
  assert.ok(open, 'surcharge d\'@everyone supprimée : non comptée');
  assert.equal(open.record.after, null);
  assert.equal(open.record.isEveryone, true);
});

test('notes d\'incident : une ligne de synthèse par type, mise à jour sur place ; plafond du moteur (8 lignes) respecté', () => {
  const idMap = new Map();
  const state = { idMap, details: ['déjà là'] };
  const ctx = { idMap, service: { open: new Map([['g1:u1', state]]) } };
  for (let i = 0; i < 3; i += 1) St.noteSummary(ctx, 'channels', (d) => { d.n = (d.n ?? 0) + 1; }, (d) => `Salons recréés : ${d.n}`);
  assert.deepEqual(state.details, ['déjà là', 'Salons recréés : 3']);
  state.details.push(...Array.from({ length: 6 }, (_, i) => `x${i}`));
  St.noteSummary(ctx, 'roles', () => {}, () => 'Rôles recréés : 1');
  assert.equal(state.details.length, 8, 'plafond de 8 lignes dépassé');
  assert.equal(St.takeBudget({ idMap }, 'k', 1), true);
  assert.equal(St.takeBudget({ idMap }, 'k', 1), false);
});

test('références de configuration : chemins capturés rebranchés (ancien identifiant ou débranché à null), le reste intact', () => {
  let stored = { logChannels: { security: null, moderation: 'old', messages: 'other' }, antiraid: { alertChannel: 'old' }, keep: 'old2' };
  const config = {
    repo: { get: () => stored },
    update: (_g, patch) => { stored = { ...stored, ...patch }; },
  };
  const done = St.replugConfig(config, 'g1', ['logChannels.security', 'logChannels.moderation', 'antiraid.alertChannel', 'logChannels.messages'], 'old', 'new');
  assert.deepEqual(done.sort(), ['antiraid.alertChannel', 'logChannels.moderation', 'logChannels.security']);
  assert.deepEqual(stored.logChannels, { security: 'new', moderation: 'new', messages: 'other' });
  assert.equal(stored.keep, 'old2');
  assert.deepEqual(St.replugConfig(config, 'g1', ['keep'], 'zzz', 'new', { nulls: false }), []);
});

/* -------------------------------------------------------------------- */
/* Écouteurs                                                              */
/* -------------------------------------------------------------------- */

test('écouteurs : prepend sur les suppressions et channelUpdate ; rien capturé module coupé ni pendant /backup ; guildDelete oublie le serveur', () => {
  const events = require('../src/events/securStructure');
  const by = Object.fromEntries(events.map((e) => [e.name, e]));
  for (const name of ['channelDelete', 'channelUpdate', 'roleDelete', 'emojiDelete', 'stickerDelete']) assert.equal(by[name].prepend, true, `${name} sans prepend`);
  let covered = false;
  let restoring = false;
  const client = makeClient();
  client.services.secur = { covers: () => covered };
  client.services.backup = { isRestoring: () => restoring };
  const channel = makeChannel('c1');
  const guild = makeGuild({ channels: [channel] });
  by.channelDelete.execute(client, channel);
  assert.equal(St.storeFor(client).get('g1', 'channel', 'c1'), null, 'capture avec le module coupé');
  covered = true;
  restoring = true;
  by.channelDelete.execute(client, channel);
  assert.equal(St.storeFor(client).get('g1', 'channel', 'c1'), null, 'capture pendant une restauration /backup');
  restoring = false;
  by.channelDelete.execute(client, channel);
  assert.equal(St.storeFor(client).get('g1', 'channel', 'c1').name, 'c1');
  // channelUpdate : orphelin noté, surcharge de rôle retirée gardée.
  const before = { ...makeChannel('c2', { parentId: 'cat', overwrites: [{ id: 'r9', allow: P.ViewChannel }] }), guild };
  const after = { ...makeChannel('c2'), guild };
  by.channelUpdate.execute(client, before, after);
  assert.deepEqual(St.storeFor(client).orphansOf('g1', 'cat'), ['c2']);
  assert.equal(St.storeFor(client).removedOverwritesOf('g1', 'r9')[0].channelId, 'c2');
  by.guildDelete.execute(client, { id: 'g1', available: false });
  assert.ok(St.storeFor(client).get('g1', 'channel', 'c1'), 'panne passagère : état oublié');
  by.guildDelete.execute(client, { id: 'g1' });
  assert.equal(St.storeFor(client).get('g1', 'channel', 'c1'), null);
  // Client minimal (autres tests de guildDelete) : aucune erreur.
  assert.doesNotThrow(() => by.guildDelete.execute({ services: {} }, { id: 'g1' }));
});

test('rôle géré du bot : permissions retirées → comptées d\'emblée, non annulables ; permissions données → jamais comptées', async () => {
  const cfg = clone(defaultGuildConfig);
  cfg.secur.modules.roleUpdate.mode = 'on';
  const client = makeClient({ cfg });
  const botRole = { id: 'br', name: 'Inspecteur Gadget', managed: true, tags: { botId: 'bot' }, permissions: bits(P.Administrator) };
  const guild = makeGuild({ roles: [botRole] });
  const lost = byKey.roleUpdate.classify({ action: 31, targetId: 'br', executorId: 'u1', changes: [{ key: 'permissions', old: String(P.Administrator), new: '0' }] }, guild, ctxFor(client, 'roleUpdate', cfg));
  assert.equal(lost.weight, S.effectiveLimit(cfg, 'roleUpdate'));
  assert.equal(lost.record.noUndo, true);
  const res = await byKey.roleUpdate.undo(guild, lost.record, ctxFor(client, 'roleUpdate', cfg, { idMap: new Map() }));
  assert.equal(res.ok, false);
  assert.match(res.note, /mon rôle .* non annulable/);
  assert.equal(byKey.roleUpdate.classify({ action: 31, targetId: 'br', executorId: 'u1', changes: [{ key: 'permissions', old: '0', new: String(P.Administrator) }] }, guild, ctxFor(client, 'roleUpdate', cfg)), null);
});

test('annulations d\'actions faites via le bot (reportBotAction : { targetId, viaBot }) : aucune exception, rien d\'inventé', async () => {
  const client = makeClient();
  const guild = makeGuild({ me: { permissions: { has: () => true } } });
  guild.channels.create = async () => assert.fail('salon recréé sans instantané');
  guild.roles.create = async () => assert.fail('rôle recréé sans instantané');
  const record = { targetId: 'x', viaBot: true };
  for (const key of ['channelCreate', 'channelDelete', 'channelUpdate', 'roleCreate', 'roleDelete', 'roleUpdate', 'roleAdd', 'roleRemove', 'webhook', 'serverUpdate', 'expressions']) {
    const res = await byKey[key].undo(guild, record, ctxFor(client, key, undefined, { idMap: new Map() }));
    assert.equal(typeof res?.ok, 'boolean', `${key} : résultat invalide`);
    assert.equal(typeof byKey[key].targetKey(record), 'string');
    assert.equal(typeof byKey[key].describe(record), 'string');
  }
});
