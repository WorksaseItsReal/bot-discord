'use strict';

const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

/**
 * Requête HTTP sortante « sûre » (flux RSS) : `http(s).request` natif, http(s) uniquement,
 * ports 80 / 443 / 8080 / 8443, délai total de 10 s (corps compris), corps limité à 1 Mo
 * (après décompression gzip / deflate / br), en-têtes limités à 16 Ko, hôtes privés refusés
 * — IPv6 locales et IPv4 mappées comprises —, redirections suivies À LA MAIN (3 sauts au
 * plus), chaque saut revalidé.
 *
 * DNS rebinding : la résolution est validée AU MOMENT DE LA CONNEXION (option `lookup` de
 * net.connect) et le socket utilise exactement les adresses validées ; plus de seconde
 * résolution entre la vérification et la connexion. Le nom d'hôte reste dans l'URL : SNI et
 * vérification du certificat TLS inchangés. Les noms à une seule étiquette, `localhost`,
 * `.local`, `.internal`… sont refusés avant toute résolution.
 */

const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_HEADER_BYTES = 16_384;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
/** Ports autorisés (jamais SSH, SMTP, bases de données… d'un hôte public). */
const ALLOWED_PORTS = Object.freeze([80, 443, 8080, 8443]);

class FetchError extends Error {
  /** @param {string} message phrase en français (affichable) */
  constructor(message, { blocked = false } = {}) {
    super(message);
    this.name = 'FetchError';
    this.isUserError = true;
    /** Adresse refusée par la politique de sécurité (et non panne réseau). */
    this.blocked = blocked;
  }
}

// ---------------------------------------------------------------- adresses IP

/** IPv4 → entier non signé, ou null. */
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n >>> 0;
}

/** Plages IPv4 non publiques : [adresse, longueur du préfixe]. */
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return true;
  return PRIVATE_V4.some(([base, bits]) => (bits === 0 ? true : (n >>> (32 - bits)) === (base >>> (32 - bits))));
}

/** IPv6 → 8 groupes de 16 bits, ou null (zone « %eth0 » refusée). */
function parseIPv6(ip) {
  let s = String(ip).toLowerCase();
  if (s.includes('%')) return null;
  let tail = [];
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    if (v4 == null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    // « ::ffff:1.2.3.4 » → « ::ffff » ; « ::1.2.3.4 » → « :: »
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part ? part.split(':') : []).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const total = head.length + rest.length + tail.length;
  let groups;
  if (halves.length === 2) {
    if (total > 7) return null;
    groups = [...head, ...Array(8 - total).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

const v4From = (hi, lo) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;

function isPrivateIPv6(ip) {
  const g = parseIPv6(ip);
  if (!g) return true;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (adresses uniques locales)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (lien local)
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 (site local, obsolète)
  if ((g[0] & 0xff00) === 0xff00) return true; // multidiffusion
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIPv4(v4From(g[6], g[7])); // ::ffff:a.b.c.d (IPv4 mappée)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(v4From(g[6], g[7])); // ::ffff:0:a.b.c.d (traduite)
  if (zeros(0, 6)) return isPrivateIPv4(v4From(g[6], g[7])); // ::a.b.c.d (compatible, obsolète)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateIPv4(v4From(g[6], g[7])); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // NAT64 local
  if (g[0] === 0x2002) return isPrivateIPv4(v4From(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && zeros(1, 4)) return true; // 100::/64 (rejet)
  return false;
}

/**
 * Adresse IP refusée ? `allowLoopback` (tests uniquement) n'autorise QUE 127.0.0.1.
 * Une valeur qui n'est pas une IP est refusée. Pur.
 */
function isBlockedAddress(ip, { allowLoopback = false } = {}) {
  const family = net.isIP(String(ip));
  if (family === 4) return !(allowLoopback && ip === '127.0.0.1') && isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/** Suffixes de noms internes (jamais résolus vers Internet). */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.localdomain'];

/**
 * Nom d'hôte (déjà normalisé par `URL`) : refus immédiat des IP privées et des noms
 * internes. @returns {{ host: string, literal: boolean }} Pur.
 */
function checkHostname(hostname, opts = {}) {
  let host = String(hostname ?? '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) throw new FetchError('adresse sans nom d\'hôte', { blocked: true });
  if (net.isIP(host)) {
    if (isBlockedAddress(host, opts)) throw new FetchError('les adresses privées ou locales sont refusées', { blocked: true });
    return { host, literal: true };
  }
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw new FetchError('les adresses privées ou locales sont refusées', { blocked: true });
  }
  return { host, literal: false };
}

/** Adresse http(s) analysée, sans identifiants, ou FetchError. */
function parseHttpUrl(raw) {
  let url;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(String(raw));
  } catch {
    throw new FetchError('adresse invalide', { blocked: true });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('seules les adresses http(s) sont acceptées', { blocked: true });
  if (url.username || url.password) throw new FetchError('une adresse avec identifiants n\'est pas acceptée', { blocked: true });
  url.hash = '';
  return url;
}

/** Promesse rejetée quand `signal` est interrompu. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new FetchError('délai dépassé'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new FetchError('délai dépassé'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Adresses d'une réponse de `lookup` (tableau d'objets ou de chaînes, ou objet seul). */
function addressList(addrs) {
  return (Array.isArray(addrs) ? addrs : [addrs])
    .map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a))
    .filter((a) => a && a.address);
}

const PRIVATE_TARGET = 'ce domaine pointe vers une adresse privée ou locale : refusé';

/**
 * Vérification préalable (message lisible avant toute connexion) : résout le nom et refuse
 * si UNE des adresses est privée. La vraie garde est `guardedLookup`, à la connexion.
 */
async function assertPublicHost(url, { lookup, allowLoopback, signal }) {
  const { host, literal } = checkHostname(url.hostname, { allowLoopback });
  if (literal) return;
  let addrs;
  try {
    addrs = await abortable(Promise.resolve(lookup(host, { all: true, verbatim: true })), signal);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(`nom de domaine introuvable (${host})`);
  }
  const list = addressList(addrs);
  if (!list.length) throw new FetchError(`nom de domaine introuvable (${host})`);
  if (list.some((a) => isBlockedAddress(a.address, { allowLoopback }))) throw new FetchError(PRIVATE_TARGET, { blocked: true });
}

/**
 * `lookup` pour net.connect / tls.connect : résout, refuse si UNE adresse est privée, et
 * rend EXACTEMENT les adresses validées (celles que le socket utilisera). Signature de
 * dns.lookup ; `lookup` injecté (tests) : (host, opts) => Promise<adresses>.
 */
function guardedLookup({ lookup, allowLoopback }) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = { all: true, verbatim: true };
    if (options?.family === 4 || options?.family === 6) opts.family = options.family;
    Promise.resolve()
      .then(() => lookup(hostname, opts))
      .then((addrs) => {
        const list = addressList(addrs).map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) }));
        if (!list.length) throw Object.assign(new Error(`nom introuvable (${hostname})`), { code: 'ENOTFOUND' });
        if (list.some((a) => isBlockedAddress(a.address, { allowLoopback }))) throw new FetchError(PRIVATE_TARGET, { blocked: true });
        if (options?.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      })
      .catch((err) => callback(err));
  };
}

/** Port effectif d'une URL http(s). */
const portOf = (url) => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80);

/** Port autorisé ? (`allowLoopback`, tests : tout port de 127.0.0.1) */
function assertPort(url, { allowLoopback, allowedPorts }) {
  if (allowLoopback && url.hostname === '127.0.0.1') return;
  if (!allowedPorts.includes(portOf(url))) throw new FetchError(`port ${portOf(url)} refusé (ports acceptés : ${ALLOWED_PORTS.join(', ')})`, { blocked: true });
}

/** En-têtes Node → `Headers` (valeurs invalides ignorées). */
function toHeaders(rawHeaders) {
  const headers = new Headers();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    try {
      headers.append(rawHeaders[i], rawHeaders[i + 1]);
    } catch {
      /* en-tête invalide : ignoré */
    }
  }
  return headers;
}

/** Décodeur du corps selon Content-Encoding (un seul encodage), ou null (identité). */
function decoderFor(encoding, firstChunk) {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case 'deflate':
      // zlib (RFC 1950) le plus souvent, deflate brut chez certains serveurs.
      return (firstChunk?.[0] & 0x0f) === 0x08
        ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
        : zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case 'br':
      return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    default:
      return null;
  }
}

const tooBig = (max) => new FetchError(`document trop volumineux (plus de ${Math.round(max / 1024)} Ko)`);

/**
 * Lit (et décompresse) le corps en s'arrêtant au-delà de `max` octets — compressés comme
 * décompressés : une « bombe » gzip est coupée à 1 Mo de sortie.
 */
function readBody(res, { max, signal, timeoutMessage }) {
  const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (encoding && encoding !== 'identity' && !['gzip', 'x-gzip', 'deflate', 'br'].includes(encoding)) {
    res.destroy();
    return Promise.reject(new FetchError(`encodage de contenu non pris en charge (${encoding.slice(0, 40)})`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let raw = 0;
    let decoder = null;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        res.destroy();
        decoder?.destroy();
        reject(err);
      } else resolve(value);
    };
    const onAbort = () => finish(new FetchError(timeoutMessage));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const push = (chunk) => {
      total += chunk.length;
      if (total > max) return finish(tooBig(max));
      chunks.push(chunk);
      return undefined;
    };
    const done = () => finish(null, Buffer.concat(chunks, total));
    const fail = (err) => finish(err instanceof FetchError ? err : new FetchError(`lecture interrompue (${err?.code ?? err?.message ?? 'erreur réseau'})`));
    res.on('data', (chunk) => {
      if (settled) return;
      raw += chunk.length;
      if (raw > max) return finish(tooBig(max));
      if (encoding && encoding !== 'identity') {
        if (!decoder) {
          decoder = decoderFor(encoding, chunk);
          decoder.on('data', push);
          decoder.on('end', done);
          decoder.on('error', (err) => fail(new FetchError(`contenu compressé illisible (${err?.code ?? err?.message})`)));
        }
        decoder.write(chunk);
      } else push(chunk);
      return undefined;
    });
    res.on('end', () => {
      if (decoder) decoder.end();
      else done();
    });
    res.on('error', fail);
    res.on('close', () => {
      if (!res.complete) fail(new FetchError('lecture interrompue (connexion fermée)'));
    });
  });
}

/** Un saut : GET, réponse brute (statut, en-têtes Node, flux). */
function requestOnce(url, { headers, signal, lookup, allowLoopback }) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = mod.request(url, {
        method: 'GET',
        headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' },
        lookup: guardedLookup({ lookup, allowLoopback }),
        agent: false, // jamais de socket réutilisé d'une résolution antérieure ; pas de proxy implicite
        signal,
        maxHeaderSize: MAX_HEADER_BYTES,
      }, resolve);
    } catch (err) {
      reject(err);
      return;
    }
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET sûr.
 * @param {string|URL} rawUrl
 * @param {{
 *   headers?: Record<string, string>, maxBytes?: number, timeoutMs?: number, maxRedirects?: number,
 *   allowLoopback?: boolean, allowedPorts?: number[], signal?: AbortSignal,
 *   lookup?: (host: string, opts: object) => Promise<Array<{ address: string, family?: number }>>,
 * }} [opts] `allowLoopback`, `allowedPorts` et `lookup` : injection pour les tests uniquement
 *   (`allowLoopback` n'autorise QUE 127.0.0.1, sur tout port)
 * @returns {Promise<{ status: number, ok: boolean, headers: Headers, url: string, body: Buffer, redirects: number }>}
 */
async function safeFetch(rawUrl, opts = {}) {
  const {
    headers = {},
    maxBytes = MAX_BYTES,
    timeoutMs = TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    allowLoopback = false,
    allowedPorts = ALLOWED_PORTS,
    signal: outer,
    lookup = dns.promises.lookup,
  } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const relay = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', relay, { once: true });
  }
  const { signal } = controller;
  const timeoutMessage = `délai de ${Math.round(timeoutMs / 1000)} s dépassé`;
  try {
    let url = parseHttpUrl(rawUrl);
    for (let hop = 0; ; hop += 1) {
      await assertPublicHost(url, { lookup, allowLoopback, signal });
      assertPort(url, { allowLoopback, allowedPorts });
      let res;
      try {
        res = await requestOnce(url, { headers, signal, lookup, allowLoopback });
      } catch (err) {
        if (err instanceof FetchError) throw err;
        if (signal.aborted) throw new FetchError(timeoutMessage);
        if (err?.code === 'ENOTFOUND') throw new FetchError(`nom de domaine introuvable (${url.hostname})`);
        throw new FetchError(`connexion impossible (${err?.code ?? err?.message ?? 'erreur réseau'})`);
      }
      const status = res.statusCode;
      if (REDIRECT_CODES.has(status)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) throw new FetchError(`redirection HTTP ${status} sans destination`);
        if (hop >= maxRedirects) throw new FetchError(`trop de redirections (${maxRedirects} au plus)`);
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new FetchError('redirection vers une adresse invalide');
        }
        url = parseHttpUrl(next);
        continue;
      }
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) {
        res.destroy();
        throw tooBig(maxBytes);
      }
      let body;
      if (status === 304) {
        res.destroy();
        body = Buffer.alloc(0);
      } else {
        body = await readBody(res, { max: maxBytes, signal, timeoutMessage });
      }
      return { status, ok: status >= 200 && status < 300, headers: toHeaders(res.rawHeaders), url: url.toString(), body, redirects: hop };
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener?.('abort', relay);
  }
}

module.exports = {
  safeFetch,
  FetchError,
  guardedLookup,
  isBlockedAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv6,
  checkHostname,
  parseHttpUrl,
  MAX_BYTES,
  TIMEOUT_MS,
  MAX_REDIRECTS,
  ALLOWED_PORTS,
};
