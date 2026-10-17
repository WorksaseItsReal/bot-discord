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
