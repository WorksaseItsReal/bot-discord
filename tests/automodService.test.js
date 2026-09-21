'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoModService } = require('../src/services/AutoModService');

function fakeMessage(content) {
  return { guild: { id: 'g1' }, author: { id: 'u1' }, content };
}

function service() {
  return new AutoModService({ config: {}, logging: {}, moderation: {} });
}

test('inspect détecte une invitation quand le filtre est actif', () => {
  const svc = service();
  const filters = { antiInvite: { enabled: true, action: 'delete' } };
  assert.equal(svc.inspect(fakeMessage('discord.gg/abc'), filters)?.reason, 'Invitation Discord interdite');
  assert.equal(svc.inspect(fakeMessage('bonjour'), filters), null);
});

test('inspect déclenche l\'anti-spam au seuil', () => {
  const svc = service();
  const filters = { antiSpam: { enabled: true, limit: 3, windowSeconds: 60, action: 'timeout', duration: '5m' } };
  assert.equal(svc.inspect(fakeMessage('a'), filters), null);
  assert.equal(svc.inspect(fakeMessage('b'), filters), null);
  const hit = svc.inspect(fakeMessage('c'), filters);
  assert.ok(hit);
  assert.equal(hit.action, 'timeout');
});

test('inspect anti-duplicate repère deux messages identiques', () => {
  const svc = service();
  const filters = { antiDuplicate: { enabled: true, action: 'delete' } };
  assert.equal(svc.inspect(fakeMessage('meme texte'), filters), null);
  assert.equal(svc.inspect(fakeMessage('meme texte'), filters)?.reason, 'Message dupliqué');
});
