'use strict';

/**
 * Revue n° 5 — flux RSS et automatisations : régressions (analyse linéaire, dates bornées,
 * flux sans dates, article refusé par Discord, mention revérifiée, contrôleur d'arrêt relayé).
 * La garde contre le DNS rebinding est testée dans tests/automations.test.js (safeFetch) et
 * de bout en bout dans tests/e2e/review5-automations.e2e.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { memoryDb } = require('./db.helper');
const F = require('../src/utils/feeds');
const { FeedRepository } = require('../src/database/repositories/FeedRepository');
const { FeedService, itemPayload } = require('../src/services/FeedService');
const { mentionAuthorIssue } = require('../src/services/AnnouncementService');

const GUILD = '100000000000000001';
const CHAN = '400000000000000001';
const ROLE = '300000000000000001';
const AUTHOR = '200000000000000001';

const rss = (items) => `<rss version="2.0"><channel><title>Journal</title>${items
  .map((it) => `<item><title>${it.title}</title><guid>${it.id}</guid>${it.date ? `<pubDate>${it.date}</pubDate>` : ''}</item>`)
  .join('')}</channel></rss>`;

// ---------------------------------------------------------------- analyse

test('analyse : « <!…> » répétés sur 1 Mo en temps linéaire (< 200 ms), DOCTYPE à sous-ensemble interne toujours ignoré', () => {
  const MB = 1_048_576;
  for (const unit of ['<!>', '<!a>', '<!x[>]>']) {
    const xml = `<rss><channel><title>t</title><item><guid>1</guid></item></channel>${unit.repeat(Math.floor(MB / unit.length))}</rss>`;
    const start = process.hrtime.bigint();
    const feed = F.parseFeed(xml);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(feed.items.length, 1);
    assert.ok(ms < 200, `${unit} : ${Math.round(ms)} ms pour 1 Mo (quadratique ?)`);
  }
  const doc = F.parseFeed('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "b"><!ELEMENT x ANY>]><rss><channel><title>T</title><item><guid>1</guid><title>x &a;</title></item></channel></rss>');
  assert.equal(doc.title, 'T');
  assert.equal(doc.items[0].title, 'x &a;', 'entité déclarée développée');
});

test('dates : hors 1970–9999 ignorées (horodatage ISO étendu « +020240-… » jamais envoyé à Discord)', () => {
  const feed = F.parseFeed(rss([
    { id: 'a', title: 'Futur', date: 'Mon, 01 Jan 20240 00:00:00 GMT' },
    { id: 'b', title: 'Antique', date: '-001000-01-01T00:00:00Z' },
    { id: 'c', title: 'Normal', date: 'Tue, 02 Jan 2024 00:00:00 GMT' },
  ]));
  const byId = Object.fromEntries(feed.items.map((it) => [it.id, it]));
  assert.equal(byId.a.date, null);
  assert.equal(byId.b.date, null);
  assert.equal(byId.c.date, Date.UTC(2024, 0, 2));
  for (const it of feed.items) {
    const { timestamp } = itemPayload(it).embeds[0];
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/, `${it.id} : ${timestamp}`);
  }
  assert.equal(F.MAX_DATE, Date.UTC(9999, 11, 31, 23, 59, 59));
});

test('flux presque sans dates, du plus ancien au plus récent : les 50 PLUS RÉCENTS sont gardés', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `n${i + 1}`, title: `Article ${i + 1}` }));
  items[0].date = 'Mon, 01 Jan 2024 00:00:00 GMT';
  items[59].date = 'Fri, 01 Mar 2024 00:00:00 GMT';
  const asc = F.parseFeed(rss(items));
  assert.equal(asc.items.length, 50);
  assert.equal(asc.items[0].id, 'n60', 'le plus récent (fin du document) est perdu');
  assert.ok(!asc.items.some((it) => it.id === 'n1'));
  // Ordre décroissant (convention RSS) ou sans aucune date : ordre du document conservé.
  const desc = F.parseFeed(rss([...items].reverse()));
  assert.equal(desc.items[0].id, 'n60');
  const none = F.parseFeed(rss(items.map(({ id, title }) => ({ id, title }))));
  assert.equal(none.items[0].id, 'n1');
});

// ---------------------------------------------------------------- service

/** Monde factice : un salon, un rôle, des membres ; `send` enregistre (ou échoue selon `reject`). */
function world({ mentionable = false, author = 'present', authorPerms = [PermissionFlagsBits.MentionEveryone], channelDeny = [], reject = null } = {}) {
  const sent = [];
  const logs = [];
  const member = author === 'present'
    ? { id: AUTHOR, permissions: new PermissionsBitField(authorPerms) }
    : null;
  const channel = {
    id: CHAN,
    type: ChannelType.GuildText,
    permissionsFor: (m) => new PermissionsBitField(m.permissions.bitfield & ~new PermissionsBitField(channelDeny).bitfield),
    send: async (payload) => {
      const err = reject?.(payload);
      if (err) throw err;
      sent.push(payload);
    },
  };
  let fetches = 0;
  const guild = {
    id: GUILD,
    available: true,
    channels: { cache: new Collection([[CHAN, channel]]) },
    roles: { cache: new Collection([[ROLE, { id: ROLE, name: 'Membres', mentionable }], [GUILD, { id: GUILD, name: '@everyone' }]]) },
    members: {
      me: null,
      cache: new Collection(member ? [[AUTHOR, member]] : []),
      fetch: async () => {
        fetches += 1;
        throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      },
    },
  };
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) }, services: { logging: { send: async (...args) => logs.push(args) } } };
  return { sent, logs, guild, channel, client, fetches: () => fetches };
}

function service(w, xml) {
  const { db } = memoryDb();
  const repo = new FeedRepository(db);
  const state = { xml };
  const http = async (url) => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/rss+xml' }), url: String(url), body: Buffer.from(state.xml) });
  const svc = new FeedService({ client: w.client, feeds: repo, http });
  const row = repo.create({ guildId: GUILD, channelId: CHAN, url: 'https://journal.exemple.fr/rss', roleId: ROLE, synced: true, createdBy: AUTHOR, now: 0 });
  repo.markSeen(row.id, ['old']);
  return { svc, repo, row, state };
}

test('article refusé par Discord (50035) : marqué vu et ignoré, les suivants publiés, aucune erreur comptée', async () => {
  const w = world({ mentionable: true, reject: (p) => (p.embeds[0].title === 'Poison' ? Object.assign(new Error('Invalid Form Body'), { code: 50035 }) : null) });
  const { svc, repo, row, state } = service(w, rss([{ id: 'old', title: 'Ancien' }]));
  state.xml = rss([
    { id: 'new', title: 'Article légitime', date: 'Wed, 03 Jan 2024 00:00:00 GMT' },
    { id: 'p', title: 'Poison', date: 'Tue, 02 Jan 2024 00:00:00 GMT' },
    { id: 'old', title: 'Ancien', date: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]);
  assert.equal(await svc.poll(repo.byId(row.id)), 'posted');
  assert.deepEqual(w.sent.map((p) => p.embeds[0].title), ['Article légitime']);
  assert.ok(repo.isSeen(row.id, 'p'), 'article refusé retenté à chaque lecture');
  assert.equal(repo.byId(row.id).errors, 0);
  assert.equal(repo.byId(row.id).enabled, 1);
  // Lecture suivante : rien de neuf, pas de nouvel essai de l'article refusé.
  assert.equal(await svc.poll(repo.byId(row.id)), 'unchanged');
  // Une autre erreur d'envoi reste une erreur du flux (retentée).
  const w2 = world({ mentionable: true, reject: () => Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
  const s2 = service(w2, rss([{ id: 'old', title: 'Ancien' }, { id: 'n', title: 'Nouveau' }]));
  assert.equal(await s2.svc.poll(s2.repo.byId(s2.row.id)), 'error');
  assert.ok(!s2.repo.isSeen(s2.row.id, 'n'));
});

test('mention d\'un flux revérifiée à chaque publication : auteur parti ou sans « Mentionner @everyone » dans le salon → publié sans mention, log une fois', async () => {
  const items = rss([{ id: 'n1', title: 'Un' }, { id: 'old', title: 'Ancien' }]);
  const cases = [
    { name: 'rôle mentionnable', opts: { mentionable: true, author: 'gone' }, mention: true },
    { name: 'auteur autorisé', opts: {}, mention: true },
    { name: 'auteur parti', opts: { author: 'gone' }, mention: false },
    { name: 'auteur rétrogradé', opts: { authorPerms: [] }, mention: false },
    { name: 'permission retirée dans le salon', opts: { channelDeny: [PermissionFlagsBits.MentionEveryone] }, mention: false },
  ];
  for (const { name, opts, mention } of cases) {
    const w = world(opts);
    const { svc, repo, row, state } = service(w, rss([{ id: 'old', title: 'Ancien' }]));
    state.xml = items;
    assert.equal(await svc.poll(repo.byId(row.id)), 'posted', name);
    const [payload] = w.sent;
    if (mention) {
      assert.equal(payload.content, `<@&${ROLE}>`, name);
      assert.deepEqual(payload.allowedMentions, { parse: [], roles: [ROLE] }, name);
      assert.equal(w.logs.length, 0, name);
    } else {
      assert.equal(payload.content, undefined, `${name} : rôle encore mentionné`);
      assert.deepEqual(payload.allowedMentions, { parse: [] }, name);
      assert.equal(w.logs.length, 1, `${name} : mention retirée sans log`);
      assert.match(w.logs[0][2].data.title, /sans mention/);
      // Nouvel article : toujours sans mention, pas de second log.
      state.xml = rss([{ id: 'n2', title: 'Deux' }, { id: 'n1', title: 'Un' }, { id: 'old', title: 'Ancien' }]);
      assert.equal(await svc.poll(repo.byId(row.id), { now: Date.now() + 1 }), 'posted');
      assert.equal(w.sent[1].content, undefined);
      assert.equal(w.logs.length, 1, `${name} : log répété`);
    }
  }
});

test('mentionAuthorIssue : partagé avec les annonces (comportement des annonces inchangé sans salon)', async () => {
  const w = world({ authorPerms: [PermissionFlagsBits.MentionEveryone], channelDeny: [PermissionFlagsBits.MentionEveryone] });
  assert.equal(await mentionAuthorIssue(w.guild, { roleId: ROLE, authorId: AUTHOR }), null, 'annonces : permission du serveur');
  assert.match(await mentionAuthorIssue(w.guild, { roleId: ROLE, authorId: AUTHOR, channel: w.channel }), /plus la permission/);
  assert.match(await mentionAuthorIssue(w.guild, { roleId: ROLE, authorId: null }), /inconnu/);
  assert.equal(await mentionAuthorIssue(w.guild, { roleId: null, authorId: AUTHOR }), null);
  const gone = world({ author: 'gone' });
  assert.match(await mentionAuthorIssue(gone.guild, { roleId: ROLE, authorId: AUTHOR }), /quitté/);
});

test('lecture : contrôleur local relayé (plus d\'AbortSignal.any lié au signal permanent), passage et arrêt interrompent toujours', async (t) => {
  const w = world({ mentionable: true });
  const { db } = memoryDb();
  const repo = new FeedRepository(db);
  const signals = [];
  const http = (url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('délai dépassé'), { name: 'FetchError', isUserError: true })), { once: true });
  });
  const svc = new FeedService({ client: w.client, feeds: repo, http });
  const realAny = AbortSignal.any;
  let anyCalls = 0;
  AbortSignal.any = (...args) => {
    anyCalls += 1;
    return realAny.apply(AbortSignal, args);
  };
  t.after(() => {
    AbortSignal.any = realAny;
  });
  // Passage du scheduler interrompu (budget épuisé / arrêt) : la lecture en cours s'arrête.
  const tick = new AbortController();
  const p1 = svc.fetchFeed('https://a.exemple.fr/rss', { signal: tick.signal });
  tick.abort();
  await assert.rejects(p1, /délai/);
  // Arrêt du bot : toutes les lectures s'arrêtent.
  const p2 = svc.fetchFeed('https://b.exemple.fr/rss', { signal: new AbortController().signal });
  const p3 = svc.fetchFeed('https://c.exemple.fr/rss');
  await svc.stop();
  await assert.rejects(p2, /délai|arrête/);
  await assert.rejects(p3, /délai|arrête/);
  assert.equal(anyCalls, 0, 'AbortSignal.any retient chaque signal combiné (fuite)');
  assert.ok(signals.every((s) => s.aborted));
  const { getEventListeners } = require('node:events');
  assert.equal(getEventListeners(tick.signal, 'abort').length, 0, 'écouteur non retiré');
});
