'use strict';

/**
 * Revue n° 7, lot « moteur Secur » : tests unitaires (file d'annulation, disjoncteur).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { UndoQueue, UndoBreaker } = require('../src/services/secur/undoQueue');

test('S26 : file pleine (500) → une recréation prioritaire évince la dernière tâche de la voie la plus faible', async () => {
  let release;
  const blocked = new Promise((r) => { release = r; });
  const evicted = [];
  const order = [];
  const q = new UndoQueue({
    maxTasks: 500,
    execute: async (t) => {
      order.push(t.id);
      if (t.id === 'p5-0') await blocked;
    },
    onEvict: (t) => evicted.push(t.id),
  });
  for (let i = 0; i < 501; i += 1) assert.equal(q.push({ id: `p5-${i}`, priority: 5 }), true);
  // p5-0 en cours (bloquée), 500 en attente : la file est pleine.
  assert.equal(q.push({ id: 'p5-extra', priority: 5 }), false, 'priorité égale : refusée (pas d\'éviction)');
  assert.equal(q.push({ id: 'role-admin', priority: 1 }), true, 'recréation du rôle Admin refusée, file pleine de tâches de priorité 5');
  assert.deepEqual(evicted, ['p5-500'], 'la tâche évincée est la dernière de la voie la plus faible');
  release();
  await q.running;
  assert.equal(order[1], 'role-admin', 'la tâche prioritaire passe juste après la tâche en cours');
  assert.ok(!order.includes('p5-500'));
  await q.stop(0);
});

test('S20 : disjoncteur par objet — un autre objet du même module n\'est jamais suspendu', () => {
  let t = 0;
  const b = new UndoBreaker({ now: () => t });
  for (let i = 0; i < 2; i += 1) assert.equal(b.note('g', 'roleUpdate', 'update:joueur'), false);
  assert.equal(b.note('g', 'roleUpdate', 'update:joueur'), true);
  assert.equal(b.isSuspended('g', 'roleUpdate', 'update:joueur'), true);
  assert.equal(b.isSuspended('g', 'roleUpdate', 'update:membre'), false, 'autre objet suspendu');
  assert.equal(b.isSuspended('g', 'roleUpdate', null), false);
  assert.equal(b.isSuspended('g', 'roleUpdate'), true, 'indicateur du module (panneau)');
  assert.ok(b.suspendedUntil('g', 'roleUpdate') > 0);
  t = 5 * 60_000 + 1;
  assert.equal(b.isSuspended('g', 'roleUpdate', 'update:joueur'), false);
  assert.equal(b.isSuspended('g', 'roleUpdate'), false);
});

test('S20 : UndoQueue.clearTarget ne retire que les tâches de cet objet', () => {
  const q = new UndoQueue({ execute: () => new Promise(() => {}) });
  q.push({ id: 'run', module: 'roleUpdate', targetKey: 'x', priority: 1 });
  q.push({ id: 'a', module: 'roleUpdate', targetKey: 'update:joueur', priority: 1 });
  q.push({ id: 'b', module: 'roleUpdate', targetKey: 'update:membre', priority: 1 });
  q.push({ id: 'c', module: 'channelDelete', targetKey: 'update:joueur', priority: 3 });
  const removed = q.clearTarget('roleUpdate', 'update:joueur');
  assert.deepEqual(removed.map((t) => t.id), ['a']);
  assert.equal(q.size, 2);
  q.stop(0);
});

test('S15 : lostKeyPermissions — perte d\'une permission clé, Administrateur couvrant, gain ignoré', () => {
  const { PermissionFlagsBits: P } = require('discord.js');
  const { lostKeyPermissions } = require('../src/events/securAudit');
  assert.deepEqual(lostKeyPermissions(P.ViewAuditLog | P.ManageRoles, P.ManageRoles), [P.ViewAuditLog]);
  assert.ok(lostKeyPermissions(P.Administrator, P.ManageRoles).includes(P.ViewAuditLog), 'Administrateur perdu : Voir les logs perdu');
  assert.deepEqual(lostKeyPermissions(P.ManageRoles, P.Administrator), []);
  assert.deepEqual(lostKeyPermissions(P.SendMessages, 0n), [], 'permission non clé');
});

test('S16 : timeoutUntil — seul un timeout posé dans le futur compte (levée, pseudo, date passée : non)', () => {
  const { timeoutUntil } = require('../src/services/secur/modules/timeouts');
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  assert.equal(timeoutUntil({ changes: [{ key: 'communication_disabled_until', new: iso(now + 60_000) }] }, now), Date.parse(iso(now + 60_000)));
  assert.equal(timeoutUntil({ changes: [{ key: 'communication_disabled_until', old: iso(now + 60_000) }] }, now), null);
  assert.equal(timeoutUntil({ changes: [{ key: 'communication_disabled_until', new: iso(now - 1_000) }] }, now), null);
  assert.equal(timeoutUntil({ changes: [{ key: 'nick', new: 'x' }] }, now), null);
});

test('S17 : dépôt des accès — en attente sans limite de durée, approuvé par le même accès d\'un owner, purge des seuls accès tranchés', () => {
  const { memoryDb } = require('./db.helper');
  const { SecurityGrantRepository } = require('../src/database/repositories/SecurityGrantRepository');
  const repo = new SecurityGrantRepository(memoryDb().db);
  const G = '100000000000000001';
  const U = '100000000000000002';
  const A = '100000000000000003';
  const old = Date.now() - 40 * 86_400_000;
  const g1 = repo.create({ guildId: G, kind: 'user', subjectId: U, grantedBy: A, grantedAt: old });
  assert.equal(repo.create({ guildId: G, kind: 'user', subjectId: U, grantedBy: A }).existing, true, 'doublon d\'un accès toujours en attente');
  assert.equal(repo.pendingFor(G, U).length, 1);
  assert.equal(repo.purgeBefore(Date.now() - 30 * 86_400_000), 0, 'accès en attente purgé (donc actif)');
  assert.equal(repo.approveSame({ guildId: G, kind: 'user', subjectId: U, by: A }), 1);
  assert.equal(repo.pendingFor(G, U).length, 0);
  assert.equal(repo.get(G, g1.id).approved_by, A);
  assert.equal(repo.purgeBefore(Date.now() - 30 * 86_400_000), 1);
});
