'use strict';

/**
 * Alertes de mots-clés (/alertes) : briques pures (normalisation, index, recherche).
 * Aucun accès Discord ni base ici.
 *
 * Correspondance « mot entier », insensible à la casse et aux accents : le texte est
 * découpé en jetons (suites de lettres et de chiffres) ; un mot-clé de plusieurs mots
 * (« inspecteur gadget ») correspond à des jetons consécutifs. Aucune expression
 * régulière n'est construite à partir d'une saisie.
 *
 * Index par serveur : jeton(s) → membres. La recherche ne parcourt que les jetons du
 * message (consultation de Map), indépendamment du nombre de mots-clés enregistrés.
 */

const MIN_KEYWORD = 3;
const MAX_KEYWORD = 40;
const MAX_KEYWORDS = 10;

/** Balises Discord jamais comptées comme des mots : emojis personnalisés, mentions, salons, horodatages, commandes. */
const MARKUP = /<a?:\w{2,32}:\d{17,20}>|<(?:@[!&]?|#)\d{17,20}>|<t:-?\d{1,13}(?::[tTdDfFR])?>|<\/[^<>:]{1,100}:\d{17,20}>/g;
const TOKEN = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/** Jetons normalisés d'un texte (minuscules, sans accents). Pur. */
function tokenize(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  return raw.replace(MARKUP, ' ').normalize('NFD').replace(MARKS, '').toLowerCase().match(TOKEN) ?? [];
}

/** Clé de comparaison d'un mot-clé : jetons séparés par une espace (« Éte-ïa » → « ete ia »). Pur. */
function keywordKey(text) {
  return tokenize(text).join(' ');
}

/**
 * Index d'un serveur, reconstruit à chaque modification. Les membres en pause (ou sans
 * mot-clé utilisable) n'y figurent pas.
 * @param {Array<{ userId: string, words: string[], blockedChannels?: string[], blockedUsers?: string[], paused?: number }>} entries
 * @returns {{
 *   words: Map<string, Set<string>>, prefixes: Set<string>,
 *   members: Map<string, { words: Map<string, string>, blockedChannels: Set<string>, blockedUsers: Set<string> }>
 * }}
 */
function buildIndex(entries = []) {
  const words = new Map();
  const prefixes = new Set();
  const members = new Map();
  for (const entry of entries) {
    if (!entry || entry.paused || !entry.words?.length) continue;
    const keys = new Map();
    for (const word of entry.words) {
      const key = keywordKey(word);
      if (key.length >= MIN_KEYWORD && !keys.has(key)) keys.set(key, word);
    }
    if (!keys.size) continue;
    members.set(entry.userId, {
      words: keys,
      blockedChannels: new Set(entry.blockedChannels ?? []),
      blockedUsers: new Set(entry.blockedUsers ?? []),
    });
    for (const key of keys.keys()) {
      let users = words.get(key);
      if (!users) words.set(key, (users = new Set()));
      users.add(entry.userId);
      // Préfixes des mots-clés de plusieurs mots : la recherche ne prolonge une suite de jetons que s'ils existent.
      let space = key.indexOf(' ');
      while (space !== -1) {
        prefixes.add(key.slice(0, space));
        space = key.indexOf(' ', space + 1);
      }
    }
  }
  return { words, prefixes, members };
}

/**
 * Membres dont un mot-clé apparaît dans le texte. Pur.
 * @returns {Map<string, Set<string>>} membre → clés trouvées
 */
function findMatches(index, text) {
  const hits = new Map();
  if (!index?.words?.size || !text) return hits;
  const tokens = tokenize(text);
  // Clés trouvées d'abord (un mot-clé répété 500 fois ne compte qu'une fois)…
  const found = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    let key = tokens[i];
    let j = i;
    for (;;) {
      if (index.words.has(key)) found.add(key);
      j += 1;
      if (j >= tokens.length || !index.prefixes.has(key)) break;
      key = `${key} ${tokens[j]}`;
    }
  }
  // … puis leurs abonnés, développés UNE seule fois par clé : coût en jetons + abonnés, jamais
  // en occurrences × abonnés.
  for (const key of found) {
    for (const userId of index.words.get(key)) {
      let keys = hits.get(userId);
      if (!keys) hits.set(userId, (keys = new Set()));
      keys.add(key);
    }
  }
  return hits;
}

/** Extrait cité d'un message (« > » devant chaque ligne), borné en lignes et en caractères. Pur. */
function quoteExcerpt(text, { maxChars = 700, maxLines = 8 } = {}) {
  const clean = String(text ?? '').replace(/```/g, 'ˋˋˋ').trim();
  if (!clean) return '';
  const lines = clean.split('\n');
  let out = lines.slice(0, maxLines).map((l) => `> ${l}`).join('\n');
  const cut = lines.length > maxLines || out.length > maxChars;
  if (out.length > maxChars) out = out.slice(0, maxChars - 1);
  return cut ? `${out}…` : out;
}

module.exports = { tokenize, keywordKey, buildIndex, findMatches, quoteExcerpt, MIN_KEYWORD, MAX_KEYWORD, MAX_KEYWORDS };
