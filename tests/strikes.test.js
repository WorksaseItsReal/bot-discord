'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { StrikeRepository } = require('../src/database/repositories/StrikeRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { StrikeService } = require('../src/services/StrikeService');

function makeService() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const strikes = new StrikeService(new StrikeRepository(db), config);
  return { strikes, config };
}

test('add() incrémente le compteur de strikes', () => {
  const { strikes } = makeService();
  assert.equal(strikes.add('g', 'u').count, 1);
  assert.equal(strikes.add('g', 'u').count, 2);
  assert.equal(strikes.getCount('g', 'u'), 2);
});

test('escalade : mappe le bon palier configuré (par défaut)', () => {
  const { strikes } = makeService();
  // Défauts : 3->mute, 5->kick, 7->ban
  assert.equal(strikes.resolveAction('g', 1), null);
  assert.equal(strikes.resolveAction('g', 3).action, 'mute');
  assert.equal(strikes.resolveAction('g', 4).action, 'mute'); // dernier palier atteint
  assert.equal(strikes.resolveAction('g', 5).action, 'kick');
  assert.equal(strikes.resolveAction('g', 8).action, 'ban');
});

test('escalade désactivée renvoie null', () => {
  const { strikes, config } = makeService();
  config.update('g', { strikes: { enabled: false } });
  assert.equal(strikes.resolveAction('g', 10), null);
});

test('reset() remet le compteur à zéro', () => {
  const { strikes } = makeService();
  strikes.add('g', 'u', 4);
  strikes.reset('g', 'u');
  assert.equal(strikes.getCount('g', 'u'), 0);
});
