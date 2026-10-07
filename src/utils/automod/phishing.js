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
  'steamer', 'steams', 'nitrogen', 'nitrate', 'stream', 'dream', 'cream', 'team', 'teams', 'steel', 'steep']);

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'cutt.ly', 'is.gd', 'rb.gy', 'shorturl.at', 't.ly', 'goo.su', 'clck.ru', 'v.gd', 'tiny.cc', 'ow.ly', 'grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'blasze.com', 'yip.su'];

const BAIT = /\b(?:free\s*nitro|nitro\s*(?:free|gratuit|gift|for\s*free)|gratuit|free|gift|cadeau|giveaway|airdrop|claim|r[ée]clame[rz]?|gagn[ée]|won|steam\s*gift|crypto|nft|robux)\b|\d+\s*(?:usd|\$|€)(?!\w)/i;
const URGENCY = /\b(?:first\s+\d+|premiers?\s+\d+|limited|limit[ée]e?|hurry|d[ée]p[êe]che[sz]?-?(?:toi|vous)|only\s*today|aujourd'?hui\s*seulement|expire[sd]?|before\s*it'?s\s*gone)\b/i;

function isOfficial(host, extraAllowed = []) {
  return [...OFFICIAL, ...extraAllowed].some((d) => host === d || host.endsWith(`.${d}`));
}

/** Distance de Levenshtein bornée (rapide pour de courtes chaînes). */
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
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
  const name = leet(canonical(labels.slice(0, -1).join('.'))).replace(/rn/g, 'm');
  const tokens = name.split(/[.-]/).filter(Boolean);
  const flat = tokens.join('');
  const hasLure = tokens.some((t) => LURES.includes(t)) || LURES.some((l) => l.length >= 4 && flat.includes(l) && BRANDS.some((b) => flat.includes(b) && !b.includes(l)));
  for (const brand of BRANDS) {
    // Typosquat : même première lettre, distance 1 (2 pour les noms longs), pas un vrai mot.
    for (const t of tokens) {
      if (t === brand || t.length < 5 || DICTIONARY.has(t) || t[0] !== brand[0]) continue;
      if (distance(t, brand, 2) <= (brand.length >= 8 ? 2 : 1)) return { brand, kind: 'typosquat' };
    }
    if (flat.includes(brand) && (hasLure || SUSPICIOUS_TLDS.has(tld))) return { brand, kind: 'lure' };
  }
  return null;
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
      linkScore += 3;
      reasons.push(`domaine imitant « ${imitation.brand} » (${l.host})`);
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

module.exports = { phishingScore, imitatesBrand, isOfficial, distance, OFFICIAL, SHORTENERS };
