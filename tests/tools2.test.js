'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../src/utils/calc');
const { parseDice, rollDice } = require('../src/utils/random');
const { parseLocalDateTime } = require('../src/utils/datetime');
const { progressBar, truncate, listOrMore, sanitizeEmbed } = require('../src/utils/embeds');
const { duel } = require('../src/commands/fun/pfc');
const { parseAnswers } = require('../src/commands/fun/sondage');
const { toHsl } = require('../src/commands/utility/couleur');

test('calcul : priorités, puissance, erreurs', () => {
  assert.strictEqual(evaluate('2+3*4'), 14);
  assert.strictEqual(evaluate('-3^2'), -9);
  assert.strictEqual(evaluate('2^3^2'), 512);
  assert.strictEqual(evaluate('sqrt(16) + abs(-2)'), 6);
  assert.strictEqual(evaluate('2,5 × 2'), 5);
  for (const bad of ['1/0', '2*(3', 'process.exit()', '', 'a'.repeat(300), '2 3']) assert.throws(() => evaluate(bad));
});

test('dés : notation et bornes', () => {
  assert.deepStrictEqual(parseDice('3d8+2'), { count: 3, sides: 8, modifier: 2 });
  assert.strictEqual(parseDice('1000d6'), null);
  assert.strictEqual(parseDice('d1'), null);
  const { rolls, total } = rollDice({ count: 3, sides: 6, modifier: 1 }, () => 0.999);
  assert.deepStrictEqual(rolls, [6, 6, 6]);
  assert.strictEqual(total, 19);
});

test('dates locales avec fuseau (heure d\'hiver / été)', () => {
  assert.strictEqual(parseLocalDateTime('25/12/2026 18:30', 'Europe/Paris'), Date.UTC(2026, 11, 25, 17, 30));
  assert.strictEqual(parseLocalDateTime('2026-07-14 09:00', 'Europe/Paris'), Date.UTC(2026, 6, 14, 7, 0));
  assert.strictEqual(parseLocalDateTime('30/02/2026'), null);
  assert.strictEqual(parseLocalDateTime('25:00'), null);
});

test('helpers d\'embeds', () => {
  assert.strictEqual(progressBar(0.5, 10), '█████░░░░░');
  assert.strictEqual(progressBar(2, 4), '████');
  assert.strictEqual(progressBar(NaN, 4), '░░░░');
  assert.strictEqual(truncate('abcdef', 4), 'abc…');
  assert.strictEqual(listOrMore(['a', 'b', 'c'], 2), 'a, b et 1 autre');
  const e = sanitizeEmbed({ title: 't'.repeat(300), fields: Array.from({ length: 30 }, () => ({ name: '', value: '' })) });
  assert.strictEqual(e.title.length, 256);
  assert.strictEqual(e.fields.length, 25);
  assert.ok(e.fields.every((x) => x.name && x.value));
});

test('pierre-feuille-ciseaux, sondage, couleurs', () => {
  assert.strictEqual(duel('pierre', 'ciseaux'), 1);
  assert.strictEqual(duel('pierre', 'feuille'), -1);
  assert.strictEqual(duel('feuille', 'feuille'), 0);
  assert.deepStrictEqual(parseAnswers(' Oui | Non |  | oui | Non '), ['Oui', 'Non', 'oui']);
  assert.deepStrictEqual(toHsl(255, 0, 0), [0, 100, 50]);
  assert.deepStrictEqual(toHsl(128, 128, 128), [0, 0, 50]);
});
