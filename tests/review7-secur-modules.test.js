'use strict';

/**
 * Revue n° 7 (modules Secur) : tests de régression unitaires. Chaque test échoue sans le
 * correctif correspondant (identifiant du constat en tête du nom).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { SnowflakeUtil } = require('discord.js');
const securVoice = require('../src/events/securVoice');
const serverUpdate = require('../src/services/secur/modules/server');

const snowflakeAt = (ms) => String(SnowflakeUtil.generate({ timestamp: ms }));

// ---------------------------------------------------------------- S3

test('S3 : entrée d\'audit d\'un transfert de propriété signée par l\'ancien propriétaire → non classée ; autre changement → classé', () => {
  const OLD = '300000000000000001';
  const NEW = '300000000000000002';
  assert.equal(serverUpdate.classify({ executorId: OLD, changes: [{ key: 'owner_id', old: OLD, new: NEW }] }), null);
  // Exécutant différent de l'ancien propriétaire (impossible côté Discord) : toujours compté.
  assert.ok(serverUpdate.classify({ executorId: NEW, changes: [{ key: 'owner_id', old: OLD, new: NEW }] }));
  assert.ok(serverUpdate.classify({ executorId: NEW, changes: [{ key: 'name', old: 'A', new: 'B' }] }));
});

// ---------------------------------------------------------------- S7

test('S7 : la mémoire des entrées vocales est propre à chaque serveur — 25 serveurs lus entre deux lectures ne font pas recompter une entrée fraîche', () => {
  const A = '300000000000000010';
  securVoice.forgetGuild(A);
  const now = Date.now();
  const entry = { id: snowflakeAt(now - 5_000), extra: { count: 3 } };
  assert.equal(securVoice.countDelta(A, entry, now), 3);
  // 25 autres serveurs, 20 entrées anciennes chacun (lecture types 27 × limit 10, ou plus).
  for (let g = 0; g < 25; g += 1) {
    for (let e = 0; e < 20; e += 1) securVoice.countDelta(`4000000000000000${String(g).padStart(2, '0')}`, { id: snowflakeAt(now - 86_400_000 + g * 100 + e), extra: { count: 1 } }, now + 1_000);
  }
  assert.equal(securVoice.countDelta(A, entry, now + 3_000), 0, 'entrée fraîche recomptée en entier');
  // L'entrée reste suivie : une nouvelle déconnexion regroupée compte 1.
  assert.equal(securVoice.countDelta(A, { ...entry, extra: { count: 4 } }, now + 4_000), 1);
  for (let g = 0; g < 25; g += 1) securVoice.forgetGuild(`4000000000000000${String(g).padStart(2, '0')}`);
  securVoice.forgetGuild(A);
});

test('S7 : mémoire bornée par serveur (les entrées les plus anciennes sortent), oubliée au départ du serveur', () => {
  const A = '300000000000000011';
  securVoice.forgetGuild(A);
  const now = Date.now();
  for (let e = 0; e < 300; e += 1) securVoice.countDelta(A, { id: snowflakeAt(now - 86_400_000 + e), extra: { count: 1 } }, now);
  assert.ok(securVoice.seenSize(A) <= securVoice.MAX_COUNTS, `mémoire non bornée : ${securVoice.seenSize(A)}`);
  securVoice.forgetGuild(A);
  assert.equal(securVoice.seenSize(A), 0);
});

// ---------------------------------------------------------------- S8

test('S8 : voiceKick ne lit que les déconnexions (audit 27), comme le déclare SECUR_MODULES', () => {
  const S = require('../src/utils/secur');
  assert.deepEqual(securVoice.VOICE_TYPES, S.SECUR_MODULES.voiceKick.auditTypes);
});

// ---------------------------------------------------------------- S19

test('S19 : clé du disjoncteur des suppressions = identifiant d\'origine (suivi à travers les recréations), jamais le nom', () => {
  const St = require('../src/services/secur/structure');
  const channelDelete = require('../src/services/secur/modules/channels').find((m) => m.key === 'channelDelete');
  const roleDelete = require('../src/services/secur/modules/roles').find((m) => m.key === 'roleDelete');
  const expressions = require('../src/services/secur/modules/expressions');
  const store = new St.StructureStore();
  const G = '300000000000000020';
  store.setRemap(G, 'A', 'B');
  store.setRemap(G, 'B', 'C');
  assert.equal(store.originOf(G, 'C'), 'A', 'chaîne de recréations');
  assert.equal(store.originOf(G, 'Z'), 'Z');
  // Deux homonymes : clés distinctes.
  assert.notEqual(channelDelete.targetKey({ channelId: '1', originId: '1', name: 'Vocal', type: 2 }), channelDelete.targetKey({ channelId: '2', originId: '2', name: 'Vocal', type: 2 }));
  assert.notEqual(roleDelete.targetKey({ roleId: '1', originId: '1', name: '──' }), roleDelete.targetKey({ roleId: '2', originId: '2', name: '──' }));
  assert.notEqual(expressions.targetKey({ kind: 'emoji', id: '1', originId: '1', name: 'gg' }), expressions.targetKey({ kind: 'emoji', id: '2', originId: '2', name: 'gg' }));
  // Objet recréé puis supprimé de nouveau : même clé que l'original.
  assert.equal(channelDelete.targetKey({ channelId: 'C', originId: 'A' }), channelDelete.targetKey({ channelId: 'A', originId: 'A' }));
});

// ---------------------------------------------------------------- S11

test('S11 : chaîne de modifications d\'un champ par un même auteur — origine commune, dernière valeur reconnue ; autre auteur → nouvelle chaîne', () => {
  const St = require('../src/services/secur/structure');
  const store = new St.StructureStore();
  const G = '300000000000000030';
  const [c1] = St.chainChanges(store, G, 'channel:1', 'attaquant', [{ key: 'name', old: 'général', new: 'raid-1' }]);
  const [c2] = St.chainChanges(store, G, 'channel:1', 'attaquant', [{ key: 'name', old: 'raid-1', new: 'nuked' }]);
  assert.equal(c1.old, 'général');
  assert.equal(c2.old, 'général', 'origine de la chaîne');
  assert.equal(c1.chain, c2.chain);
  // La 1re modification reconnaît la valeur actuelle laissée par la 2e : l'origine peut être rétablie.
  assert.equal(St.chainMatches(store, G, 'channel:1', c1, 'nuked'), true);
  assert.equal(St.chainMatches(store, G, 'channel:1', c1, 'renommé-par-un-admin'), false);
  // Un autre auteur ne prolonge pas la chaîne.
  const [c3] = St.chainChanges(store, G, 'channel:1', 'admin', [{ key: 'name', old: 'nuked', new: 'propre' }]);
  assert.equal(c3.old, 'nuked');
  assert.equal(St.chainMatches(store, G, 'channel:1', c1, 'propre'), false, 'valeur d\'un autre auteur prise pour celle de la chaîne');
});

// ---------------------------------------------------------------- S22

test('S22 : roleRemove ignore la cible d\'un incident ouvert ; incident expiré ou absent → compté', () => {
  const roleRemove = require('../src/services/secur/modules/roles').find((m) => m.key === 'roleRemove');
  const G = '300000000000000040';
  const T = '300000000000000041';
  const ROLE = '300000000000000042';
  const role = { id: ROLE, managed: false, permissions: { any: () => true }, position: 1 };
  const guild = { id: G, ownerId: '1', roles: { cache: new Map([[ROLE, role]]) } };
  const entry = { targetId: T, executorId: '300000000000000043', changes: [{ key: '$remove', new: [{ id: ROLE }] }] };
  let now = 1_000;
  const open = new Map([[`${G}:${T}`, { expiresAt: 61_000 }]]);
  const ctx = { client: { user: { id: '9' } }, cfg: {}, service: { open, now: () => now } };
  assert.equal(roleRemove.classify(entry, guild, ctx), null, 'cible d\'un incident ouvert comptée');
  now = 62_000;
  assert.ok(roleRemove.classify(entry, guild, ctx), 'incident expiré : retrait non compté');
  open.clear();
  assert.ok(roleRemove.classify(entry, guild, ctx));
});

// ---------------------------------------------------------------- S23

test('S23 : chaque colonne de rôle de la base est classée (roleRemap) ; report carry/json limité au serveur, menus comptés', () => {
  const { memoryDb } = require('./db.helper');
  const { COLUMNS, remapRole } = require('../src/utils/roleRemap');
  const { db } = memoryDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  for (const t of tables) {
    for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
      if (/role/i.test(c.name)) assert.ok(COLUMNS[`${t}.${c.name}`], `colonne ${t}.${c.name} non classée dans roleRemap`);
    }
  }
  const G = '300000000000000050';
  const OTHER = '300000000000000051';
  const OLD = '300000000000000052';
  const NEW = '300000000000000053';
  const now = Date.now();
  for (const g of [G, OTHER]) {
    db.prepare('INSERT INTO giveaways (guild_id, channel_id, prize, winners, host_id, required_role, ends_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(g, '1', 'x', '2', OLD, now, now);
    db.prepare('INSERT INTO role_menus (guild_id, channel_id, data, created_at) VALUES (?, ?, ?, ?)').run(g, '1', JSON.stringify({ roles: [{ roleId: OLD }] }), now);
  }
  const res = remapRole(db, G, OLD, NEW);
  assert.equal(res.carried, 1);
  assert.equal(res.lostMenus, 1);
  assert.equal(db.prepare('SELECT required_role FROM giveaways WHERE guild_id = ?').get(G).required_role, NEW);
  assert.equal(db.prepare('SELECT required_role FROM giveaways WHERE guild_id = ?').get(OTHER).required_role, OLD, 'autre serveur touché');
});
