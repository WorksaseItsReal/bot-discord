'use strict';

const { domainToUnicode } = require('node:url');
const { canonical } = require('./normalize');

/**
 * Extraction de liens et d'invitations, y compris sans « https:// » et masqués.
 */

/**
 * TLD reconnus pour les domaines écrits sans protocole (évite « fichier.txt », « ex.gr »…).
 * Volontairement sans sh, cc, so, pt, pl, am, ml, js… : extensions de fichiers trop courantes
 * (install.sh, main.cc, model.pt…). Avec « https:// », tous les TLD restent détectés.
 */
const TLDS = new Set(
  ('com net org io gg fr be ch ca de uk us me co xyz ru info biz app dev site online store shop link click top live tv gift ' +
    'ly to win club pro space fun icu buzz vip lol one tk ga cf gq pw su ws eu es it nl br in jp cn au nz mx ' +
    'ai fm im is la ma my ph sg tw vn za art blog cloud codes digital email events games host life media news ' +
    'page world zone rest bar wtf gay porn sex xxx cam download stream promo deal sale free money claim')
    .split(/\s+/),
);

/** URL avec protocole, ou domaine nu (www.x.y, x.tld/chemin). */
const URL_RE = /(?<![\p{L}\p{N}@.])(?:(https?):\/\/)?((?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+(xn--[a-z0-9-]{2,59}|[a-z¡-￿]{2,24}))(?::\d{2,5})?(\/[^\s<>()]*)?/giu;

/**
 * Texte lu comme le navigateur (UTS 46) : pleine chasse ramenée à l'ASCII, « ． 。 ｡ » et
 * « %2e » lus comme un point (« evil．ru » ouvre evil.ru).
 */
function browserNormalize(text) {
  return String(text ?? '').normalize('NFKC').replace(/[\u3002\uFF0E\uFF61]|%2e/gi, '.');
}

/** URL à protocole analysée comme le navigateur (WHATWG, comme Chromium/Electron), ou null. */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Liens à protocole tels que Discord les rend cliquables. */
const PROTOCOL_URL_RE = /https?:\/\/[^\s<>]+/gi;
/** Adresse IP telle que le navigateur la normalise (45.13.227.9, ou [2a01:4f8::1]). */
const isIp = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
/** Nom de domaine plausible (« site.com) » ou « x.com, », ponctuation collée, n'en sont pas). */
const DOMAIN_RE = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{2,}$/u;

/**
 * @returns {Array<{ url: string, host: string, tld: string, hasProtocol: boolean, disguised: 'domain'|'user'|null, ip?: true }>}
 */
function extractLinks(text) {
  const out = [];
  // « https://discord.com@evil.ru » ouvre evil.ru : la partie « utilisateur@ » est retirée
  // (sinon le vrai domaine est ignoré) et signalée, c'est une ruse typique d'arnaque.
  // « ? # \ » terminent l'adresse pour le navigateur : « https://evil.ru?@discord.com » ouvre
  // evil.ru, ce n'est pas une partie « utilisateur@ ».
  const disguised = new Map(); // hôte réel → 'domain' (« discord.com@ ») ou 'user' (« user:pass@ »)
  const src = browserNormalize(text)
    .replace(/<(https?:\/\/[^>\s]+)>/gi, '$1') // <lien> sans aperçu
    .replace(/(https?:\/\/)([^\s/?#\\@<>]+)@(?=[^\s/?#\\@<>])/gi, (m, protocol, userinfo, offset, all) => {
      const host = /^[^\s/:?#\\@<>]+/.exec(all.slice(offset + m.length))?.[0];
      if (host) disguised.set(host.toLowerCase().replace(/^www\./, ''), userinfo.includes('.') ? 'domain' : 'user');
      return protocol;
    });
  for (const m of src.matchAll(URL_RE)) {
    const [url, protocol, hostRaw, tldRaw, path] = m;
    const host = hostRaw.toLowerCase();
    const tld = tldRaw.toLowerCase();
    // Sans protocole, on exige un TLD connu (ou punycode) pour éviter les faux positifs.
    if (!protocol && !TLDS.has(tld) && !tld.startsWith('xn--')) continue;
    // « Bonjour.Ca va », « merci.De rien » : espace oublié après un point, pas un domaine.
    if (!protocol && !path && !/^www\./i.test(hostRaw) && /\p{Lu}/u.test(tldRaw)) {
      const label = hostRaw.split('.').at(-2) ?? '';
      if (label !== label.toUpperCase()) continue;
    }
    // Les emojis personnalisés et mentions ne sont pas des domaines.
    if (/^\d+$/.test(host.replace(/\./g, ''))) continue;
    const clean = host.replace(/^www\./, '');
    out.push({ url, host: clean, tld, hasProtocol: Boolean(protocol), disguised: disguised.get(clean) ?? null });
  }
  // Hôte calculé par le navigateur pour chaque lien à protocole : adresses IP (45.13.227.9,
  // 755623689, 0x2d0de309, [::1]) et hôtes encodés (« d%69scord.ru ») que l'expression ne lit pas.
  const seen = new Set(out.map((l) => l.host));
  for (const [url] of src.matchAll(PROTOCOL_URL_RE)) {
    const raw = parseUrl(url)?.hostname;
    if (!raw) continue;
    const ip = isIp(raw);
    const host = ip ? raw : domainToUnicode(raw).replace(/^www\./, '').replace(/\.$/, '');
    if (!host || seen.has(host) || (!ip && !DOMAIN_RE.test(host))) continue;
    seen.add(host);
    out.push({ url, host, tld: ip ? '' : host.split('.').at(-1), hasProtocol: true, disguised: disguised.get(host) ?? null, ...(ip ? { ip: true } : {}) });
  }
  return out;
}

/** Domaine autorisé si égal à une entrée ou sous-domaine de celle-ci. */
function hostMatches(host, domains = []) {
  return domains.some((d) => {
    const clean = String(d).toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
    return clean && (host === clean || host.endsWith(`.${clean}`));
  });
}

/** Invitations Discord, y compris « discord . gg / code » et « discord(app).com/invite/ ». */
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.(?:gg|io|me|li|link)|dsc\.gg|invite\.gg|discord\.gg)\/([a-z0-9-]{2,32})/gi;
/** Même chose en tête de « hôte + chemin » d'une URL analysée. */
const INVITE_URL_RE = new RegExp(`^${INVITE_RE.source}`, 'i');

/**
 * Invitations des liens à protocole, lues comme le navigateur : « ./ » et « ../ » résolus,
 * %xx décodé, « \ » lu comme « / », points idéographiques (« discord.gg/./code »).
 */
function browserInvites(text) {
  const codes = [];
  for (const [url] of browserNormalize(text).matchAll(PROTOCOL_URL_RE)) {
    const parsed = parseUrl(url);
    if (!parsed) continue;
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // chemin mal encodé : lu tel quel
    }
    const m = INVITE_URL_RE.exec(`${parsed.hostname.replace(/^www\./, '')}${path}`);
    if (m) codes.push(m[1].toLowerCase());
  }
  return codes;
}

/**
 * @returns {string[]} codes d'invitation trouvés (minuscules)
 */
function extractInvites(text) {
  // Normalisé d'abord (invisibles, homoglyphes, pleine chasse, points idéographiques…).
  const plain = canonical(text).replace(/[\u3002\uFF0E\uFF61]/g, '.');
  const direct = [...plain.matchAll(INVITE_RE)].map((m) => m[1].toLowerCase());
  // Puis version recollée (« discord . gg / abc »). Pour limiter les faux positifs
  // (« discord. Gg/wp à tous »), un code ainsi reconstitué doit faire au moins 3 caractères.
  const compact = plain.replace(/\s*([./])\s*/g, '$1').replace(/\(dot\)|\[dot\]/gi, '.');
  const rebuilt = [...compact.matchAll(INVITE_RE)].map((m) => m[1].toLowerCase()).filter((c) => c.length >= 3);
  return [...new Set([...direct, ...rebuilt, ...browserInvites(text)])];
}

module.exports = { extractLinks, extractInvites, hostMatches, TLDS };
