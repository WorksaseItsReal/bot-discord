'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

function makeService() {
  const { db } = memoryDb();
  return new ConfigService(new GuildConfigRepository(db));
}

test('get() renvoie les valeurs par défaut pour un serveur inconnu', () => {
  const svc = makeService();
  const cfg = svc.get('guild1');
  assert.equal(cfg.locale, 'fr');
  assert.equal(cfg.moderation.dmOnSanction, true);
  assert.deepEqual(cfg.logChannels.moderation, null);
});

test('update() fusionne le patch et persiste', () => {
  const svc = makeService();
  svc.update('guild1', { logChannels: { moderation: '123' } });
  const cfg = svc.get('guild1');
  assert.equal(cfg.logChannels.moderation, '123');
  // Les autres valeurs par défaut sont préservées
  assert.equal(cfg.locale, 'fr');
  assert.equal(cfg.logChannels.messages, null);
});

test('update() est isolé par serveur (multi-serveur)', () => {
  const svc = makeService();
  svc.update('guildA', { moderation: { dmOnSanction: false } });
  assert.equal(svc.get('guildA').moderation.dmOnSanction, false);
  assert.equal(svc.get('guildB').moderation.dmOnSanction, true);
});
