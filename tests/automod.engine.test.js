'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { canonical, variants, fingerprint, joinSpaced } = require('../src/utils/automod/normalize');
const { findBadWord } = require('../src/utils/automod/words');
const { extractLinks, extractInvites, hostMatches } = require('../src/utils/automod/links');
const { phishingScore, imitatesBrand, distance } = require('../src/utils/automod/phishing');
const d = require('../src/utils/automod/detectors');

test('normalisation : accents, invisibles, homoglyphes, lettres espacées', () => {
  assert.strictEqual(canonical('Énorme​ CAFÉ'), 'enorme cafe');
  assert.strictEqual(canonical('сon'), 'con', 'c cyrillique');
  assert.strictEqual(joinSpaced('quel c o n'), 'quel con');
  assert.strictEqual(joinSpaced('il a dit oui'), 'il a dit oui', 'les vrais mots ne sont pas recollés');
  assert.ok(variants('c0n').includes('con'));
  assert.strictEqual(fingerprint('SALUT !!!!   tout le monde'), fingerprint('salut tout le monde'));
});

test('mots interdits : contournements attrapés, faux positifs évités', () => {
  const words = ['con', 'fdp', 'arnaque*', 'sale type'];
  for (const t of ['quel con', 'quel c0n', 'quel cooon', 'quel c.o.n', 'quel c o n', 'quel сon', 'un FDP', 'f.d.p', 'arnaqueur', 'espèce de sale   type', 'CON​']) {
    assert.ok(findBadWord(t, words), `devrait détecter : ${t}`);
  }
  for (const t of ['conseil', 'déconné', 'second', 'classe', 'icône', 'salement typé', 'contre']) {
    assert.strictEqual(findBadWord(t, words), null, `faux positif : ${t}`);
  }
  assert.strictEqual(findBadWord('quoi', []), null);
});

test('liens : avec ou sans protocole, sans faux positifs courants', () => {
  const hosts = extractLinks('va sur google.com/abc, https://x.io/z, www.exemple.fr, fichier.txt, 1.5, v2.0, a.b').map((l) => l.host);
  assert.deepStrictEqual(hosts, ['google.com', 'x.io', 'exemple.fr']);
  assert.strictEqual(extractLinks('<https://site.com/a>')[0].host, 'site.com');
  assert.ok(hostMatches('cdn.tenor.com', ['tenor.com']));
  assert.ok(!hostMatches('tenor.com.evil.ru', ['tenor.com']));
});

test('invitations, y compris masquées', () => {
  assert.deepStrictEqual(extractInvites('rejoins discord . gg / abcd et discord.com/invite/XyZ et dsc.gg/top'), ['abcd', 'xyz', 'top']);
  assert.deepStrictEqual(extractInvites('discord est cool'), []);
});

test('arnaques : faux domaines détectés, domaines officiels ignorés', () => {
  assert.ok(phishingScore('FREE NITRO first 100 https://dlscord-gift.com/claim @everyone').score >= 3);
  assert.ok(phishingScore('https://steamcornmunity.ru/tradeoffer/new').score >= 3);
  assert.ok(phishingScore('https://discord-nitro.xyz/gift').score >= 3);
  assert.strictEqual(imitatesBrand('discord.com'), null);
  assert.strictEqual(imitatesBrand('cdn.discordapp.com'), null);
  assert.strictEqual(imitatesBrand('steamcommunity.com'), null);
  assert.ok(phishingScore('regarde https://youtube.com/watch?v=1').score < 3);
  assert.ok(phishingScore('nitro offert ici https://discord.gift/abc').score < 3, 'vrai lien cadeau Discord');
  assert.strictEqual(distance('discord', 'dlscord'), 1);
});

test('détecteurs de forme', () => {
  assert.ok(d.isExcessiveCaps('ÉNORME PROBLÈME ICI'));
  assert.ok(!d.isExcessiveCaps('OK merci'));
  assert.ok(!d.isExcessiveCaps('<@123456789012345678> https://EXAMPLE.COM salut tout le monde'));
  assert.strictEqual(d.countEmojis('👨‍👩‍👧 hey 😀 <:a:123456789012345678>'), 3);
  assert.ok(d.isZalgo('h̸̢̛̛̙͎e̶̢̧̛l̴̡̛̛l̸̨̧̛o̸̢̧̢'));
  assert.ok(!d.isZalgo('élève à côté'));
  assert.ok(d.isWall('a\n'.repeat(20)));
  assert.strictEqual(d.countMentions({ mentions: { users: { size: 2 }, roles: { size: 1 }, everyone: true } }), 4);
});
