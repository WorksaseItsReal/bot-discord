'use strict';

/**
 * Régressions de la revue n° 6 (lot modération) : tests unitaires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitingLift, isEnforced } = require('../src/database/repositories/SanctionRepository');

test('R12 awaitingLift : tempban ou mute actif échu = levée en attente ; timeout, levée ou futur : non', () => {
  const now = Date.now();
  const past = now - 1000;
  assert.equal(awaitingLift({ active: 1, type: 'tempban', expires_at: past }, now), true);
  assert.equal(awaitingLift({ active: 1, type: 'mute', expires_at: past }, now), true);
  assert.equal(awaitingLift({ active: 1, type: 'timeout', expires_at: past }, now), false); // expire côté Discord
  assert.equal(awaitingLift({ active: 0, type: 'tempban', expires_at: past }, now), false);
  assert.equal(awaitingLift({ active: 1, type: 'tempban', expires_at: now + 1000 }, now), false);
  assert.equal(awaitingLift({ active: 1, type: 'mute', expires_at: null }, now), false);
  assert.equal(isEnforced({ active: 1, type: 'tempban', expires_at: past }, now), false);
});
