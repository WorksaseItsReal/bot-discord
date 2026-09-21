'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/utils/automodChecks');

test('détection d\'invitations Discord', () => {
  assert.equal(c.hasInvite('rejoins discord.gg/abcd'), true);
  assert.equal(c.hasInvite('https://discord.com/invite/xyz'), true);
  assert.equal(c.hasInvite('un message normal'), false);
});

test('détection de liens', () => {
  assert.equal(c.hasLink('voir https://exemple.com'), true);
  assert.equal(c.hasLink('pas de lien ici'), false);
});

test('excès de majuscules', () => {
  assert.equal(c.isExcessiveCaps('BONJOUR TOUT LE MONDE', { percent: 70, minLength: 10 }), true);
  assert.equal(c.isExcessiveCaps('Bonjour tout le monde', { percent: 70, minLength: 10 }), false);
  assert.equal(c.isExcessiveCaps('OK', { percent: 70, minLength: 10 }), false); // trop court
});

test('mentions massives', () => {
  assert.equal(c.isMassMention('<@1> <@2> <@3> <@4> <@5>', { limit: 5 }), true);
  assert.equal(c.isMassMention('<@1> <@2>', { limit: 5 }), false);
});

test('spam d\'emojis', () => {
  assert.equal(c.isEmojiSpam('😀😀😀😀😀😀😀😀😀', { limit: 8 }), true);
  assert.equal(c.isEmojiSpam('slt 😀', { limit: 8 }), false);
});

test('mots interdits', () => {
  assert.equal(c.containsBadWord('ceci est INTERDIT', ['interdit']), true);
  assert.equal(c.containsBadWord('rien ici', ['interdit']), false);
  assert.equal(c.containsBadWord('rien', []), false);
});
