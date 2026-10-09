'use strict';

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
 * @returns {Array<{ url: string, host: string, tld: string, hasProtocol: boolean, disguised: 'domain'|'user'|null }>}
 */
function extractLinks(text) {
  const out = [];
  // « https://discord.com@evil.ru » ouvre evil.ru : la partie « utilisateur@ » est retirée
  // (sinon le vrai domaine est ignoré) et signalée, c'est une ruse typique d'arnaque.
  const disguised = new Map(); // hôte réel → 'domain' (« discord.com@ ») ou 'user' (« user:pass@ »)
  const src = String(text ?? '')
    .replace(/<(https?:\/\/[^>\s]+)>/gi, '$1') // <lien> sans aperçu
    .replace(/(https?:\/\/)([^\s/@<>]+)@(?=[^\s/@<>])/gi, (m, protocol, userinfo, offset, all) => {
      const host = /^[^\s/:?#<>]+/.exec(all.slice(offset + m.length))?.[0];
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

/**
 * @returns {string[]} codes d'invitation trouvés (minuscules)
 */
function extractInvites(text) {
  // Normalisé d'abord (invisibles, homoglyphes, pleine chasse…).
  const plain = canonical(text);
  const direct = [...plain.matchAll(INVITE_RE)].map((m) => m[1].toLowerCase());
  // Puis version recollée (« discord . gg / abc »). Pour limiter les faux positifs
  // (« discord. Gg/wp à tous »), un code ainsi reconstitué doit faire au moins 3 caractères.
  const compact = plain.replace(/\s*([./])\s*/g, '$1').replace(/\(dot\)|\[dot\]/gi, '.');
  const rebuilt = [...compact.matchAll(INVITE_RE)].map((m) => m[1].toLowerCase()).filter((c) => c.length >= 3);
  return [...new Set([...direct, ...rebuilt])];
}

module.exports = { extractLinks, extractInvites, hostMatches, TLDS };
