'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrations } = require('../src/database/schema');

test('migrations : ids entiers, uniques et croissants (un id sauté reste réservé)', () => {
  let previous = 0;
  for (const m of migrations) {
    assert.ok(Number.isInteger(m.id) && m.id > previous, `#${m.id}`);
    previous = m.id;
  }
});

test('migrations : un id dupliqué ou décroissant est refusé au démarrage', () => {
  const { DatabaseManager } = require('../src/database');
  const schema = require('../src/database/schema');
  const saved = schema.migrations.slice();
  schema.migrations.push({ id: saved[0].id, name: 'doublon', up: 'SELECT 1;' });
  try {
    const db = new DatabaseManager(':memory:');
    assert.throws(() => db.connect?.() ?? db.migrate?.(), /uniques et croissants/);
    db.close?.();
  } finally {
    schema.migrations.length = 0;
    schema.migrations.push(...saved);
  }
});

test('client : aucune mention de masse ni de rôle par défaut', () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  assert.deepEqual(client.options.allowedMentions, { parse: ['users'], repliedUser: false });
  client.destroy?.();
});

test('arrêt propre : les services avec travail différé sont vidés avant la déconnexion', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  const order = [];
  const svc = (name) => ({ flush: async () => order.push(name) });
  client.services = { giveaways: svc('giveaways'), projects: svc('projects'), tickets: svc('tickets'), scheduler: { stop: async () => order.push('scheduler') } };
  client.destroy = async () => order.push('destroy');
  client.database = { close: () => order.push('db') };
  await client.shutdown();
  assert.deepEqual(order, ['scheduler', 'tickets', 'giveaways', 'projects', 'destroy', 'db']);
});
