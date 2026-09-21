'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SlidingWindow, exceedsRate } = require('../src/utils/rate');

test('SlidingWindow compte les événements dans la fenêtre', () => {
  const w = new SlidingWindow(1000);
  assert.equal(w.hit(1000), 1);
  assert.equal(w.hit(1500), 2);
  assert.equal(w.hit(1900), 3);
  // À t=2600, seuls les événements > 1600 restent (1900)
  assert.equal(w.count(2600), 1);
});

test('exceedsRate détecte le dépassement', () => {
  const now = 10_000;
  const times = [9600, 9700, 9800, 9900, 9950];
  assert.equal(exceedsRate(times, 5, 1000, now), true);
  assert.equal(exceedsRate(times, 6, 1000, now), false);
  // Fenêtre plus courte : moins d'événements comptent
  assert.equal(exceedsRate(times, 5, 200, now), false);
});
