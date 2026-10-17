'use strict';

/**
 * Bout en bout : régressions de la revue n° 6 (AutoMod) sur le vrai discord.js — mots interdits
 * piégés (ReDoS), liens et invitations déguisés, quarantaine, AutoMod natif, boutons de levée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });

/** AutoMod réduit aux filtres donnés (les autres désactivés). */
function onlyFilters(h, keys, extra = {}) {
  const filters = Object.fromEntries(Object.keys(h.client.services.config.get(h.guild.id).automod.filters).map((k) => [k, { enabled: keys.includes(k) }]));
  h.configure({ antiraid: { enabled: false }, automod: { enabled: true, filters, newMembers: { enabled: false }, ...extra } });
}

/** Le message d'un membre ordinaire est-il supprimé par le bot ? */
async function isDeleted(h, content, channel = 'general') {
  const mark = h.fake.calls.length;
  const msg = await h.userMessage({ as: 'member', channel, content });
  await h.settle();
  return h.fake.calls.slice(mark).some((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${msg.id}`));
}

/** Plus long blocage de la boucle d'événements pendant `fn`. */
async function maxLoopBlock(fn) {
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return Math.max(max, performance.now() - last);
}

test('R38 : « k.k.k » ajouté par le formulaire, message piégé d\'un membre — le bot ne gèle plus', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyFilters(h, []);
  try {
    const home = await h.slash('automod');
    const lists = await h.click(h.messagesOf(home)[0], 'cmd:automod:nav', { values: ['lists'] });
    const open = await h.click(h.messagesOf(lists)[0], 'cmd:automod:list:words');
    await h.submitModal(open, { add: 'k.k.k\na a a a a a a a a a', remove: '' });
    const cfg = h.client.services.config.get(h.guild.id).automod.filters.badWords;
    assert.ok(cfg.words.includes('k.k.k') && cfg.words.includes('a a a a a a a a a a'), JSON.stringify(cfg.words));
    assert.equal(cfg.enabled, true);

    let deleted = null;
    const block = await maxLoopBlock(async () => {
      deleted = await isDeleted(h, `${'k'.repeat(1999)}b`);
    });
    assert.equal(deleted, false);
    // Avant le correctif : 7 s de boucle bloquée (tous les serveurs figés).
    assert.ok(block < 500, `boucle d'événements bloquée ${Math.round(block)} ms`);
    assert.equal(await isDeleted(h, 'espèce de k k k'), true, 'le mot composé est toujours détecté');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R39 / R40 : liens déguisés (« ?@ », point idéographique, adresse IP) supprimés ; /afk les refuse', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    // Anti-arnaques seul : le faux Nitro est vu derrière « ?@discord.com » ou « 。 ».
    onlyFilters(h, ['antiPhishing']);
    for (const url of ['https://dlscord-gift.ru/claim', 'https://dlscord-gift.ru?@discord.com/claim', 'https://dlscord-gift.ru#@discord.com/claim',
      'https://dlscord-gift.ru\\@discord.com/claim', 'https://dlscord-gift。ru/claim', 'https://dlscord-gift．ru/claim', 'http://45.13.227.9/discord-nitro']) {
      assert.equal(await isDeleted(h, `Nitro gratuit !! ${url} @everyone`), true, `arnaque non supprimée : ${url}`);
    }
    assert.equal(await isDeleted(h, 'le salon des annonces : https://discord.com/channels/1/2'), false, 'lien Discord légitime');

    // Anti-liens seul : n'importe quel domaine caché derrière discord.com, ou une adresse IP.
    onlyFilters(h, ['antiLink']);
    for (const content of ['regarde https://evil.ru?@discord.com/login', 'regarde https://evil%2eru/login', 'regarde http://755623689/', 'regarde http://[2a01:4f8::1]/']) {
      assert.equal(await isDeleted(h, content), true, `lien non supprimé : ${content}`);
    }
    assert.equal(await isDeleted(h, 'regarde https://discord.com\\@evil.ru (le navigateur reste sur discord.com)'), false);

    // /afk : la raison passe par les mêmes filtres.
    const rec = await h.slash('afk', [opt('raison', 3, 'ici https://evil.ru?@discord.com/x')], { as: 'member' });
    assert.equal(h.isError(rec), true, 'raison avec lien déguisé acceptée');
    assert.equal(h.client.repositories.afk.get(h.guild.id, IDS.users.member) ?? null, null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R41 : invitations encodées supprimées par l\'anti-invitations', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    onlyFilters(h, ['antiInvite']);
    for (const url of ['https://discord.gg/./raidzone', 'https://discord.com/x/../invite/raidzone', 'https://disc%6Frd.gg/raidzone',
      'https://discord.gg\\raidzone', 'https://discord。gg/raidzone']) {
      assert.equal(await isDeleted(h, `rejoins ${url}`), true, `invitation non supprimée : ${url}`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
