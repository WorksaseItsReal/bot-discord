'use strict';

/**
 * Flux RSS / YouTube (/flux) et automatisations (/automatisations) : analyseur, requêtes
 * sortantes sûres (serveur HTTP LOCAL, jamais le vrai réseau), dépôt, service des flux,
 * fonctions pures des automatisations, file de publication, présence du bot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ChannelType, Collection, PermissionsBitField, ActivityType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { defaultGuildConfig } = require('../src/config/defaults');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');
const F = require('../src/utils/feeds');
const S = require('../src/utils/safeFetch');
const { FeedRepository, MAX_SEEN_PER_FEED } = require('../src/database/repositories/FeedRepository');
const { AutoThreadCounterRepository } = require('../src/database/repositories/AutoThreadCounterRepository');
const { FeedService, itemPayload, MAX_ERRORS, MAX_POSTS_PER_POLL } = require('../src/services/FeedService');
const A = require('../src/services/AutomationService');
const P = require('../src/utils/presence');
const flux = require('../src/commands/configuration/flux');

const GUILD = '100000000000000001';
const CHAN = '400000000000000001';
const ROLE = '300000000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- documents de test

const RSS = (items, { title = 'Blog &amp; Cie' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${title}</title><link>https://blog.exemple.fr/</link>
${items.map((it) => `<item><title>${it.title}</title><link>${it.link ?? `https://blog.exemple.fr/${it.id}`}</link><guid isPermaLink="false">${it.id}</guid>${it.date ? `<pubDate>${new Date(it.date).toUTCString()}</pubDate>` : ''}<description>${it.description ?? ''}</description>${it.extra ?? ''}</item>`).join('\n')}
</channel></rss>`;

const YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
 <id>yt:channel:abcdefghijklmnopqrstuv</id><title>Ma Chaîne</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
 <entry>
  <id>yt:video:VID1</id><yt:videoId>VID1</yt:videoId><title>Vidéo &quot;un&quot;</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=VID1"/>
  <published>2025-03-01T10:00:00+00:00</published><updated>2025-03-02T10:00:00+00:00</updated>
  <media:group><media:title>Vidéo un</media:title><media:content url="https://www.youtube.com/v/VID1?version=3" type="application/x-shockwave-flash"/>
   <media:thumbnail url="https://i1.ytimg.com/vi/VID1/hqdefault.jpg" width="480" height="360"/><media:description>Description de la vidéo</media:description></media:group>
 </entry>
</feed>`;

// ---------------------------------------------------------------- schéma, défauts, logs

test('migration 22 : tables feeds, feed_items (cascade) et auto_thread_counters ; bloc de configuration dédié', () => {
  const m = migrations.find((x) => x.id === 22);
  assert.ok(m && /CREATE TABLE IF NOT EXISTS feeds/.test(m.up) && /feed_items/.test(m.up) && /auto_thread_counters/.test(m.up));
  const { db } = memoryDb();
  const cols = db.prepare('PRAGMA table_info(feeds)').all().map((c) => c.name);
  for (const c of ['guild_id', 'channel_id', 'url', 'role_id', 'filter', 'etag', 'last_modified', 'synced', 'enabled', 'errors', 'last_checked_at']) assert.ok(cols.includes(c), c);
  const d = defaultGuildConfig.automations;
  assert.deepEqual(d.crosspost, { enabled: false, channels: [] });
  assert.equal(d.autoThreads.mode, 'all');
  assert.equal(d.autoThreads.archiveMinutes, 1440);
  assert.equal(d.voiceRole.enabled, false);
  assert.equal(d.boost.enabled, false);
  assert.equal(EVENT_CATEGORY.feeds, 'server');
  assert.equal(EVENT_CATEGORY.automations, 'server');
});

// ---------------------------------------------------------------- analyseur

test('parseFeed RSS 2.0 : CDATA, entités, HTML retiré, image, liens relatifs, tri par date, guid', () => {
  const xml = RSS([
    { id: 'a1', title: '<![CDATA[Premier <b>article</b> & co]]>', date: Date.UTC(2025, 0, 1), description: '&lt;p&gt;Été &amp;amp; &amp;eacute;t&amp;eacute;&lt;img src="https://img.exemple.fr/a.png"&gt;&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;' },
    { id: 'a2', title: 'Second &#233;pisode &#x1F680;', link: '/relatif', date: Date.UTC(2025, 0, 3), extra: '<media:thumbnail url="https://img.exemple.fr/t.jpg"/>' },
    { id: 'a3', title: 'Lien piégé', link: 'javascript:alert(1)', date: Date.UTC(2025, 0, 2) },
  ]);
  const feed = F.parseFeed(xml, { baseUrl: 'https://blog.exemple.fr/feed.xml' });
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, 'Blog & Cie');
  assert.deepEqual(feed.items.map((i) => i.id), ['a2', 'a3', 'a1'], 'plus récents d\'abord');
  const [second, trap, first] = feed.items;
  assert.equal(first.title, 'Premier article & co');
  assert.equal(first.summary, 'Été & été');
  assert.equal(first.image, 'https://img.exemple.fr/a.png', 'image tirée de la description');
  assert.equal(second.title, 'Second épisode 🚀');
  assert.equal(second.link, 'https://blog.exemple.fr/relatif');
  assert.equal(second.image, 'https://img.exemple.fr/t.jpg');
  assert.equal(trap.link, null, 'lien non http(s) écarté');
  assert.equal(first.date, Date.UTC(2025, 0, 1));
});

test('parseFeed Atom (YouTube) : media:group, miniature, description, lien alternate', () => {
  const feed = F.parseFeed(YOUTUBE);
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, 'Ma Chaîne');
  assert.equal(feed.items.length, 1);
  const v = feed.items[0];
  assert.equal(v.id, 'yt:video:VID1');
  assert.equal(v.title, 'Vidéo "un"');
  assert.equal(v.link, 'https://www.youtube.com/watch?v=VID1');
  assert.equal(v.image, 'https://i1.ytimg.com/vi/VID1/hqdefault.jpg');
  assert.equal(v.summary, 'Description de la vidéo');
  assert.equal(v.date, Date.parse('2025-03-01T10:00:00Z'));
});

test('parseFeed RSS 1.0 (RDF), extrait ≤ 300, doublons, document qui n\'est pas un flux', () => {
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>RDF</title></channel>
    <item><title>Un</title><link>https://r.exemple.fr/1</link><description>${'mot '.repeat(200)}</description></item>
    <item><title>Un bis</title><link>https://r.exemple.fr/1</link></item></rdf:RDF>`;
  const feed = F.parseFeed(rdf);
  assert.equal(feed.title, 'RDF');
  assert.equal(feed.items.length, 1, 'doublon (même lien) ignoré');
  assert.ok(feed.items[0].summary.length <= 300 && feed.items[0].summary.endsWith('…'));
  assert.throws(() => F.parseFeed('<html><body>Bonjour</body></html>'), /pas un flux/);
  assert.throws(() => F.parseFeed(''), /pas un flux/);
  // DOCTYPE avec entités déclarées : jamais développées.
  const bomb = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><rss><channel><title>&b;</title></channel></rss>`;
  assert.equal(F.parseFeed(bomb).title, '&b;');
});

test('analyseur : linéaire sur des documents hostiles (aucun backtracking catastrophique)', () => {
  const hostile = [
    `<rss><channel>${'<a "'.repeat(150_000)}`,
    '<'.repeat(1_000_000),
    `<rss><channel>${'<item><title>x</title>'.repeat(30_000)}`,
    `<rss><channel>${'<x>'.repeat(150_000)}</channel></rss>`,
    `<rss><channel><item><description>${'&lt;b'.repeat(150_000)}</description></item></channel></rss>`,
    `<rss><channel><item><title>${'&#'.repeat(300_000)}</title></item></channel></rss>`,
    `<rss><channel><item><description><![CDATA[${'<img src="'.repeat(80_000)}]]></description></item></channel></rss>`,
  ];
  for (const doc of hostile) {
    const start = Date.now();
    try {
      F.parseFeed(doc);
    } catch {
      /* refus attendu pour certains */
    }
    assert.ok(Date.now() - start < 1_500, `trop lent (${Date.now() - start} ms) : ${doc.slice(0, 30)}`);
  }
  let start = Date.now();
  F.htmlToText('<a'.repeat(400_000));
  F.decodeEntities('&amp'.repeat(200_000));
  assert.ok(Date.now() - start < 1_000);
  start = Date.now();
  assert.equal(F.htmlToText('a < b et c > d'), 'a < b et c > d', '« < » isolé conservé');
  assert.equal(F.decodeEntities('&#0; &#xD800; &bogus; &lt;'), '� � &bogus; <');
});

test('normalizeFeedUrl : YouTube (chaîne, identifiant, feeds), @pseudo refusé, schémas refusés', () => {
  const yt = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv';
  assert.deepEqual(F.normalizeFeedUrl('UCabcdefghijklmnopqrstuv'), { url: yt, youtube: true });
  assert.deepEqual(F.normalizeFeedUrl('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos'), { url: yt, youtube: true });
  assert.deepEqual(F.normalizeFeedUrl('youtube.com/channel/UCabcdefghijklmnopqrstuv'), { url: yt, youtube: true });
  assert.deepEqual(F.normalizeFeedUrl(`${yt}&foo=1`), { url: yt, youtube: true });
  assert.equal(F.normalizeFeedUrl('https://www.youtube.com/feeds/videos.xml?playlist_id=PLabcdefghij').url, 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabcdefghij');
  assert.throws(() => F.normalizeFeedUrl('https://www.youtube.com/@gadget'), /identifiant de la chaîne/);
  assert.throws(() => F.normalizeFeedUrl('https://www.youtube.com/watch?v=abc'), /YouTube non reconnue/);
  assert.equal(F.normalizeFeedUrl('blog.exemple.fr/feed#x').url, 'https://blog.exemple.fr/feed');
  for (const bad of ['', 'ftp://exemple.fr/feed', 'javascript:alert(1)', 'https://user:pw@exemple.fr/', 'file:///etc/passwd', 'a b', 'x'.repeat(501)]) {
    assert.throws(() => F.normalizeFeedUrl(bad), F.FeedError, bad);
  }
  assert.ok(F.isYoutubeFeed(yt));
  assert.ok(!F.isYoutubeFeed('https://blog.exemple.fr/feed'));
  assert.ok(F.matchesFilter({ title: 'Mise à jour Été', summary: '' }, 'ete'));
  assert.ok(!F.matchesFilter({ title: 'Autre', summary: 'rien' }, 'été'));
  assert.ok(F.matchesFilter({ title: 'x' }, null));
});

test('decodeBody : en-tête HTTP, BOM et déclaration XML (ISO-8859-1)', () => {
  const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf\xe9</title></channel></rss>', 'latin1');
  assert.equal(F.parseFeed(F.decodeBody(latin, 'application/xml')).title, 'Café');
  assert.equal(F.decodeBody(Buffer.from('é', 'utf8'), 'text/xml; charset=utf-8'), 'é');
  assert.equal(F.decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok')]), null), 'ok');
  assert.equal(F.decodeBody(Buffer.from('ok'), 'text/xml; charset=inconnu-42'), 'ok', 'jeu de caractères inconnu : UTF-8');
});

// ---------------------------------------------------------------- requêtes sûres

test('adresses privées : IPv4, IPv6 locales, IPv4 mappées, NAT64, 6to4 ; noms internes', () => {
  for (const ip of ['127.0.0.1', '10.0.0.8', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.ok(S.isBlockedAddress(ip), ip);
  }
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00:abcd::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:0:a00:1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', 'ff02::1', '2001:db8::1', 'fe80::1%eth0']) {
    assert.ok(S.isBlockedAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4007::200e']) assert.ok(!S.isBlockedAddress(ip), ip);
  assert.ok(S.isBlockedAddress('pas-une-ip'));
  // Injection de test : 127.0.0.1 UNIQUEMENT.
  assert.ok(!S.isBlockedAddress('127.0.0.1', { allowLoopback: true }));
  for (const ip of ['127.0.0.2', '::1', '::ffff:127.0.0.1', '10.0.0.1']) assert.ok(S.isBlockedAddress(ip, { allowLoopback: true }), ip);
  // Formes numériques normalisées par URL.
  for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://LOCALHOST./', 'http://x.localhost/', 'http://nas.local/', 'http://db.internal/', 'http://intranet/', 'http://[fe80::1]/']) {
    assert.throws(() => S.checkHostname(new URL(u).hostname), /privées ou locales/, u);
  }
  assert.deepEqual(S.checkHostname('blog.exemple.fr'), { host: 'blog.exemple.fr', literal: false });
});

/** Serveur HTTP local (127.0.0.1) piloté par une table de routes. */
async function localServer(t) {
  const routes = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    const route = routes.get(req.url.split('?')[0]);
    if (!route) {
      res.writeHead(404).end('introuvable');
      return;
    }
    if (typeof route === 'function') return route(req, res);
    const { status = 200, headers = {}, body = '' } = route;
    res.writeHead(status, { 'content-type': 'application/rss+xml; charset=utf-8', ...headers });
    res.end(body);
    return undefined;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { routes, hits, base, url: (path) => `${base}${path}` };
}

test('safeFetch : 127.0.0.1 refusé sans injection, accepté avec ; DNS : toutes les adresses vérifiées, ports filtrés', async (t) => {
  const srv = await localServer(t);
  srv.routes.set('/ok', { body: 'bonjour' });
  const port = Number(new URL(srv.base).port);
  await assert.rejects(S.safeFetch(srv.url('/ok')), /privées ou locales/);
  const res = await S.safeFetch(srv.url('/ok'), { allowLoopback: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'bonjour');
  // Un domaine dont UNE des adresses est privée est refusé (aucune requête).
  const lookup = (addresses) => async (host, opts) => {
    assert.deepEqual(opts, { all: true, verbatim: true });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const named = `http://flux.exemple.fr:${port}/ok`;
  for (const addrs of [['10.0.0.1'], ['93.184.216.34', '192.168.0.10'], ['::1'], ['::ffff:169.254.169.254'], ['fd00::5'], ['127.0.0.1']]) {
    await assert.rejects(S.safeFetch(named, { lookup: lookup(addrs), allowedPorts: [port] }), /adresse privée/, addrs.join(','));
  }
  await assert.rejects(S.safeFetch(named, { lookup: async () => { throw new Error('ENOTFOUND'); }, allowedPorts: [port] }), /introuvable/);
  assert.equal(srv.hits.length, 1, 'requête envoyée vers une adresse refusée');
  // Adresse validée : le socket se connecte à EXACTEMENT cette adresse (nom d'hôte conservé dans Host).
  const ok = await S.safeFetch(named, { lookup: lookup(['127.0.0.1']), allowLoopback: true, allowedPorts: [port] });
  assert.equal(ok.body.toString(), 'bonjour');
  assert.equal(srv.hits.at(-1).headers.host, `flux.exemple.fr:${port}`);
  // IP littérale : aucune résolution DNS.
  await S.safeFetch(srv.url('/ok'), { allowLoopback: true, lookup: () => assert.fail('résolution inutile') });
  // Ports : 80, 443, 8080 et 8443 seulement (jamais SSH, SMTP… d'un hôte public).
  assert.deepEqual(S.ALLOWED_PORTS, [80, 443, 8080, 8443]);
  await assert.rejects(S.safeFetch('https://flux.exemple.fr:22/', { lookup: lookup(['93.184.216.34']) }), /port 22 refusé/);
  await assert.rejects(S.safeFetch(named, { lookup: lookup(['93.184.216.34']) }), new RegExp(`port ${port} refusé`));
  // Schémas et identifiants refusés.
  await assert.rejects(S.safeFetch('file:///etc/passwd'), /http\(s\)/);
  await assert.rejects(S.safeFetch('https://a:b@flux.exemple.fr/'), /identifiants/);
});

test('safeFetch : DNS rebinding — l\'adresse est revalidée À LA CONNEXION (plus de seconde résolution non vérifiée)', async (t) => {
  const srv = await localServer(t);
  srv.routes.set('/admin', { body: '<rss><channel><title>interne</title></channel></rss>' });
  const port = Number(new URL(srv.base).port);
  // Résolveur à TTL 0 : d'abord une adresse publique (vérification), puis 127.0.0.1 (connexion).
  for (const protocol of ['http', 'https']) {
    const answers = [];
    let n = 0;
    const lookup = async () => {
      const address = n++ % 2 === 0 ? '93.184.216.34' : '127.0.0.1';
      answers.push(address);
      return [{ address, family: 4 }];
    };
    await assert.rejects(S.safeFetch(`${protocol}://rebind.attaquant.exemple:${port}/admin`, { lookup, allowedPorts: [port] }), /adresse privée ou locale/, protocol);
    assert.deepEqual(answers, ['93.184.216.34', '127.0.0.1'], `${protocol} : résolution de connexion non vérifiée`);
  }
  assert.equal(srv.hits.length, 0, 'le serveur interne a été atteint');
  // guardedLookup (signature de dns.lookup) : toutes les adresses rendues, ou erreur.
  const guarded = S.guardedLookup({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }], allowLoopback: false });
  const all = await new Promise((resolve, reject) => guarded('flux.exemple.fr', { all: true }, (err, list) => (err ? reject(err) : resolve(list))));
  assert.deepEqual(all.map((a) => a.address), ['93.184.216.34', '2606:2800:220:1::1']);
  const one = await new Promise((resolve, reject) => guarded('flux.exemple.fr', {}, (err, address, family) => (err ? reject(err) : resolve([address, family]))));
  assert.deepEqual(one, ['93.184.216.34', 4]);
  const mixed = S.guardedLookup({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }], allowLoopback: false });
  await assert.rejects(new Promise((resolve, reject) => mixed('flux.exemple.fr', { all: true }, (err, list) => (err ? reject(err) : resolve(list)))), /adresse privée/);
});

test('safeFetch : corps compressé (gzip, deflate, br) décodé sous le même plafond, encodage inconnu et en-têtes énormes refusés', async (t) => {
  const zlib = require('node:zlib');
  const srv = await localServer(t);
  const doc = Buffer.from('<rss><channel><title>Été « compressé »</title></channel></rss>'.repeat(50));
  const bodies = { gzip: zlib.gzipSync(doc), deflate: zlib.deflateSync(doc), deflateraw: zlib.deflateRawSync(doc), br: zlib.brotliCompressSync(doc) };
  for (const [name, body] of Object.entries(bodies)) {
    srv.routes.set(`/${name}`, { headers: { 'content-encoding': name === 'deflateraw' ? 'deflate' : name }, body });
  }
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024));
  srv.routes.set('/bombe', { headers: { 'content-encoding': 'gzip' }, body: bomb });
  srv.routes.set('/bombe-br', { headers: { 'content-encoding': 'br' }, body: zlib.brotliCompressSync(Buffer.alloc(8 * 1024 * 1024)) });
  srv.routes.set('/zstd', { headers: { 'content-encoding': 'zstd' }, body: 'x' });
  srv.routes.set('/entetes', (req, res) => {
    res.writeHead(200, { 'x-enorme': 'a'.repeat(40_000) });
    res.end('x');
  });
  for (const name of Object.keys(bodies)) {
    const res = await S.safeFetch(srv.url(`/${name}`), { allowLoopback: true });
    assert.ok(res.body.equals(doc), name);
  }
  assert.equal(srv.hits.at(-1).headers['accept-encoding'], 'gzip, deflate, br');
  assert.ok(bomb.length < 100_000);
  await assert.rejects(S.safeFetch(srv.url('/bombe'), { allowLoopback: true }), /trop volumineux/);
  await assert.rejects(S.safeFetch(srv.url('/bombe-br'), { allowLoopback: true }), /trop volumineux/);
  await assert.rejects(S.safeFetch(srv.url('/zstd'), { allowLoopback: true }), /non pris en charge/);
  await assert.rejects(S.safeFetch(srv.url('/entetes'), { allowLoopback: true }), /connexion impossible/);
});

test('safeFetch : redirections revalidées (privée refusée), 3 sauts au plus, relatives suivies', async (t) => {
  const srv = await localServer(t);
  srv.routes.set('/final', { body: 'arrivé' });
  srv.routes.set('/r1', { status: 302, headers: { location: '/r2' } });
  srv.routes.set('/r2', { status: 301, headers: { location: srv.url('/r3') } });
  srv.routes.set('/r3', { status: 307, headers: { location: '/final' } });
  srv.routes.set('/r0', { status: 308, headers: { location: '/r1' } });
  srv.routes.set('/meta', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  srv.routes.set('/v6', { status: 302, headers: { location: 'http://[::1]:80/' } });
  srv.routes.set('/ftp', { status: 302, headers: { location: 'ftp://exemple.fr/' } });
  srv.routes.set('/empty', { status: 302 });
  const res = await S.safeFetch(srv.url('/r1'), { allowLoopback: true });
  assert.equal(res.body.toString(), 'arrivé');
  assert.equal(res.redirects, 3);
  await assert.rejects(S.safeFetch(srv.url('/r0'), { allowLoopback: true }), /trop de redirections/);
  await assert.rejects(S.safeFetch(srv.url('/meta'), { allowLoopback: true }), /privées ou locales/);
  await assert.rejects(S.safeFetch(srv.url('/v6'), { allowLoopback: true }), /privées ou locales/);
  await assert.rejects(S.safeFetch(srv.url('/ftp'), { allowLoopback: true }), /http\(s\)/);
  await assert.rejects(S.safeFetch(srv.url('/empty'), { allowLoopback: true }), /sans destination/);
  assert.ok(!srv.hits.some((h) => h.url.includes('meta-data')));
});

test('safeFetch : taille maximale (Content-Length et flux), délai dépassé', async (t) => {
  const srv = await localServer(t);
  srv.routes.set('/gros', { body: 'x'.repeat(2_000) });
  srv.routes.set('/chunked', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    let n = 0;
    const timer = setInterval(() => {
      res.write('y'.repeat(500));
      n += 1;
      if (n === 10) {
        clearInterval(timer);
        res.end();
      }
    }, 2);
  });
  srv.routes.set('/lent', () => {});
  await assert.rejects(S.safeFetch(srv.url('/gros'), { allowLoopback: true, maxBytes: 1_000 }), /trop volumineux/);
  await assert.rejects(S.safeFetch(srv.url('/chunked'), { allowLoopback: true, maxBytes: 1_200 }), /trop volumineux/);
  const start = Date.now();
  await assert.rejects(S.safeFetch(srv.url('/lent'), { allowLoopback: true, timeoutMs: 150 }), /délai/);
  assert.ok(Date.now() - start < 2_000);
  // Interruption externe (arrêt du bot).
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(S.safeFetch(srv.url('/lent'), { allowLoopback: true, signal: ac.signal }), /délai/);
  assert.equal(S.MAX_BYTES, 1_048_576);
  assert.equal(S.TIMEOUT_MS, 10_000);
});

// ---------------------------------------------------------------- dépôt

test('FeedRepository : création, unicité, articles vus (200 au plus, présents conservés), erreurs, échéances', () => {
  const { db } = memoryDb();
  const repo = new FeedRepository(db);
  const row = repo.create({ guildId: GUILD, channelId: CHAN, url: 'https://a.fr/rss', title: 'A', synced: true, lastCheckedAt: 1_000 });
  assert.equal(row.synced, 1);
  assert.throws(() => repo.create({ guildId: GUILD, channelId: CHAN, url: 'https://a.fr/rss' }), /UNIQUE/);
  assert.equal(repo.find(GUILD, CHAN, 'https://a.fr/rss').id, row.id);
  assert.equal(repo.get('autre', row.id), null);
  // 250 articles vus en plusieurs lectures : 200 gardés, les plus récents.
  for (let k = 0; k < 5; k += 1) repo.markSeen(row.id, Array.from({ length: 50 }, (_, i) => `g${k * 50 + i}`), 10_000 + k);
  assert.equal(repo.countSeen(row.id), MAX_SEEN_PER_FEED);
  assert.ok(!repo.isSeen(row.id, 'g0') && repo.isSeen(row.id, 'g249'));
  // Un article encore présent dans le flux est « rafraîchi » à chaque lecture : jamais oublié.
  repo.markSeen(row.id, ['keep'], 40_000);
  for (let k = 0; k < 3; k += 1) repo.markSeen(row.id, ['keep', ...Array.from({ length: 60 }, (_, i) => `m${k * 60 + i}`)], 50_000 + k);
  assert.ok(repo.isSeen(row.id, 'keep'), 'article présent à chaque lecture conservé');
  // Erreurs consécutives, désactivation, réactivation.
  assert.equal(repo.recordError(row.id, 'HTTP 500', 2_000), 1);
  assert.equal(repo.recordError(row.id, 'HTTP 500', 2_000), 2);
  repo.recordSuccess(row.id, { etag: '"v1"', now: 3_000 });
  assert.equal(repo.byId(row.id).errors, 0);
  assert.equal(repo.byId(row.id).etag, '"v1"');
  repo.disable(row.id, 'cassé');
  assert.equal(repo.countEnabled(GUILD), 0);
  assert.deepEqual(repo.due(GUILD, Date.now()), []);
  assert.ok(repo.enable(GUILD, row.id));
  assert.equal(repo.byId(row.id).last_checked_at, null, 'réactivé : relu au prochain passage');
  const second = repo.create({ guildId: GUILD, channelId: CHAN, url: 'https://b.fr/rss', lastCheckedAt: 500 });
  assert.deepEqual(repo.due(GUILD, 1_000).map((r) => r.id), [row.id, second.id], 'jamais lu d\'abord');
  assert.ok(repo.delete(GUILD, row.id));
  assert.equal(repo.countSeen(row.id), 0, 'articles supprimés en cascade');
  const counters = new AutoThreadCounterRepository(db);
  assert.deepEqual([counters.next(GUILD, CHAN), counters.next(GUILD, CHAN), counters.next(GUILD, '2')], [1, 2, 1]);
});

// ---------------------------------------------------------------- service des flux

/** Faux serveur Discord minimal pour le service (salons qui enregistrent les envois). */
function fakeWorld({ channelType = ChannelType.GuildText } = {}) {
  const sent = [];
  const logs = [];
  const channel = { id: CHAN, type: channelType, send: async (payload) => sent.push(payload) };
  const guild = {
    id: GUILD,
    available: true,
    channels: { cache: new Collection([[CHAN, channel]]) },
    roles: { cache: new Collection([[ROLE, { id: ROLE, name: 'Notifs', mentionable: true }], [GUILD, { id: GUILD, name: '@everyone' }]]) },
    members: { me: null },
  };
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) }, services: { logging: { send: async (...args) => logs.push(args) } } };
  return { sent, logs, channel, guild, client };
}

function feedService(world, db) {
  const repo = new FeedRepository(db);
  const svc = new FeedService({ client: world.client, feeds: repo, allowLoopback: true });
  world.client.repositories = { feeds: repo };
  return { svc, repo };
}

test('FeedService : première lecture sans publier l\'historique, nouveautés publiées, rôle mentionné explicitement', async (t) => {
  const srv = await localServer(t);
  const w = fakeWorld();
  const { db } = memoryDb();
  const { svc, repo } = feedService(w, db);
  let items = [{ id: 'old1', title: 'Ancien 1', date: Date.UTC(2025, 0, 1) }, { id: 'old2', title: 'Ancien 2', date: Date.UTC(2025, 0, 2) }];
  srv.routes.set('/rss', () => {});
  srv.routes.set('/rss', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(RSS(items));
  });
  const { row, feed } = await svc.add({ guild: w.guild, channelId: CHAN, input: srv.url('/rss'), roleId: ROLE, by: '1' });
  assert.equal(feed.items.length, 2);
  assert.equal(w.sent.length, 0, 'historique publié');
  assert.equal(repo.countSeen(row.id), 2);
  await assert.rejects(svc.add({ guild: w.guild, channelId: CHAN, input: srv.url('/rss') }), /déjà publié/);

  // Rien de neuf : rien n'est publié.
  assert.equal(await svc.poll(repo.byId(row.id)), 'unchanged');
  assert.equal(w.sent.length, 0);

  // Deux nouveautés : publiées de la plus ancienne à la plus récente.
  items = [{ id: 'new2', title: 'Nouveau 2', date: Date.UTC(2025, 0, 4), description: `<p>${'Texte long '.repeat(60)}</p>`, extra: '<enclosure url="https://img.exemple.fr/n2.jpg" type="image/jpeg"/>' }, { id: 'new1', title: 'Nouveau *1*', date: Date.UTC(2025, 0, 3) }, ...items];
  assert.equal(await svc.poll(repo.byId(row.id)), 'posted');
  assert.equal(w.sent.length, 2);
  const [first, second] = w.sent;
  assert.equal(first.embeds[0].title, 'Nouveau \\*1\\*', 'Markdown échappé');
  assert.equal(first.content, `<@&${ROLE}>`);
  assert.deepEqual(first.allowedMentions, { parse: [], roles: [ROLE] });
  assert.equal(second.embeds[0].url, 'https://blog.exemple.fr/new2');
  assert.equal(second.embeds[0].image.url, 'https://img.exemple.fr/n2.jpg');
  assert.ok(second.embeds[0].description.length <= 320, 'extrait ≤ 300 (+ échappements)');
  assert.equal(second.embeds[0].timestamp, new Date(Date.UTC(2025, 0, 4)).toISOString());
  assert.equal(second.components[0].components[0].url ?? second.components[0].components[0].data?.url, 'https://blog.exemple.fr/new2');
  assert.equal(repo.byId(row.id).posted_count, 2);

  // Déduplication : relire ne republie rien.
  assert.equal(await svc.poll(repo.byId(row.id)), 'unchanged');
  assert.equal(w.sent.length, 2);
});

test('FeedService : filtre, plafond de 5 publications, ETag / Last-Modified (304), @everyone jamais mentionné', async (t) => {
  const srv = await localServer(t);
  const w = fakeWorld();
  const { db } = memoryDb();
  const { svc, repo } = feedService(w, db);
  let items = [{ id: 'base', title: 'Base' }];
  const etag = '"v1"';
  srv.routes.set('/rss', (req, res) => {
    if (req.headers['if-none-match'] === etag && items.length === 1) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag, 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' });
    res.end(RSS(items));
  });
  const { row } = await svc.add({ guild: w.guild, channelId: CHAN, input: srv.url('/rss'), roleId: GUILD, filter: 'été' });
  assert.equal(repo.byId(row.id).etag, etag);
  assert.equal(await svc.poll(repo.byId(row.id)), 'unchanged');
  assert.equal(srv.hits.at(-1).headers['if-none-match'], etag);
  assert.equal(srv.hits.at(-1).headers['if-modified-since'], 'Wed, 01 Jan 2025 00:00:00 GMT');
  assert.match(srv.hits.at(-1).headers['user-agent'], /InspecteurGadget/);

  items = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `ete${i}`, title: `Spécial Été ${i}`, date: Date.UTC(2025, 1, 10 - i) })),
    { id: 'hiver', title: 'Hiver', date: Date.UTC(2025, 1, 20) },
    ...items,
  ];
  assert.equal(await svc.poll(repo.byId(row.id)), 'posted');
  assert.equal(w.sent.length, MAX_POSTS_PER_POLL, 'au plus 5 publications par lecture');
  assert.deepEqual(w.sent.map((p) => p.embeds[0].title), ['Spécial Été 4', 'Spécial Été 3', 'Spécial Été 2', 'Spécial Été 1', 'Spécial Été 0']);
  for (const p of w.sent) {
    assert.equal(p.content, undefined, '@everyone ne doit jamais être mentionné');
    assert.deepEqual(p.allowedMentions, { parse: [] });
  }
  assert.ok(repo.isSeen(row.id, 'hiver'), 'article filtré marqué comme vu');
  assert.ok(repo.isSeen(row.id, 'ete7'), 'au-delà du plafond : marqué comme vu');
  assert.equal(await svc.poll(repo.byId(row.id)), 'unchanged');
  assert.equal(w.sent.length, MAX_POSTS_PER_POLL);
});

test('FeedService : erreurs consécutives → désactivé à la 10e (log), relecture de la ligne, salon inutilisable', async (t) => {
  const srv = await localServer(t);
  const w = fakeWorld();
  const { db } = memoryDb();
  const { svc, repo } = feedService(w, db);
  let mode = 'ok';
  let items = [{ id: 'a', title: 'A' }];
  srv.routes.set('/rss', (req, res) => {
    if (mode === 'fail') return res.writeHead(500).end('boum');
    if (mode === 'html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    res.writeHead(200).end(RSS(items));
    return undefined;
  });
  const { row } = await svc.add({ guild: w.guild, channelId: CHAN, input: srv.url('/rss') });
  mode = 'fail';
  for (let i = 1; i < MAX_ERRORS; i += 1) assert.equal(await svc.poll(repo.byId(row.id)), 'error');
  assert.equal(repo.byId(row.id).errors, MAX_ERRORS - 1);
  assert.equal(repo.byId(row.id).enabled, 1);
  mode = 'ok';
  assert.equal(await svc.poll(repo.byId(row.id)), 'unchanged');
  assert.equal(repo.byId(row.id).errors, 0, 'succès : compteur remis à zéro');
  mode = 'html';
  for (let i = 1; i <= MAX_ERRORS; i += 1) await svc.poll(repo.byId(row.id));
  const disabled = repo.byId(row.id);
  assert.equal(disabled.enabled, 0);
  assert.match(disabled.last_error, /pas un flux/);
  assert.equal(w.logs.length, 1, 'désactivation journalisée');
  assert.equal(w.logs[0][1], 'server');
  assert.deepEqual(w.logs[0][4], { event: 'feeds' });
  assert.equal(await svc.poll(disabled), 'skipped', 'flux désactivé : relu, rien fait');

  // Flux retiré pendant la requête : relu, rien publié.
  mode = 'ok';
  repo.enable(GUILD, row.id);
  const stale = repo.byId(row.id);
  repo.recordSuccess(row.id, { synced: true });
  items = [{ id: 'b', title: 'B' }, ...items];
  srv.routes.set('/rss', (req, res) => {
    repo.delete(GUILD, row.id);
    res.writeHead(200).end(RSS(items));
  });
  assert.equal(await svc.poll(stale), 'skipped');
  assert.equal(w.sent.length, 0);

  // Salon supprimé : erreur comptée, articles NON marqués (publiés une fois réparé).
  srv.routes.set('/rss', (req, res) => res.writeHead(200).end(RSS(items)));
  const again = (await svc.add({ guild: w.guild, channelId: CHAN, input: `${srv.url('/rss')}?v=2` })).row;
  items = [{ id: 'c', title: 'C' }, ...items];
  w.guild.channels.cache.delete(CHAN);
  assert.equal(await svc.poll(repo.byId(again.id)), 'error');
  assert.match(repo.byId(again.id).last_error, /salon inutilisable/);
  assert.ok(!repo.isSeen(again.id, 'c'));
  w.guild.channels.cache.set(CHAN, w.channel);
  assert.equal(await svc.poll(repo.byId(again.id)), 'posted');
  assert.equal(w.sent.length, 1);
});

test('FeedService.processDue : 5 flux par serveur et par passage, arrêt respecté ; réseau coupé', async (t) => {
  const srv = await localServer(t);
  const w = fakeWorld();
  const { db } = memoryDb();
  const { svc, repo } = feedService(w, db);
  srv.routes.set('/rss', (req, res) => res.writeHead(200).end(RSS([{ id: 'x', title: 'X' }])));
  for (let i = 0; i < 7; i += 1) repo.create({ guildId: GUILD, channelId: CHAN, url: `${srv.url('/rss')}?n=${i}`, synced: true, lastCheckedAt: i });
  assert.equal(await svc.processDue(), 5);
  assert.equal(srv.hits.length, 5);
  assert.equal(await svc.processDue(), 2, 'les 2 restants au passage suivant');
  assert.equal(await svc.processDue(), 0, 'tous lus il y a moins de 10 min');
  // Arrêt demandé : aucune lecture lancée.
  for (const r of repo.list(GUILD)) db.prepare('UPDATE feeds SET last_checked_at = 0 WHERE id = ?').run(r.id);
  assert.equal(await svc.processDue({ isStopping: () => true }), 0);
  // Réseau coupé (FEEDS_NETWORK=off) : aucune requête, ajout refusé proprement.
  const off = new FeedService({ client: w.client, feeds: repo, networkEnabled: false });
  assert.equal(await off.processDue(), 0);
  await assert.rejects(off.add({ guild: w.guild, channelId: CHAN, input: 'https://blog.exemple.fr/rss' }), /désactivée/);
  // Arrêt du service : lectures interrompues.
  srv.routes.set('/lent', () => {});
  const slow = repo.create({ guildId: GUILD, channelId: CHAN, url: srv.url('/lent'), synced: true });
  const pending = svc.poll(slow);
  await sleep(30);
  const stopping = svc.stop();
  assert.equal(await pending, 'stopped');
  await stopping;
  await assert.rejects(svc.fetchFeed(srv.url('/rss')), /s'arrête/);
});

test('itemPayload : lien http(s) seulement, bouton, extrait, YouTube', () => {
  const p = itemPayload({ id: '1', title: 'Titre', link: 'javascript:alert(1)', summary: 'Résumé', image: 'data:image/png;base64,xx', date: null }, { feedTitle: 'Flux' });
  assert.equal(p.embeds[0].url, undefined);
  assert.equal(p.embeds[0].image, undefined);
  assert.deepEqual(p.components, []);
  assert.deepEqual(p.allowedMentions, { parse: [] });
  const masked = itemPayload({ id: '3', title: '[Gagnez](https://arnaque.exemple)', summary: '- [ici](https://arnaque.exemple) **gras**', date: null }, { feedTitle: 'Flux' });
  assert.equal(masked.embeds[0].title, '\\[Gagnez](https://arnaque.exemple)', 'lien masqué neutralisé');
  assert.equal(masked.embeds[0].description, '\\- \\[ici](https://arnaque.exemple) \\*\\*gras\\*\\*');
  const yt = itemPayload({ id: '2', title: 'Vidéo', link: 'https://www.youtube.com/watch?v=x', summary: '', image: 'https://i.ytimg.com/vi/x/hq.jpg', date: 0 }, { feedTitle: 'Chaîne', youtube: true, roleId: ROLE });
  assert.match(yt.embeds[0].author.name, /▶️/);
  assert.equal(yt.embeds[0].footer.text.includes('YouTube'), true);
  assert.equal(yt.content, `<@&${ROLE}>`);
  assert.equal(flux.parseFilter('  été   2025 '), 'été 2025');
  assert.equal(flux.parseFilter('   '), null);
  assert.throws(() => flux.parseFilter('x'.repeat(51)), /50 caractères/);
});

// ---------------------------------------------------------------- automatisations : fonctions pures

test('boostChange : début, fin, partiel ignoré (source unique du log et du remerciement)', () => {
  const at = new Date();
  assert.equal(A.boostChange({ premiumSince: null }, { premiumSince: at }), 'start');
  assert.equal(A.boostChange({ premiumSince: at }, { premiumSince: null }), 'end');
  assert.equal(A.boostChange({ premiumSince: at }, { premiumSince: at }), null);
  assert.equal(A.boostChange({ partial: true, premiumSince: null }, { premiumSince: at }), null);
  assert.equal(A.boostChange(null, { premiumSince: at }), null);
});

test('renderThreadName, hasMediaOrLink, unknownVariables', () => {
  assert.equal(A.renderThreadName('Discussion de {pseudo} #{N}', { pseudo: 'Alice', n: 7 }), 'Discussion de Alice #7');
  assert.equal(A.renderThreadName(null, { pseudo: 'Bob', n: 1 }), 'Discussion de Bob');
  assert.equal(A.renderThreadName('{pseudo}\n\tx', { pseudo: '  ', n: 3 }), 'x');
  assert.equal(A.renderThreadName('   ', { pseudo: '', n: 3 }).startsWith('Discussion'), true);
  assert.equal(A.renderThreadName('x'.repeat(300), { n: 1 }).length, 100);
  assert.ok(A.hasMediaOrLink({ content: 'voir https://exemple.fr', attachments: new Collection() }));
  assert.ok(A.hasMediaOrLink({ content: '', attachments: new Collection([['1', { name: 'chat.PNG', contentType: null }]]) }));
  assert.ok(A.hasMediaOrLink({ content: '', attachments: new Collection([['1', { name: 'clip', contentType: 'video/mp4' }]]) }));
  assert.ok(!A.hasMediaOrLink({ content: 'bonjour', attachments: new Collection([['1', { name: 'doc.pdf', contentType: 'application/pdf' }]]) }));
  assert.ok(A.hasMediaOrLink({ content: '', attachments: new Collection(), embeds: [{ image: { url: 'https://x' } }] }));
  assert.deepEqual(A.unknownVariables('{pseudo} {n} {membre} {Pseudo}', ['pseudo', 'n']), ['membre']);
});

test('rôles vocaux : rôles gérés, rôles voulus selon le salon', () => {
  const cfg = { enabled: true, roleId: 'G', channels: [{ channelId: 'V1', roleId: 'R1' }, { channelId: 'V2', roleId: 'R2' }] };
  assert.deepEqual(A.managedVoiceRoles(cfg), ['G', 'R1', 'R2']);
  assert.deepEqual(A.desiredVoiceRoles(cfg, 'V1'), ['G', 'R1']);
  assert.deepEqual(A.desiredVoiceRoles(cfg, 'V9'), ['G']);
  assert.deepEqual(A.desiredVoiceRoles(cfg, null), []);
  assert.deepEqual(A.desiredVoiceRoles({ ...cfg, enabled: false }, 'V1'), []);
  assert.deepEqual(A.managedVoiceRoles({}), []);
});

test('renderBoostMessage : variables, @everyone neutralisé ; boostPayload : seul le membre est notifié', () => {
  const text = A.renderBoostMessage('Merci {membre} ! {serveur} a {boosts} boosts @everyone', { id: '42', server: 'Le *serveur*', boosts: 7 });
  assert.match(text, /^Merci <@42> ! Le \\\*serveur\\\* a 7 boosts @​everyone$/);
  assert.match(A.renderBoostMessage(null, { id: '1', server: 'S', boosts: 2 }), /Merci <@1>/);
  const p = A.boostPayload('x', { userId: '42' });
  assert.deepEqual(p.allowedMentions, { parse: [], users: ['42'] });
  assert.equal(p.content, '<@42>');
});

test('assignableRoleIssue : @everyone, intégration, rôle sensible, hiérarchie du bot et de l\'auteur', () => {
  const perms = (...p) => new PermissionsBitField(p);
  const me = { permissions: perms('ManageRoles'), roles: { highest: { position: 10 } } };
  const guild = { id: 'G', ownerId: 'OWNER', members: { me } };
  const role = (extra) => ({ id: 'R', name: 'Rôle', position: 5, managed: false, permissions: perms(), ...extra });
  assert.match(A.assignableRoleIssue(guild, null), /n'existe plus/);
  assert.match(A.assignableRoleIssue(guild, role({ id: 'G' })), /@everyone/);
  assert.match(A.assignableRoleIssue(guild, role({ managed: true })), /intégration/);
  assert.match(A.assignableRoleIssue(guild, role({ permissions: perms('BanMembers') })), /modération/);
  assert.match(A.assignableRoleIssue(guild, role({ permissions: perms('Administrator') })), /modération/);
  assert.match(A.assignableRoleIssue(guild, role({ position: 10 })), /mon rôle le plus haut/);
  const actor = { id: 'MOD', roles: { highest: { position: 5 } } };
  assert.match(A.assignableRoleIssue(guild, role(), actor), /votre rôle le plus haut/);
  assert.equal(A.assignableRoleIssue(guild, role(), { id: 'OWNER', roles: { highest: { position: 0 } } }), null, 'propriétaire : pas de hiérarchie');
  assert.equal(A.assignableRoleIssue(guild, role({ position: 2 }), actor), null);
  const noPerm = { ...guild, members: { me: { ...me, permissions: perms() } } };
  assert.match(A.assignableRoleIssue(noPerm, role()), /Gérer les rôles/);
});

// ---------------------------------------------------------------- publication automatique (file d'attente)

test('publication automatique : limite par salon respectée, file d\'attente puis publication, log', async () => {
  const { db } = memoryDb();
  const crossposted = [];
  const logs = [];
  const config = { get: () => ({ automations: { crosspost: { enabled: true, channels: [CHAN] } } }) };
  const client = { user: { id: 'BOT' }, services: { logging: { send: async (...a) => logs.push(a) } } };
  const svc = new A.AutomationService({ client, config, counters: new AutoThreadCounterRepository(db), delayMs: 5 });
  svc.crosspostLimit = 2;
  svc.crosspostWindowMs = 120;
  const guild = { id: GUILD, members: { me: null } };
  const channel = { id: CHAN, type: ChannelType.GuildAnnouncement };
  const message = (id, extra = {}) => ({
    id,
    guild,
    guildId: GUILD,
    channel,
    channelId: CHAN,
    type: 0,
    system: false,
    author: { id: 'U', bot: false },
    flags: { has: () => false },
    crosspost: async () => crossposted.push({ id, at: Date.now() }),
    ...extra,
  });
  for (const id of ['1', '2', '3', '4']) assert.ok(svc.handleMessage(message(id)));
  assert.ok(!svc.handleMessage(message('5', { type: 20 })), 'réponse de commande : jamais publiée');
  assert.ok(!svc.handleMessage(message('6', { channel: { id: CHAN, type: ChannelType.GuildText } })), 'salon non annonce');
  await sleep(40);
  assert.deepEqual(crossposted.map((c) => c.id), ['1', '2'], 'limite de 2 par fenêtre');
  assert.equal(svc.queueSize(CHAN), 2);
  assert.equal(logs.length, 1, 'dépassement journalisé');
  assert.match(logs[0][2].data.title, /en attente/);
  await sleep(200);
  assert.deepEqual(crossposted.map((c) => c.id), ['1', '2', '3', '4']);
  assert.ok(crossposted[2].at - crossposted[0].at >= 100, 'publiés après la fenêtre');
  assert.equal(svc.queueSize(CHAN), 0);
  // Message supprimé (AutoMod) entre-temps : jamais publié.
  client.services.autoResponses = { wasDeleted: (id) => id === '9' };
  svc.handleMessage(message('9'));
  await sleep(250);
  assert.ok(!crossposted.some((c) => c.id === '9'));
  await svc.stop();
  assert.ok(!svc.handleMessage(message('10')), 'arrêté : plus rien');
});

// ---------------------------------------------------------------- présence

test('présence : statuts tournants (env), types, variables, intervalle ≥ 1 min, un seul minuteur', () => {
  const { statuses, invalid } = P.parseStatuses('regarde:/help • {serveurs} serveurs | joue:/projet | écoute:{membres} membres | Sans type | | x:'.concat(' | ', 'y'.repeat(200)));
  assert.deepEqual(statuses.map((s) => s.type), [ActivityType.Watching, ActivityType.Playing, ActivityType.Listening, ActivityType.Watching, ActivityType.Watching]);
  assert.equal(statuses[3].text, 'Sans type');
  assert.equal(statuses[4].text, 'x:', 'préfixe inconnu : texte conservé');
  assert.equal(invalid.length, 1);
  assert.deepEqual(P.renderStatus(statuses[0], { servers: 3, members: 120 }), { name: '/help • 3 serveurs', type: ActivityType.Watching });
  const defaults = P.presenceSettings({});
  assert.equal(defaults.source, 'default');
  assert.equal(defaults.statuses.length, P.DEFAULT_STATUSES.length);
  assert.equal(defaults.intervalMs, 60_000);
  assert.equal(P.presenceSettings({ presenceIntervalMinutes: 0.2 }).intervalMs, 60_000, 'minimum 1 min');
  assert.equal(P.presenceSettings({ presenceIntervalMinutes: 5, presenceStatuses: 'joue:test' }).intervalMs, 300_000);
  assert.equal(P.parseStatuses(Array.from({ length: 12 }, (_, i) => `joue:${i}`).join('|')).statuses.length, P.MAX_STATUSES);

  const calls = [];
  const client = { user: { setPresence: (p) => calls.push(p) }, guilds: { cache: new Collection([['1', { memberCount: 10 }], ['2', { memberCount: 5 }]]) } };
  const settings = P.presenceSettings({ presenceStatuses: 'regarde:{serveurs} serveurs | écoute:{membres} membres' });
  P.startPresenceRotation(client, settings);
  const first = client.presenceTimer;
  P.startPresenceRotation(client, settings);
  assert.notEqual(client.presenceTimer, first, 'minuteur remplacé, pas dupliqué');
  clearInterval(client.presenceTimer);
  assert.deepEqual(calls[0], { activities: [{ name: '2 serveurs', type: ActivityType.Watching }], status: 'online' });
});
