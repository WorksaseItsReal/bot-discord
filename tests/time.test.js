'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, formatDuration } = require('../src/utils/time');

test('parseDuration : unités simples', () => {
  assert.equal(parseDuration('10s'), 10_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('1w'), 604_800_000);
});

test('parseDuration : durées composées et espaces', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1d 12h'), 129_600_000);
  assert.equal(parseDuration('2H'), 7_200_000); // insensible à la casse
});

test('parseDuration : entrées invalides -> null', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(parseDuration('10m garbage'), null);
});

test('formatDuration : rendu lisible', () => {
  assert.equal(formatDuration(0), 'permanent');
  assert.equal(formatDuration(-5), 'permanent');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_661_000), '1h 1m 1s');
  assert.equal(formatDuration(86_400_000), '1j');
});
