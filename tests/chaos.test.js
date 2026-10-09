'use strict';

/**
 * Tests unitaires de la revue par le chaos : outils du harnais (aléa reproductible,
 * valeurs hostiles, détection des mentions de masse) et correctifs isolés.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { neutralizeResolved } = require('../src/events/interactionGuard');
const { field, card } = require('../src/utils/ui');
const { findMassMentions } = require('./e2e/lib/limits');
const { Rng, hostileStrings, hostileValues } = require('./e2e/lib/chaos');

test('Rng : même graine, même suite ; fork indépendant de l\'ordre d\'appel', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const seqA = Array.from({ length: 20 }, () => a.next());
  assert.deepEqual(seqA, Array.from({ length: 20 }, () => b.next()));
  assert.notDeepEqual(seqA, Array.from({ length: 20 }, () => new Rng(43).next()));
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
  const r = new Rng(7);
  const f1 = r.fork('ban').next();
  r.next();
  assert.equal(r.fork('ban').next(), f1);
  assert.deepEqual(new Rng(1).sample([1, 2, 3, 4, 5], 3), new Rng(1).sample([1, 2, 3, 4, 5], 3));
});

test('valeurs hostiles : bornes imposées par Discord respectées (longueur, min/max, choix, types de salons)', () => {
  const h = {
    fake: {
      channels: new Map([['1', { id: '1', type: 0 }], ['2', { id: '2', type: 2 }], ['3', { id: '3', type: 4 }]]),
      roles: new Map(),
      users: new Map([['9', { id: '9', global_name: 'Étranger' }]]),
    },
    addUser: () => ({ id: '10' }),
  };
  const strings = hostileValues(h, { type: 3, name: 'raison', max_length: 20, min_length: 2 });
  assert.ok(strings.length > 20);
  assert.ok(strings.every(({ value }) => [...value].length <= 20 && [...value].length >= 2));
  assert.ok(strings.some(({ value }) => value.includes('@everyone')));
  assert.deepEqual(hostileValues(h, { type: 3, name: 'x', choices: [{ value: 'a' }, { value: 'b' }] }).map((v) => v.value), ['a', 'b']);
  const ints = hostileValues(h, { type: 4, name: 'n', min_value: 1, max_value: 100 }).map((v) => v.value);
  assert.ok(ints.includes(1) && ints.includes(100) && ints.every((v) => v >= 1 && v <= 100));
  assert.ok(hostileValues(h, { type: 10, name: 'x' }).some(({ value }) => !Number.isInteger(value)));
  assert.deepEqual(hostileValues(h, { type: 7, name: 'salon', channel_types: [2] }).map((v) => v.value), ['2']);
  assert.ok(hostileValues(h, { type: 3, name: 'duree' }).some(({ value }) => value === '-5m'));
  // Aucune valeur ne contient elle-même un mot « suspect » (faux positifs du harnais).
  assert.ok(hostileStrings().every((s) => !/\bundefined\b|\bNaN\b|\bnull\b/.test(s)));
});

test('neutralizeResolved : tables sans prototype, contenu conservé', () => {
  const resolved = JSON.parse('{"users":{"1":{"id":"1"}},"roles":{"2":{"id":"2"}},"members":{"1":{"roles":[]}}}');
  assert.ok(resolved.roles.constructor); // Object.prototype atteint par une clé « constructor »
  neutralizeResolved(resolved);
  for (const key of ['users', 'roles', 'members']) {
    assert.equal(Object.getPrototypeOf(resolved[key]), null);
    assert.equal(resolved[key].constructor, undefined);
    assert.equal(resolved[key].__proto__, undefined); // eslint-disable-line no-proto
    assert.equal(resolved[key].toString, undefined);
  }
  assert.deepEqual(Object.keys(resolved.users), ['1']);
  assert.equal(resolved.roles['2'].id, '2');
  assert.equal(neutralizeResolved(undefined), undefined);
  // Une clé « __proto__ » venue du JSON reste une simple donnée.
  const weird = JSON.parse('{"roles":{"__proto__":{"id":"3"}}}');
  neutralizeResolved(weird);
  assert.equal(weird.roles.__proto__.id, '3'); // eslint-disable-line no-proto
});

test('findMassMentions : @everyone et rôles notifiés selon allowed_mentions', () => {
  assert.equal(findMassMentions({ content: '@everyone' }).length, 1); // sans allowed_mentions : tout notifie
  assert.equal(findMassMentions({ content: '@everyone', allowed_mentions: { parse: ['users'] } }).length, 0);
  assert.equal(findMassMentions({ content: '@here', allowed_mentions: { parse: ['everyone'] } }).length, 1);
  assert.equal(findMassMentions({ type: 4, data: { content: '<@&123456789012345678>', allowed_mentions: { parse: ['roles'] } } }).length, 1);
  assert.equal(findMassMentions({ content: '<@&123456789012345678>', allowed_mentions: { roles: ['123456789012345678'] } }).length, 0);
  assert.equal(findMassMentions({ content: '<@&123456789012345678>', allowed_mentions: { roles: ['123456789012345678'] } }, new Set(['123456789012345678'])).length, 1);
  assert.equal(findMassMentions({ embeds: [{ description: '@everyone' }], allowed_mentions: { parse: [] } }).length, 0);
});

test('ui : une valeur faite d\'espaces devient « — » (champ jamais vide)', () => {
  for (const blank of [' ', '\u3000', '\n\t ', '']) assert.equal(field('📝', 'Raison', blank).value, '—');
  assert.equal(field('📝', 'Raison', ' ok ').value, ' ok ');
  const embed = card({ title: 'x', fields: [{ name: 'a', value: '   ', inline: false }] }).toJSON();
  assert.equal(embed.fields[0].value, '—');
});
