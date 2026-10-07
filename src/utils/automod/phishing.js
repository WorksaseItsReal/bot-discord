'use strict';

const { extractLinks } = require('./links');
const { canonical, leet } = require('./normalize');

/**
 * Détection d'arnaques (faux Nitro, faux Steam, liens piégés de comptes piratés).
 * Score heuristique : chaque indice ajoute des points ; ≥ 3 = arnaque probable.
 */

/** Domaines officiels : jamais signalés. */
const OFFICIAL = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discord.gift',
  'discordstatus.com', 'dis.gd', 'discord.co', 'discord.dev', 'discordmerch.com',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamgames.com', 's.team',
  'twitch.tv', 'youtube.com', 'youtu.be', 'epicgames.com', 'roblox.com', 'github.com',
];

/** Marques usurpées : un domaine qui y ressemble sans être officiel est suspect. */
const BRANDS = ['discord', 'discordapp', 'steamcommunity', 'steampowered', 'steam', 'nitro', 'roblox', 'epicgames', 'twitch'];

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'cutt.ly', 'is.gd', 'rb.gy', 'shorturl.at', 't.ly', 'goo.su', 'clck.ru', 'v.gd', 'tiny.cc', 'ow.ly', 'grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'blasze.com', 'yip.su'];

const BAIT = /\b(?:free\s*nitro|nitro\s*(?:free|gratuit|gift|for\s*free)|gratuit|free|gift|cadeau|giveaway|airdrop|claim|r[ée]clame[rz]?|gagn[ée]|won|steam\s*gift|50\s*\$|\d+\s*(?:usd|\$|€)|crypto|nft|robux)\b/i;
const URGENCY = /\b(?:first|premiers?|limited|limit[ée]e?|hurry|vite|only\s*today|aujourd'?hui\s*seulement|expire|before\s*it'?s\s*gone)\b/i;

function isOfficial(host) {
  return OFFICIAL.some((d) => host === d || host.endsWith(`.${d}`));
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

/** Domaine qui imite une marque (« dlscord-gift.com », « steamcornmunity.ru », « discord-nitro.xyz »). */
function imitatesBrand(host) {
  if (isOfficial(host)) return null;
  const labels = host.split('.');
  const name = leet(canonical(labels.slice(0, -1).join('.'))).replace(/rn/g, 'm');
  const tokens = name.split(/[.-]/).filter(Boolean);
  for (const brand of BRANDS) {
    if (name.replace(/[.-]/g, '').includes(brand)) return brand;
    for (const t of tokens) {
      if (t.length >= 5 && t !== brand && distance(t, brand, 2) <= (brand.length >= 8 ? 2 : 1)) return brand;
    }
  }
  return null;
}

/**
 * @param {string} text
 * @param {{ mentionsEveryone?: boolean }} [ctx]
 * @returns {{ score: number, reasons: string[], links: object[] }}
 */
function phishingScore(text, ctx = {}) {
  const links = extractLinks(text);
  const reasons = [];
  let score = 0;
  if (!links.length) return { score, reasons, links };

  for (const l of links) {
    const brand = imitatesBrand(l.host);
    if (brand) {
      score += 3;
      reasons.push(`domaine imitant « ${brand} » (${l.host})`);
    }
    if (l.host.split('.').some((p) => p.startsWith('xn--'))) {
      score += 2;
      reasons.push(`domaine déguisé (punycode : ${l.host})`);
    }
    if (SHORTENERS.some((s) => l.host === s || l.host.endsWith(`.${s}`))) {
      score += 1;
      reasons.push(`lien raccourci ou traceur (${l.host})`);
    }
  }
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
  return { score, reasons: [...new Set(reasons)], links };
}

module.exports = { phishingScore, imitatesBrand, isOfficial, distance, OFFICIAL, SHORTENERS };
