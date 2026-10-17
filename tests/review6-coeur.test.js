'use strict';

/**
 * Revue n° 6 — lot « cœur » : régressions (passerelle, purge des serveurs quittés,
 * scheduler, événements, interactions, arrêt).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { _resetFatalState, setShutdownHook } = require('../src/core/errors');
const { snapshot } = require('../src/core/healthServer');

// ---------- R1 : fermeture définitive de la passerelle ----------

test('R1 : shardDisconnect (4004/4011/4014, non récupérable) → arrêt propre puis exit(1)', async () => {
  _resetFatalState();
  const events = require('../src/events/clientEvents');
  const handler = events.find((e) => e.name === 'shardDisconnect');
  const order = [];
  setShutdownHook(async () => order.push('shutdown'));
  const realExit = process.exit;
  process.exit = (code) => order.push(`exit:${code}`);
  try {
    await handler.execute({}, { code: 4004 }, 0);
  } finally {
    process.exit = realExit;
    _resetFatalState();
  }
  assert.deepEqual(order, ['shutdown', 'exit:1']);
});

test('R1 : /healthz « unavailable » si une shard n\'est plus connectée (isReady() figé à vrai)', () => {
  const shards = new Map([[0, { status: 5 }]]); // Status.Disconnected
  const client = {
    isReady: () => true,
    ws: { ping: 40, shards },
    guilds: { cache: { size: 1 } },
    uptime: 1000,
    database: { db: { prepare: () => ({ get: () => 1 }) } },
  };
  assert.equal(snapshot(client).ready, false);
  assert.equal(snapshot(client).status, 'unavailable');
  shards.set(0, { status: 0 }); // Status.Ready
  assert.equal(snapshot(client).status, 'ok');
});
