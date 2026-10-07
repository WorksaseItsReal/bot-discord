'use strict';

const { canonical, leet, variants } = require('./normalize');

/**
 * Mots interdits résistants aux contournements.
 * - « mot »  : mot entier ; lettres répétées tolérées (« cooon ») ;
 *              une ponctuation entre les lettres aussi (« c.o.n », « c*n » non).
 * - « mot* » : préfixe (« arnaque* » attrape « arnaqueur »).
 * Le texte est testé sous plusieurs formes (accents, homoglyphes, leet, lettres espacées).
 */

const cache = new WeakMap();

function escape(c) {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Motif d'un mot : chaque lettre peut se répéter et être suivie d'une ponctuation isolée. */
function wordPattern(word) {
  const prefix = word.endsWith('*');
  const clean = leet(canonical(prefix ? word.slice(0, -1) : word)).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const chars = [...clean];
  const body = chars
    .map((c, i) => {
      if (c === ' ') return '\\s+';
      const sep = i < chars.length - 1 && chars[i + 1] !== ' ' ? '[.\\-_~]?' : '';
      return `${escape(c)}+${sep}`;
    })
    .join('');
  return prefix ? `${body}[\\p{L}\\p{N}]*` : body;
}

/**
 * RegExp compilée pour une liste de mots (mise en cache par référence de tableau :
 * la configuration est elle-même mise en cache, donc compilée une seule fois).
 * @param {string[]} words
 * @returns {RegExp|null}
 */
function compileWords(words) {
  if (!Array.isArray(words)) return null;
  if (cache.has(words)) return cache.get(words);
  const parts = [...new Set(words.map((w) => String(w ?? '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(wordPattern)
    .filter(Boolean);
  const re = parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  cache.set(words, re);
  return re;
}

/**
 * @returns {string|null} le passage interdit trouvé, ou null
 */
function findBadWord(text, words) {
  const re = compileWords(words);
  if (!re || !text) return null;
  for (const v of variants(text)) {
    const m = v.match(re);
    if (m) return m[0];
  }
  return null;
}

module.exports = { compileWords, findBadWord, wordPattern };
