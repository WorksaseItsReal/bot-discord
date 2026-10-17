'use strict';

/**
 * Régressions de la revue n° 6 (AutoMod) : briques pures et services.
 * Les scénarios Discord complets sont dans tests/e2e/review6-automod.e2e.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { findBadWord, wordPattern } = require('../src/utils/automod/words');

const ROOT = path.join(__dirname, '..');

/**
 * Temps (meilleur de 3, en ms) d'une analyse de mots interdits, mesuré dans un worker :
 * un retour arrière catastrophique ne bloque pas le test, il est interrompu au bout de `limitMs`.
 */
function timeWords(kind, word, text, limitMs = 3000) {
  return new Promise((resolve) => {
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const { performance } = require('node:perf_hooks');
      const { findBadWord } = require(workerData.root + '/src/utils/automod/words');
      const { nameViolation } = require(workerData.root + '/src/utils/automod/names');
      const { AutoModService } = require(workerData.root + '/src/services/AutoModService');
      const svc = new AutoModService({ config: {}, logging: {}, moderation: {} });
      const words = [].concat(workerData.word);
      const message = { id: 'm1', guild: { id: 'g' }, author: { id: 'u' }, channel: { id: 'c' }, content: workerData.text };
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        if (workerData.kind === 'name') nameViolation(workerData.text, {}, { words });
        else if (workerData.kind === 'inspect') svc.inspect(message, { badWords: { enabled: true, words, action: 'delete' } }, { temporal: false });
        else findBadWord(workerData.text, words);
        best = Math.min(best, performance.now() - t0);
      }
      parentPort.postMessage(best);
    `, { eval: true, workerData: { root: ROOT, kind, word, text } });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve(Infinity);
    }, limitMs);
    worker.once('message', (ms) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(ms);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

// ---------------------------------------------------------------- R38 : ReDoS des mots composés

test('R38 : mots interdits composés — aucun retour arrière catastrophique (4000 caractères < 50 ms)', async () => {
  const cases = [
    // [entrée de la liste, message ou pseudo piégé, type]
    ['k.k.k', `${'k'.repeat(3999)}b`],
    ['k k k k', `${'k'.repeat(3999)}b`],
    ['k k*', `${'k'.repeat(3998)}.a`],
    ['k*', `${'k'.repeat(3998)}.a`],
    ['k k k', `${'k.'.repeat(1999)}kb`],
    ['k k k', `k ${'k'.repeat(3996)}b`],
    ['k ! ! ! k', `k${'!'.repeat(3998)}x`],
    ['k ! ! ! k', `k ${'! '.repeat(1998)}x`],
    ['a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a', `${'a'.repeat(3999)}b`],
    ['a~b~c~d~e~f~g~h~i~j~k~l~m~n~o', `${'a~~b~~c~~d~~e~~f~~g~~h~~i~~j~~k~~l~~m~~n~~o'.repeat(1)}x`],
    ['sale enculé', `sal${'e'.repeat(3996)}b`],
    ['σς σς σς σς', `${'σ'.repeat(3999)}b`],
    ['a a a a a a a a a a', `${'a'.repeat(31)}b`, 'name'],
  ];
  for (const [word, text, kind = 'message'] of cases) {
    const ms = await timeWords(kind, word, text);
    assert.ok(typeof ms === 'number' && ms < 50, `« ${word} » sur ${text.length} caractères (${kind}) : ${ms === Infinity ? '> 3 s (boucle bloquée)' : `${ms} ms`}`);
  }
});

test('R38 : les mots composés gardent leur détection (lettres répétées, séparateurs, mots collés)', () => {
  const hits = [
    ['k.k.k', ['k k k', 'kkk', 'k.k.k', 'kkkkk', 'k-k-k']],
    ['sale enculé', ['sale enculé', 'saleenculé', 'sale-enculé', 'saleeee eeenculé', 'SALE   ENCULÉ', 's.a.l.e e.n.c.u.l.e']],
    ['ka ak', ['ka ak', 'kaak', 'kaaaa aaak']],
    ['fils de pute', ['fils de pute', 'fils-de-pute', 'filsdepute', 'fiiils de puuute']],
    ['k k*', ['kk', 'k k', 'k.kab', 'kkab']],
    ['arnaque*', ['arnaqueur', 'arnaque', 'aarnaque']],
    ['c~n', ['c~n', 'c~~n']],
  ];
  for (const [word, texts] of hits) {
    for (const t of texts) assert.ok(findBadWord(t, [word]), `« ${word} » devrait détecter « ${t} » (motif ${wordPattern(word)})`);
  }
  const misses = [
    ['k.k.k', ['kk', 'k k', 'kkb', 'bkkk']],
    ['sale enculé', ['sale type', 'enculé', 'salement']],
    ['ka ak', ['ka', 'kak']],
    ['k k*', ['k', 'bkk']],
  ];
  for (const [word, texts] of misses) {
    for (const t of texts) assert.equal(findBadWord(t, [word]), null, `« ${word} » ne devrait pas détecter « ${t} » (motif ${wordPattern(word)})`);
  }
});

test('R38 : chemin réel — inspect() d\'un message de 4000 caractères reste rapide', async () => {
  const { AutoModService } = require('../src/services/AutoModService');
  const words = ['k.k.k', 'a a a a a a a a a a', 'sale enculé'];
  const ms = await timeWords('inspect', words, `${'k'.repeat(1999)}b ${'a'.repeat(1999)}b`);
  assert.ok(typeof ms === 'number' && ms < 50, `inspect : ${ms === Infinity ? '> 3 s (boucle bloquée)' : `${ms} ms`}`);
  const svc = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const message = { id: 'm1', guild: { id: 'g' }, author: { id: 'u' }, channel: { id: 'c' }, content: 'espèce de k k k' };
  assert.equal(svc.inspect(message, { badWords: { enabled: true, words, action: 'delete' } }, { temporal: false })?.filter, 'badWords');
});

// ---------------------------------------------------------------- R39 / R40 / R41 : liens et invitations

const { extractLinks, extractInvites } = require('../src/utils/automod/links');
const { phishingScore, maskedLinks } = require('../src/utils/automod/phishing');
const { blockedLinks } = require('../src/services/AutoModService');

const hostsOf = (text) => extractLinks(text).map((l) => l.host);
/** Hôte réellement ouvert par le navigateur (analyse WHATWG, comme Chromium/Electron). */
const browserHost = (url) => new URL(url).hostname.replace(/^www\./, '');

test('R39 : « ?@ », « #@ », « \\@ » devant un hôte officiel — le bot voit le site que le navigateur ouvre', () => {
  for (const sep of ['?', '#', '\\']) {
    const url = `https://dlscord-gift.ru${sep}@discord.com/claim`;
    assert.equal(browserHost(url), 'dlscord-gift.ru');
    assert.deepEqual(hostsOf(`Nitro gratuit !! ${url} @everyone`), ['dlscord-gift.ru'], url);
    assert.ok(phishingScore(`Nitro gratuit !! ${url} @everyone`).score >= 5, `arnaque non vue : ${url}`);
    // Anti-liens : un domaine quelconque ne se cache plus derrière discord.com.
    const evil = `https://evil.ru${sep}@discord.com/login`;
    assert.deepEqual(blockedLinks(extractLinks(evil), {}).map((l) => l.host), ['evil.ru'], evil);
  }
  assert.deepEqual(hostsOf('<https://evil.ru?@discord.com/x>'), ['evil.ru']);
  // Lien masqué : le texte affiché ment toujours sur la destination.
  assert.equal(maskedLinks('[discord.com/gifts](https://dlscord-gift.ru?@discord.com/claim)').length, 1);
  // Témoins : la vraie partie « utilisateur@ » reste retirée et signalée.
  assert.deepEqual(extractLinks('https://discord.com@evil.ru/x').map((l) => [l.host, l.disguised]), [['evil.ru', 'domain']]);
  assert.deepEqual(extractLinks('https://user:pass@evil.ru').map((l) => [l.host, l.disguised]), [['evil.ru', 'user']]);
  assert.deepEqual(hostsOf('https://evil.ru@discord.com/x'), ['discord.com']);
  // « \\@ » après un hôte officiel : le navigateur reste sur discord.com (chemin « /@evil.ru »).
  assert.equal(browserHost('https://discord.com\\@evil.ru'), 'discord.com');
  assert.deepEqual(hostsOf('https://discord.com\\@evil.ru'), ['discord.com']);
  assert.equal(phishingScore('https://discord.com\\@evil.ru').score, 0);
});

test('R40 : points pleine chasse / idéographiques, %2e et adresses IP reconnus comme des liens', () => {
  for (const dot of ['．', '。', '｡']) {
    const url = `https://dlscord-gift${dot}ru/claim`;
    assert.equal(browserHost(url), 'dlscord-gift.ru');
    assert.ok(hostsOf(`Nitro gratuit !! ${url}`).includes('dlscord-gift.ru'), url);
    assert.ok(phishingScore(`Nitro gratuit !! ${url} @everyone`).score >= 5, url);
  }
  assert.ok(hostsOf('https://evil%2eru/login').includes('evil.ru'));
  for (const [url, ip] of [['http://45.13.227.9/x', '45.13.227.9'], ['http://755623689/', '45.9.231.9'], ['http://0x2d0de309/', '45.13.227.9'], ['http://[2a01:4f8::1]/', '[2a01:4f8::1]']]) {
    const links = extractLinks(`va sur ${url}`);
    assert.ok(links.some((l) => l.host === ip && l.ip), `${url} → ${JSON.stringify(links)}`);
    assert.equal(blockedLinks(links, {}).length > 0, true, `anti-liens : ${url}`);
  }
  // Une adresse IP compte comme indice d'arnaque.
  assert.ok(phishingScore('Nitro gratuit !! http://45.13.227.9/discord-nitro @everyone').score >= 3);
  // Pas de faux positif : versions, nombres, liens normaux inchangés.
  assert.deepEqual(hostsOf('version 1.2.3.4 et 10.0.0.1 sans protocole, fichier.txt, v2.0'), []);
  assert.deepEqual(hostsOf('https://exemple.fr/a et https://www.site.com/b'), ['exemple.fr', 'site.com']);
  assert.deepEqual(hostsOf('https://dіscord.com'), ['dіscord.com'], 'homoglyphe conservé (pas de doublon punycode)');
  assert.equal(phishingScore('https://youtube.com/watch?v=1 gratuit').score, 0);
});

test('R41 : invitations encodées (./, ../, %xx, antislash, points idéographiques) détectées', () => {
  for (const url of ['https://discord.gg/./raidzone', 'https://discord.com/x/../invite/raidzone', 'https://disc%6Frd.gg/raidzone',
    'https://discord.gg\\raidzone', 'https://discord。gg/raidzone', 'https://discord｡gg/raidzone', 'https://discord.gg/%72aidzone']) {
    assert.deepEqual(extractInvites(`rejoins ${url}`), ['raidzone'], url);
  }
  // Témoins : détection habituelle et pas de faux positif.
  assert.deepEqual(extractInvites('rejoins https://discord.gg/raidzone'), ['raidzone']);
  assert.deepEqual(extractInvites('https://discord.com/channels/1/2 et https://exemple.fr/discord.gg'), []);
});
