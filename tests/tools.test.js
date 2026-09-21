'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickWinners, shortId } = require('../src/utils/random');
const { parseColor } = require('../src/commands/utility/embed');
const { renderTag } = require('../src/commands/utility/tag');

test('pickWinners tire le bon nombre de gagnants uniques', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  const winners = pickWinners(pool, 3, () => 0.5);
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners).size, 3); // uniques
});

test('pickWinners borne au pool disponible', () => {
  assert.equal(pickWinners(['a'], 5).length, 1);
  assert.equal(pickWinners([], 3).length, 0);
});

test('shortId a la bonne longueur', () => {
  assert.equal(shortId(8).length, 8);
  assert.match(shortId(), /^[a-z0-9]+$/);
});

test('parseColor gère les formats hex', () => {
  assert.equal(parseColor('#5865F2'), 0x5865f2);
  assert.equal(parseColor('5865f2'), 0x5865f2);
  assert.equal(parseColor('pas une couleur'), null);
  assert.equal(parseColor(''), null);
});

test('renderTag substitue les variables', () => {
  const out = renderTag('Salut {user}, bienvenue sur {server} ({membercount} membres)', {
    user: { toString: () => '@Bob' },
    guild: { name: 'MonServeur', memberCount: 42 },
  });
  assert.equal(out, 'Salut @Bob, bienvenue sur MonServeur (42 membres)');
});
