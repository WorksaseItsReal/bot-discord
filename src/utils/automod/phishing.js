'use strict';

const { extractLinks } = require('./links');
const { canonical, leet } = require('./normalize');

/**
 * Détection d'arnaques (faux Nitro, faux Steam, liens piégés de comptes piratés).
 * Score heuristique : chaque indice ajoute des points ; ≥ 3 = arnaque probable.
 */

/** Domaines officiels ou légitimes très connus : jamais signalés. */
const OFFICIAL = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discord.gift',
  'discordstatus.com', 'dis.gd', 'discord.co', 'discord.dev', 'discordmerch.com',
  'discord.js.org', 'discordjs.guide', 'discordjs.dev', 'discord.py', 'discordpy.readthedocs.io', 'discordbotlist.com',
  'discords.com', 'disboard.org', 'top.gg', 'dyno.gg', 'mee6.xyz',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamgames.com', 's.team', 'steamdb.info',
  'steamcharts.com', 'steamladder.com', 'steamdeck.com', 'steamserver.net',
  'twitch.tv', 'twitchtracker.com', 'youtube.com', 'youtu.be', 'epicgames.com', 'roblox.com', 'robloxdev.com', 'github.com',
];

/** Sites légitimes contenant une marque et un mot d'appât (« steamgifts ») : jamais signalés. */
const KNOWN_LEGIT = ['steamgifts.com', 'steamtrades.com', 'steamrep.com', 'steamid.io', 'steamid.uk', 'discordextremelist.xyz',
  'discordservers.com', 'discordapp.io', 'discord.bots.gg', 'twitchapps.com', 'twitchemotes.com', 'twitchmetrics.net',
  'streamelements.com', 'streamlabs.com', 'epicgames.dev', 'unrealengine.com', 'rbxcdn.com', 'robloxlabs.com'];

/** Marques usurpées. */
const BRANDS = ['discord', 'discordapp', 'steamcommunity', 'steampowered', 'steam', 'nitro', 'roblox', 'epicgames', 'twitch'];

/** Mots d'appât typiques dans les faux domaines (« discord-gift », « steam-trade-offer »…). */
const LURES = ['gift', 'gifts', 'nitro', 'free', 'claim', 'login', 'signin', 'verify', 'verification', 'airdrop', 'promo',
  'giveaway', 'drop', 'trade', 'offer', 'offers', 'account', 'security', 'auth', 'oauth', 'support', 'reward', 'rewards',
  'bonus', 'event', 'skin', 'skins', 'case', 'cases', 'gen', 'generator', 'app', 'apps', 'help', 'payment', 'wallet'];

/** TLD très utilisés par les arnaques (gratuits ou peu contrôlés). */
const SUSPICIOUS_TLDS = new Set(['xyz', 'ru', 'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'click', 'link', 'gift', 'site', 'online',
  'store', 'shop', 'live', 'icu', 'buzz', 'fun', 'pw', 'su', 'ws', 'monster', 'rest', 'cam', 'sbs', 'cfd', 'cyou', 'win', 'promo', 'claim', 'free']);

/** Vrais mots proches d'une marque (« stream », « switch »…) : jamais pris pour une imitation. */
const DICTIONARY = new Set(['stream', 'streams', 'steak', 'steal', 'steady', 'steamy', 'stamp', 'scream', 'switch', 'witch',
  'twitchy', 'discard', 'discards', 'disco', 'record', 'accord', 'nitric', 'nitrous', 'robin', 'robot', 'epic', 'steamed',
  'steamer', 'steams', 'nitrogen', 'nitrate', 'stream', 'dream', 'cream', 'team', 'teams', 'steel', 'steep', 'stead',
  'steady', 'stewm', 'epicgamer', 'epicgamers', 'robots', 'roblex', 'discos', 'discover', 'discovery', 'disord', 'twitter']);

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'cutt.ly', 'is.gd', 'rb.gy', 'shorturl.at', 't.ly', 'goo.su', 'clck.ru', 'v.gd', 'tiny.cc', 'ow.ly', 'grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'blasze.com', 'yip.su'];

const BAIT = /\b(?:free\s*nitro|nitro\s*(?:free|gratuit|gift|for\s*free)|gratuit|free|gift|cadeau|giveaway|airdrop|claim|r[ée]clame[rz]?|gagn[ée]|won|steam\s*gift|crypto|nft|robux)\b|\d+\s*(?:usd|\$|€)(?!\w)/i;
const URGENCY = /\b(?:first\s+\d+|premiers?\s+\d+|limited|limit[ée]e?|hurry|d[ée]p[êe]che[sz]?-?(?:toi|vous)|only\s*today|aujourd'?hui\s*seulement|expire[sd]?|before\s*it'?s\s*gone)\b/i;

function isOfficial(host, extraAllowed = []) {
  return [...OFFICIAL, ...KNOWN_LEGIT, ...extraAllowed].some((d) => host === d || host.endsWith(`.${d}`));
}

/** Ramène une partie de domaine à sa forme « lue » : homoglyphes, leet, rn→m, cl→d, vv→w. */
const readAs = (label) => leet(canonical(label)).replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w');

/** Noms des domaines officiels imitables (« discord », « steamcommunity »…). */
const OFFICIAL_NAMES = new Set(BRANDS.filter((b) => b.length >= 6));

/** Distance de Damerau-Levenshtein bornée (une inversion « dicsord » compte pour 1). */
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Domaine qui imite une marque. Renvoie { brand, kind } ou null.
 *  - typosquat : « dlscord.com », « steamcornmunity.ru » (faute volontaire, hors vrais mots) ;
 *  - appât : « discord-gift.com », « discordnitro.xyz », « steam-trade.ru » (marque + appât ou TLD suspect).
 * Une simple mention de la marque (« discord.js.org », « steamdb.info ») ne suffit pas.
 */
function imitatesBrand(host, extraAllowed = []) {
  if (isOfficial(host, extraAllowed)) return null;
  const labels = host.split('.');
  const tld = labels.at(-1);
  const rawTokens = labels.slice(0, -1).join('.').split(/[.-]/).filter(Boolean);
  const tokens = rawTokens.map(readAs);
  const flat = tokens.join('');
  const hyphenLure = tokens.some((t) => LURES.includes(t));
  const glued = LURES.some((l) => l.length >= 4 && flat.includes(l) && BRANDS.some((b) => flat.includes(b) && !b.includes(l)));
  // Nom du domaine sans tirets (« steam-community » → « steamcommunity ») : même nom
  // qu'un domaine officiel, mais autre extension (« steamcommunity.co », « discordapp.co »).
  const sld = readAs(labels.at(-2) ?? '').replace(/-/g, '');
  if (OFFICIAL_NAMES.has(sld)) return { brand: sld, kind: 'typosquat' };
  for (const brand of BRANDS) {
    for (const [i, t] of tokens.entries()) {
      // Homoglyphe ou « rn » pour « m » : se LIT comme la marque sans l'être (« dіscord », « stearn »).
      if (t === brand) {
        if (rawTokens[i] !== brand && brand.length >= 5) return { brand, kind: 'typosquat' };
        continue;
      }
      // Typosquat : même première lettre, distance 1 (2 pour les noms longs), pas un vrai mot.
      if (t.length < 5 || DICTIONARY.has(t) || t[0] !== brand[0]) continue;
      if (distance(t, brand, 2) <= (brand.length >= 8 ? 2 : 1)) return { brand, kind: 'typosquat' };
    }
    if (flat.includes(brand) && (hyphenLure || glued || SUSPICIOUS_TLDS.has(tld))) {
      // Marque collée à un appât sans tiret ni extension douteuse (« steamtrades.com ») :
      // indice plus faible, il faut un autre signal pour atteindre le seuil.
      return { brand, kind: 'lure', weak: !hyphenLure && !SUSPICIOUS_TLDS.has(tld) };
    }
  }
  return null;
}

/** Lien Markdown « [texte](url) » (avec ou sans chevrons autour de l'URL). */
const MASKED_RE = /\[([^\[\]\n]{1,200})\]\(\s*<?(https?:\/\/[^\s<>()]+)>?(?:\s+"[^"]*")?\s*\)/gi;

/** Même site (égal ou sous-domaine l'un de l'autre). */
const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * Liens masqués trompeurs : le texte affiché ressemble à un domaine (« discord.com/gift »)
 * différent de la vraie cible (« https://evil.ru »). « [clique ici](…) » n'est pas concerné,
 * ni un texte qui désigne le même site, ni une cible officielle ou autorisée. Pur.
 * @returns {Array<{ shown: string, host: string }>}
 */
function maskedLinks(text, allowedDomains = []) {
  const out = [];
  for (const m of String(text ?? '').matchAll(MASKED_RE)) {
    const target = extractLinks(m[2])[0];
    if (!target || isOfficial(target.host, allowedDomains)) continue;
    // Le texte doit lui-même désigner un site, et aucun ne doit correspondre à la cible.
    const shown = extractLinks(m[1]);
    if (!shown.length || shown.some((l) => sameSite(l.host, target.host))) continue;
    out.push({ shown: shown[0].host, host: target.host });
  }
  return out;
}

/**
 * @param {string} text
 * @param {{ mentionsEveryone?: boolean, allowedDomains?: string[] }} [ctx]
 * @returns {{ score: number, reasons: string[], links: object[] }}
 */
function phishingScore(text, ctx = {}) {
  const links = extractLinks(text);
  const reasons = [];
  let score = 0;
  if (!links.length) return { score, reasons, links };

  const allowed = ctx.allowedDomains ?? [];
  let linkScore = 0;
  for (const l of links) {
    if (isOfficial(l.host, allowed)) continue;
    const imitation = imitatesBrand(l.host, allowed);
    if (imitation) {
      linkScore += imitation.weak ? 2 : 3;
      reasons.push(`domaine imitant « ${imitation.brand} » (${l.host})`);
    }
    if (l.disguised) {
      // « https://discord.com@evil.ru » : se fait passer pour un autre site → arnaque à lui seul.
      linkScore += l.disguised === 'domain' ? 3 : 2;
      reasons.push(`lien déguisé (« …@ » devant le vrai site ${l.host})`);
    }
    if (l.host.split('.').some((p) => p.startsWith('xn--'))) {
      linkScore += 2;
      reasons.push(`domaine déguisé (punycode : ${l.host})`);
    }
    if (SHORTENERS.some((s) => l.host === s || l.host.endsWith(`.${s}`))) {
      linkScore += 1;
      reasons.push(`lien raccourci ou traceur (${l.host})`);
    }
  }
  // « [discord.com/gift](https://evil.ru) » : le texte affiché ment sur la destination.
  for (const m of maskedLinks(text, allowed)) {
    linkScore += 3;
    reasons.push(`lien masqué (affiche « ${m.shown} » mais mène à ${m.host})`);
  }
  score += linkScore;
  // Les indices de texte ne comptent que si un lien est déjà suspect : un lien officiel
  // accompagné de « gratuit » ou « vite » n'est pas une arnaque.
  if (linkScore > 0) {
    const plain = canonical(text);
    if (BAIT.test(plain)) {
      score += 1;
      reasons.push('appât (gratuit, cadeau, Nitro…)');
    }
    if (URGENCY.test(plain)) {
      score += 1;
      reasons.push('urgence artificielle');
    }
    if (ctx.mentionsEveryone || /@(?:everyone|here)/i.test(text)) {
      score += 1;
      reasons.push('mention de tout le serveur');
    }
  }
  return { score, reasons: [...new Set(reasons)], links };
}

module.exports = { phishingScore, maskedLinks, imitatesBrand, isOfficial, distance, OFFICIAL, KNOWN_LEGIT, SHORTENERS };
