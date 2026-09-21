'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canActOnByHierarchy } = require('../src/utils/permissions');

test('un rôle supérieur peut agir sur un rôle inférieur', () => {
  assert.equal(canActOnByHierarchy({ isOwner: false, highestRolePosition: 5 }, { isOwner: false, highestRolePosition: 3 }), true);
});

test('un rôle inférieur ou égal ne peut pas agir', () => {
  assert.equal(canActOnByHierarchy({ isOwner: false, highestRolePosition: 3 }, { isOwner: false, highestRolePosition: 3 }), false);
  assert.equal(canActOnByHierarchy({ isOwner: false, highestRolePosition: 2 }, { isOwner: false, highestRolePosition: 4 }), false);
});

test('le propriétaire peut agir sur tout le monde (sauf un autre propriétaire)', () => {
  assert.equal(canActOnByHierarchy({ isOwner: true, highestRolePosition: 1 }, { isOwner: false, highestRolePosition: 99 }), true);
});

test('personne ne peut agir sur le propriétaire', () => {
  assert.equal(canActOnByHierarchy({ isOwner: true, highestRolePosition: 99 }, { isOwner: true, highestRolePosition: 1 }), false);
  assert.equal(canActOnByHierarchy({ isOwner: false, highestRolePosition: 99 }, { isOwner: true, highestRolePosition: 1 }), false);
});
