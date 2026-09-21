'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');

function repo() {
  const { db } = memoryDb();
  return new SanctionRepository(db);
}

test('create() + listByUser() renvoie les sanctions du bon serveur/membre', () => {
  const r = repo();
  const id = r.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm1', type: 'warn', reason: 'spam' });
  assert.ok(id > 0);
  r.create({ guildId: 'g1', userId: 'u2', moderatorId: 'm1', type: 'ban' });
  const list = r.listByUser('g1', 'u1');
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'warn');
  assert.equal(list[0].reason, 'spam');
});

test('count() et clearUser() sont isolés par serveur', () => {
  const r = repo();
  r.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'warn' });
  r.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'mute' });
  r.create({ guildId: 'g2', userId: 'u1', moderatorId: 'm', type: 'warn' });
  assert.equal(r.count('g1', 'u1'), 2);
  assert.equal(r.clearUser('g1', 'u1'), 2);
  assert.equal(r.count('g1', 'u1'), 0);
  assert.equal(r.count('g2', 'u1'), 1); // autre serveur intact
});

test('delete() ne supprime que dans le bon serveur', () => {
  const r = repo();
  const id = r.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'warn' });
  assert.equal(r.delete('g2', id), false); // mauvais serveur
  assert.equal(r.delete('g1', id), true);
});

test('findDue() renvoie les sanctions temporaires expirées', () => {
  const r = repo();
  r.create({ guildId: 'g1', userId: 'u1', moderatorId: 'm', type: 'tempban', durationMs: 1000, expiresAt: Date.now() - 5000 });
  r.create({ guildId: 'g1', userId: 'u2', moderatorId: 'm', type: 'tempban', durationMs: 1000, expiresAt: Date.now() + 60_000 });
  r.create({ guildId: 'g1', userId: 'u3', moderatorId: 'm', type: 'ban' }); // permanent
  const due = r.findDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].user_id, 'u1');
});
