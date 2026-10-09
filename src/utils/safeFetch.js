'use strict';

const dns = require('node:dns');
const net = require('node:net');

/**
 * Requête HTTP sortante « sûre » (flux RSS) : `fetch` natif, http(s) uniquement, délai
 * total de 10 s, corps limité à 1 Mo, hôtes privés refusés — y compris après résolution
 * DNS (toutes les adresses), IPv6 locales et IPv4 mappées comprises —, redirections
 * suivies À LA MAIN (3 sauts au plus), chaque saut revalidé.
 *
 * Limite connue : `fetch` refait sa propre résolution DNS ; un domaine qui change de
 * réponse entre les deux (DNS rebinding) n'est pas totalement exclu. Les noms à une seule
 * étiquette, `localhost`, `.local`, `.internal`… sont refusés avant toute résolution.
 */

const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

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

/** Résout le nom et refuse si UNE des adresses est privée. */
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
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!list.length) throw new FetchError(`nom de domaine introuvable (${host})`);
  if (list.some((a) => isBlockedAddress(a, { allowLoopback }))) throw new FetchError('ce domaine pointe vers une adresse privée ou locale : refusé', { blocked: true });
}

/** Lit un corps de réponse en s'arrêtant au-delà de `max` octets. */
async function readLimited(body, max) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new FetchError(`document trop volumineux (plus de ${Math.round(max / 1024)} Ko)`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/**
 * GET sûr.
 * @param {string|URL} rawUrl
 * @param {{
 *   headers?: Record<string, string>, maxBytes?: number, timeoutMs?: number, maxRedirects?: number,
 *   allowLoopback?: boolean, signal?: AbortSignal,
 *   fetchImpl?: typeof fetch, lookup?: (host: string, opts: object) => Promise<Array<{ address: string }>>,
 * }} [opts] `allowLoopback`, `fetchImpl` et `lookup` : injection pour les tests uniquement
 * @returns {Promise<{ status: number, ok: boolean, headers: Headers, url: string, body: Buffer, redirects: number }>}
 */
async function safeFetch(rawUrl, opts = {}) {
  const {
    headers = {},
    maxBytes = MAX_BYTES,
    timeoutMs = TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    allowLoopback = false,
    signal: outer,
    fetchImpl = globalThis.fetch,
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
  try {
    let url = parseHttpUrl(rawUrl);
    for (let hop = 0; ; hop += 1) {
      await assertPublicHost(url, { lookup, allowLoopback, signal });
      let res;
      try {
        res = await fetchImpl(url.toString(), { method: 'GET', headers, redirect: 'manual', signal });
      } catch (err) {
        if (signal.aborted) throw new FetchError(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`);
        throw new FetchError(`connexion impossible (${err?.cause?.code ?? err?.code ?? err?.message ?? 'erreur réseau'})`);
      }
      if (REDIRECT_CODES.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) throw new FetchError(`redirection HTTP ${res.status} sans destination`);
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
      const length = Number(res.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new FetchError(`document trop volumineux (plus de ${Math.round(maxBytes / 1024)} Ko)`);
      }
      let body;
      try {
        body = res.status === 304 ? Buffer.alloc(0) : await readLimited(res.body, maxBytes);
      } catch (err) {
        if (err instanceof FetchError) throw err;
        if (signal.aborted) throw new FetchError(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`);
        throw new FetchError(`lecture interrompue (${err?.message ?? 'erreur réseau'})`);
      }
      return { status: res.status, ok: res.ok, headers: res.headers, url: url.toString(), body, redirects: hop };
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener?.('abort', relay);
  }
}

module.exports = {
  safeFetch,
  FetchError,
  isBlockedAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv6,
  checkHostname,
  parseHttpUrl,
  MAX_BYTES,
  TIMEOUT_MS,
  MAX_REDIRECTS,
};
