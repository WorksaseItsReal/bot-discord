'use strict';

/**
 * Téléchargement sûr depuis le CDN de Discord (utils/discordCdn.js) et option `allowedHosts` /
 * `httpsOnly` de safeFetch (revalidée à chaque redirection, protections générales inchangées).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const S = require('../src/utils/safeFetch');
const C = require('../src/utils/discordCdn');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(32, 4)]);
const CDN_URL = 'https://cdn.discordapp.com/attachments/1/2/avatar.png?ex=1&is=2&hm=3';

/** Transport simulé : enregistre les appels, renvoie la réponse demandée. */
function fakeHttp(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (typeof response === 'function') return response(url, opts);
    return { status: 200, ok: true, url, redirects: 0, ...response, headers: new Headers(response.headers ?? {}) };
  };
  fn.calls = calls;
  return fn;
}

/** Serveur HTTP local (127.0.0.1) piloté par une table de routes. */
async function localServer(t) {
  const routes = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    const route = routes.get(req.url.split('?')[0]);
    if (!route) return res.writeHead(404).end('introuvable');
    if (typeof route === 'function') return route(req, res);
    const { status = 200, headers = {}, body = '' } = route;
    res.writeHead(status, { 'content-type': 'image/png', ...headers });
    return res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { routes, hits, base, port: server.address().port, url: (path) => `${base}${path}` };
}

test('sniffImage : PNG, JPEG, GIF, WebP reconnus ; texte et fichier trop court refusés', () => {
  assert.equal(C.sniffImage(PNG), 'png');
  assert.equal(C.sniffImage(JPEG), 'jpeg');
  assert.equal(C.sniffImage(GIF), 'gif');
  assert.equal(C.sniffImage(WEBP), 'webp');
  assert.equal(C.sniffImage(Buffer.from('<html><body>coucou</body></html>')), null);
  assert.equal(C.sniffImage(Buffer.from([0x89, 0x50])), null);
  assert.equal(C.sniffImage('PNG'), null);
});

test('assertDiscordCdnUrl : https, hôtes du CDN de Discord, port par défaut, sans identifiants', () => {
  assert.equal(C.assertDiscordCdnUrl(CDN_URL).hostname, 'cdn.discordapp.com');
  assert.equal(C.assertDiscordCdnUrl('https://media.discordapp.net/attachments/1/2/a.webp').hostname, 'media.discordapp.net');
  for (const bad of [
    'https://evil.example/avatar.png',
    'https://cdn.discordapp.com.evil.example/a.png',
    'http://cdn.discordapp.com/attachments/1/2/a.png',
    'https://cdn.discordapp.com:8443/a.png',
    'https://user:pass@cdn.discordapp.com/a.png',
    'file:///etc/passwd',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    '',
  ]) {
    assert.throws(() => C.assertDiscordCdnUrl(bad), (err) => err.name === 'FetchError' && err.isUserError, bad);
  }
});

test('fetchDiscordImage : options passées à safeFetch (hôtes Discord, https, 8 Mo, 10 s) et Buffer renvoyé', async () => {
  const transport = fakeHttp({ headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) }, body: PNG });
  const buffer = await C.fetchDiscordImage(CDN_URL, { http: transport, networkEnabled: true });
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual(buffer, PNG);
  const [{ url, opts }] = transport.calls;
  assert.equal(url, CDN_URL);
  assert.deepEqual(opts.allowedHosts, ['cdn.discordapp.com', 'media.discordapp.net']);
  assert.equal(opts.httpsOnly, true);
  assert.equal(opts.maxBytes, 8 * 1024 * 1024);
  assert.equal(opts.timeoutMs, 10_000);
  assert.ok(opts.maxRedirects <= 3);
  for (const [body, type] of [[JPEG, 'image/jpeg'], [JPEG, 'image/jpg'], [GIF, 'image/gif'], [WEBP, 'image/webp']]) {
    assert.deepEqual(await C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': type }, body }), networkEnabled: true }), body);
  }
});

test('fetchDiscordImage : hôte non Discord, http, CDN_NETWORK=off → refus SANS requête', async () => {
  const transport = fakeHttp({ headers: { 'content-type': 'image/png' }, body: PNG });
  await assert.rejects(C.fetchDiscordImage('https://evil.example/a.png', { http: transport, networkEnabled: true }), /hébergés par Discord/);
  await assert.rejects(C.fetchDiscordImage('http://cdn.discordapp.com/a.png', { http: transport, networkEnabled: true }), /https/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: transport, networkEnabled: false }), /désactivé sur cette instance/);
  assert.equal(transport.calls.length, 0);
  // Interrupteur lu dans la configuration (CDN_NETWORK) à chaque appel.
  const { config } = require('../src/config');
  const before = config.cdnNetwork;
  try {
    config.cdnNetwork = false;
    await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: transport }), /téléchargement d'images désactivé sur cette instance/);
    config.cdnNetwork = true;
    assert.deepEqual(await C.fetchDiscordImage(CDN_URL, { http: transport }), PNG);
  } finally {
    config.cdnNetwork = before;
  }
});

test('fetchDiscordImage : taille (en-tête et contenu), type annoncé, signature, statut, URL finale', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) }, body: PNG }), networkEnabled: true }), /trop volumineux/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'image/png' }, body: big }), networkEnabled: true }), /trop volumineux/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'text/html' }, body: PNG }), networkEnabled: true }), /type de fichier refusé/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: {}, body: PNG }), networkEnabled: true }), /type de fichier refusé/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'image/png' }, body: Buffer.from('<?php system($_GET[0]); ?> pas une image') }), networkEnabled: true }), /pas une image/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'image/png' }, body: GIF }), networkEnabled: true }), /ne correspond pas/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ status: 404, ok: false, headers: { 'content-type': 'image/png' }, body: PNG }), networkEnabled: true }), /répondu 404/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ url: 'https://evil.example/x.png', headers: { 'content-type': 'image/png' }, body: PNG }), networkEnabled: true }), /hébergés par Discord/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'image/png' }, body: Buffer.alloc(0) }), networkEnabled: true }), /vide/);
  // Délai : l'erreur de safeFetch remonte telle quelle (message affichable).
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: async () => { throw new S.FetchError('délai de 10 s dépassé'); }, networkEnabled: true }), /délai/);
  // Fichier quelconque (/embed texte) : plafond choisi par l'appelant, jamais au-delà de 25 Mo.
  const file = await C.fetchDiscordFile(CDN_URL, { http: fakeHttp({ headers: { 'content-type': 'text/plain' }, body: Buffer.from('bonjour') }), networkEnabled: true, maxBytes: 100 });
  assert.equal(file.buffer.toString(), 'bonjour');
  assert.equal(file.contentType, 'text/plain');
  await assert.rejects(C.fetchDiscordFile(CDN_URL, { http: fakeHttp({ headers: {}, body: Buffer.alloc(200) }), networkEnabled: true, maxBytes: 100 }), /trop volumineux/);
  const t = fakeHttp({ headers: {}, body: Buffer.from('x') });
  await C.fetchDiscordFile(CDN_URL, { http: t, networkEnabled: true, maxBytes: 10 ** 12 });
  assert.equal(t.calls[0].opts.maxBytes, C.MAX_FILE_BYTES);
  await assert.rejects(C.fetchDiscordFile(CDN_URL, { http: t, networkEnabled: false }), /fichiers désactivé/);
});

test('discordCdn + safeFetch réel : redirection vers un autre hôte, http, taille du flux et délai refusés', async (t) => {
  const srv = await localServer(t);
  srv.routes.set('/avatar.png', { body: PNG });
  srv.routes.set('/vers-autre-hote', { status: 302, headers: { location: `http://autre.exemple:${srv.port}/avatar.png` } });
  srv.routes.set('/gros', (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.write(PNG);
    let n = 0;
    const timer = setInterval(() => {
      res.write(Buffer.alloc(64 * 1024));
      n += 1;
      if (n === 20) {
        clearInterval(timer);
        res.end();
      }
    }, 1);
  });
  srv.routes.set('/lent', () => {});
  // Transport réel (safeFetch) branché sur le serveur local : seules les options de test changent
  // (127.0.0.1 autorisé, http local) ; maxBytes, allowedHosts… viennent de discordCdn.
  const local = (path, extra = {}) => (url, opts) => S.safeFetch(srv.url(path), {
    ...opts,
    allowLoopback: true,
    httpsOnly: false,
    allowedHosts: ['127.0.0.1'],
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    ...extra,
  }).then((res) => ({ ...res, url: url.toString() })); // le serveur local tient lieu du CDN
  assert.deepEqual(await C.fetchDiscordImage(CDN_URL, { http: local('/avatar.png'), networkEnabled: true }), PNG);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: local('/vers-autre-hote'), networkEnabled: true }), /hôte non autorisé \(autre\.exemple\)/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: local('/gros', { maxBytes: 200 * 1024 }), networkEnabled: true }), /trop volumineux/);
  await assert.rejects(C.fetchDiscordImage(CDN_URL, { http: local('/lent', { timeoutMs: 150 }), networkEnabled: true }), /délai/);
  assert.ok(!srv.hits.some((h) => h.headers.host?.startsWith('autre.exemple')), 'requête envoyée à l\'hôte refusé');
});

test('safeFetch allowedHosts / httpsOnly : revalidés à CHAQUE saut, en plus des protections générales', async (t) => {
  const srv = await localServer(t);
  srv.routes.set('/ok', { body: 'bonjour' });
  srv.routes.set('/rebond', { status: 302, headers: { location: `http://autre.exemple:${srv.port}/ok` } });
  srv.routes.set('/rebond-local', { status: 302, headers: { location: '/ok' } });
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const base = { allowLoopback: true, lookup, allowedPorts: [srv.port] };
  // Sans l'option : la redirection vers un autre nom (même adresse) est suivie (comportement inchangé).
  assert.equal((await S.safeFetch(srv.url('/rebond'), base)).body.toString(), 'bonjour');
  // Avec l'option : le second saut est refusé AVANT toute résolution ni connexion.
  const before = srv.hits.length;
  await assert.rejects(S.safeFetch(srv.url('/rebond'), { ...base, allowedHosts: ['127.0.0.1'] }), (err) => err.blocked && /hôte non autorisé \(autre\.exemple\)/.test(err.message));
  assert.equal(srv.hits.length, before + 1, 'seul le premier saut a été envoyé');
  // Redirection relative (même hôte) : acceptée.
  assert.equal((await S.safeFetch(srv.url('/rebond-local'), { ...base, allowedHosts: ['127.0.0.1'] })).body.toString(), 'bonjour');
  // Casse et point final normalisés ; liste vide = rien n'est autorisé.
  assert.equal((await S.safeFetch(srv.url('/ok'), { ...base, allowedHosts: ['127.0.0.1.'] })).status, 200);
  await assert.rejects(S.safeFetch(srv.url('/ok'), { ...base, allowedHosts: [] }), /hôte non autorisé/);
  // https exigé : http refusé sans connexion.
  const n = srv.hits.length;
  await assert.rejects(S.safeFetch(srv.url('/ok'), { ...base, httpsOnly: true }), /https/);
  assert.equal(srv.hits.length, n);
  // La liste blanche n'ouvre JAMAIS une adresse privée ni un port refusé.
  await assert.rejects(S.safeFetch('http://10.0.0.1/', { allowedHosts: ['10.0.0.1'] }), /privées ou locales/);
  await assert.rejects(S.safeFetch('https://cdn.discordapp.com/x', { allowedHosts: ['cdn.discordapp.com'], lookup: async () => [{ address: '192.168.1.1', family: 4 }] }), /adresse privée/);
  await assert.rejects(S.safeFetch('https://cdn.discordapp.com:22/x', { allowedHosts: ['cdn.discordapp.com'], lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), /port 22 refusé/);
  // Fonctions pures.
  assert.equal(S.hostAllowList(null), null);
  assert.deepEqual([...S.hostAllowList(['CDN.DiscordApp.com.', ' '])], ['cdn.discordapp.com']);
});
