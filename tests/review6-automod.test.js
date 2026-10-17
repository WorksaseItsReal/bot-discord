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

// ---------------------------------------------------------------- R43 : normalisation

test('R43 : petites capitales « ᴀ », caractères de format invisibles et homoglyphes courants normalisés', () => {
  const { nameViolation, nameSkeleton } = require('../src/utils/automod/names');
  const cp = (n) => String.fromCodePoint(n);
  const words = ['connard', 'pute'];
  for (const t of [`quel con${cp(0x1bca0)}nard`, `quel con${cp(0x1d173)}nard`, `quel con${cp(0xfff9)}nard`, `quel con${cp(0x13430)}nard`, `quel con${cp(0x2065)}nard`,
    'quel cօnnard', 'quel cഠnnard', 'quel ϲonnard', 'quel connᴀrd', 'quel ᴄᴏɴɴᴀʀᴅ', 'sale ᴘᴜᴛᴇ', 'quel connɑrd']) {
    assert.ok(findBadWord(t, words), `non détecté : ${JSON.stringify(t)}`);
  }
  const staff = new Map([[nameSkeleton('Alice'), 'Alice']]);
  for (const n of ['ᴀᴅᴍɪɴ', 'Ad⁥min', 'Mod\u{1D173}erateur', 'ᴀlice', 'Աdmin'.replace('Ա', 'A')]) {
    assert.equal(nameViolation(n, {}, { words, staff })?.check, 'impersonation', `pseudo accepté : ${JSON.stringify(n)}`);
  }
  // Pas de faux positif : textes ordinaires, emojis composés et écritures non latines intacts.
  for (const t of ['quel connaisseur', 'cours de conduite', 'Ձեր անունը', '👨‍👩‍👧 famille', 'ελληνικά']) assert.equal(findBadWord(t, words), null, t);
});

// ---------------------------------------------------------------- R45 : listes blanches

test('R45 : longue liste de domaines autorisés — analyse d\'un message rempli de liens rapide, résultat inchangé', () => {
  const { AutoModService } = require('../src/services/AutoModService');
  const { hostMatches } = require('../src/utils/automod/links');
  const { isOfficial } = require('../src/utils/automod/phishing');
  const svc = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const allowedDomains = Array.from({ length: 20000 }, (_, i) => `site${i}.com`);
  const filters = { antiLink: { enabled: true, allowedDomains }, antiPhishing: { enabled: true, threshold: 3 }, antiHacked: { enabled: true, scamScore: 5 } };
  const content = Array.from({ length: 400 }, (_, i) => `a${i}.ru`).join(' ').slice(0, 4000);
  const message = { id: 'm1', guild: { id: 'g' }, author: { id: 'u', createdTimestamp: 0 }, channel: { id: 'c' }, content };
  svc.inspect(message, filters, { temporal: false });
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    assert.equal(svc.inspect(message, filters, { temporal: false })?.filter, 'antiLink');
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 50, `inspect avec 20 000 domaines autorisés : ${best.toFixed(0)} ms`);
  // Sémantique inchangée : égalité ou sous-domaine, jamais un suffixe trompeur.
  assert.equal(hostMatches('cdn.site42.com', allowedDomains), true);
  assert.equal(hostMatches('site42.com', allowedDomains), true);
  assert.equal(hostMatches('site42.com.evil.ru', allowedDomains), false);
  assert.equal(hostMatches('xsite42.com', allowedDomains), false);
  assert.equal(hostMatches('youtu.be', ['https://www.youtu.be/']), true);
  assert.equal(isOfficial('cdn.discordapp.com'), true);
  assert.equal(isOfficial('discordapp.com.evil.ru'), false);
  assert.equal(isOfficial('a.site7.com', allowedDomains), true);
});

test('R45 : extraction des liens bornée sur un texte piégé (étiquettes « 0«««…0 »)', () => {
  const label = `0${'«'.repeat(58)}0`;
  const evil = Array.from({ length: 70 }, () => label).join('.').slice(0, 4000);
  extractLinks(evil);
  const t0 = performance.now();
  assert.deepEqual(extractLinks(evil), []);
  assert.ok(performance.now() - t0 < 20, `extractLinks : ${(performance.now() - t0).toFixed(0)} ms`);
});

// ---------------------------------------------------------------- R47 / R48 / R49

test('R47 : question et réponses d\'un sondage analysées', () => {
  const { messageText, AutoModService } = require('../src/services/AutoModService');
  const svc = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const poll = { question: { text: 'sale con, rejoins discord.gg/raidzone' }, answers: new Map([[1, { text: 'fdp' }], [2, { text: 'oui' }]]) };
  const msg = { id: 'p', guild: { id: 'g' }, author: { id: 'u' }, channel: { id: 'c' }, content: '', poll };
  const text = messageText(msg);
  assert.match(text, /sale con/);
  assert.match(text, /fdp/);
  assert.equal(svc.inspect(msg, { badWords: { enabled: true, words: ['fdp'] } }, { temporal: false })?.filter, 'badWords');
  assert.equal(svc.inspect(msg, { antiInvite: { enabled: true } }, { temporal: false })?.filter, 'antiInvite');
  assert.equal(messageText({ content: 'salut' }), 'salut');
});

test('R48 : zalgo coupé par des caractères de format (ZWJ) détecté, y compris dans les pseudos', () => {
  const { isZalgo } = require('../src/utils/automod/detectors');
  const { nameViolation } = require('../src/utils/automod/names');
  const marks = ['̸̢', '̛̙', '̧͎'];
  const split = 'zalgo'.split('').map((c) => c + marks.join('‍')).join('');
  assert.equal(isZalgo('zalgo'.split('').map((c) => c + marks.join('')).join('')), true);
  assert.equal(isZalgo(split), true, 'zalgo coupé par ZWJ non détecté');
  assert.equal(nameViolation('a̸̢‍̛̙', { unreadable: true })?.check, 'unreadable');
  // Pas de faux positif : emojis composés (ZWJ) et écritures accentuées.
  assert.equal(isZalgo('👨‍👩‍👧‍👦 élève à côté, Tiếng Việt'), false);
});

test('R49 : log AutoMod — pas de bouton « Retirer le timeout » quand l\'AutoMod n\'a posé aucun timeout', async () => {
  const { AutoModService } = require('../src/services/AutoModService');
  let sent = null;
  let timeouts = 0;
  const cfg = { enabled: true, notify: 'none', ignoredChannels: [], ignoredRoles: [], escalation: { enabled: false }, filters: { badWords: { enabled: true, words: ['connard'], action: 'timeout', duration: '5m' } } };
  const svc = new AutoModService({
    config: { get: () => ({ automod: cfg, moderation: {} }) },
    logging: { send: async (_g, _c, _e, components) => { sent = components; } },
    moderation: { timeout: async () => { timeouts += 1; return { id: 1 }; } },
  });
  const message = (id, until) => ({ id, guild: { id: 'g', members: { me: {} } }, channel: { id: 'c' }, author: { id: `u${id}`, bot: false, toString: () => `<@u${id}>` }, content: 'quel connard',
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } }, communicationDisabledUntilTimestamp: until }, delete: async () => {} });
  const ids = () => (sent ?? []).flatMap((r) => r.components.map((c) => c.data.custom_id));
  // Déjà en timeout 7 jours (posé par un administrateur) : l'AutoMod ne pose rien.
  await svc.handleMessage(message('1', Date.now() + 7 * 86_400_000));
  assert.equal(timeouts, 0);
  assert.equal(ids().some((id) => id.startsWith('cmd:untimeout:revoke:')), false, 'bouton qui lèverait le timeout d\'un autre modérateur');
  // Timeout réellement posé : le bouton est proposé.
  await svc.handleMessage(message('2', 0));
  assert.equal(timeouts, 1);
  assert.equal(ids().some((id) => id.startsWith('cmd:untimeout:revoke:')), true);
});
