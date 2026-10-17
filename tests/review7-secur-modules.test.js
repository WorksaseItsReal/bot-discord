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
