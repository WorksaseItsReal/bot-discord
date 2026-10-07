'use strict';

const { canonical, leet, variants } = require('./normalize');

/**
 * Mots interdits résistants aux contournements.
 * - « mot »  : mot entier ; lettres répétées tolérées (« cooon ») ; une ponctuation
 *              isolée entre les lettres aussi (« c.o.n »), sans couper un sigle (« P.D.G. »).
 * - « mot* » : préfixe (« arnaque* » attrape « arnaqueur »).
 * Le texte est testé sous plusieurs formes (accents, homoglyphes, leet, lettres espacées).
 *
 * Performances : les lettres identiques consécutives du mot sont fusionnées (« loool » →
 * « l+o+l+ ») pour éviter tout retour arrière exponentiel, et les grandes listes sont
 * découpées en blocs de taille raisonnable (le moteur RegExp natif reste rapide).
 */

const cache = new WeakMap();
const CHUNK_SIZE = 150;
const SEP = '[.\\-_~]';
/** Frontières : pas de lettre/chiffre collé, ni « ponctuation + lettre » (sigles, snake_case). */
const START = `(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}]${SEP})`;
const END = `(?![\\p{L}\\p{N}])(?!${SEP}[\\p{L}\\p{N}])`;

function escape(c) {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Motif d'un mot : chaque lettre peut se répéter et être suivie d'une ponctuation isolée. */
function wordPattern(word) {
  const prefix = word.endsWith('*');
  const clean = leet(canonical(prefix ? word.slice(0, -1) : word)).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  // Fusionne les lettres identiques consécutives : « loool » → l, o, l.
  const chars = [...clean].filter((c, i, all) => c === ' ' || c !== all[i - 1]);
  const body = chars
    .map((c, i) => {
      if (c === ' ') return '\\s+';
      const sep = i < chars.length - 1 && chars[i + 1] !== ' ' ? `${SEP}?` : '';
      return `${escape(c)}+${sep}`;
    })
    .join('');
  return prefix ? `${body}[\\p{L}\\p{N}]*` : body;
}

/**
 * RegExps compilées pour une liste de mots (mises en cache par référence de tableau :
 * la configuration est elle-même mise en cache, donc compilées une seule fois).
 * @param {string[]} words
 * @returns {RegExp[]}
 */
function compileWords(words) {
  if (!Array.isArray(words)) return [];
  if (cache.has(words)) return cache.get(words);
  const parts = [...new Set(words.map((w) => String(w ?? '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(wordPattern)
    .filter(Boolean);
  const regexes = [];
  for (let i = 0; i < parts.length; i += CHUNK_SIZE) {
    regexes.push(new RegExp(`${START}(?:${parts.slice(i, i + CHUNK_SIZE).join('|')})${END}`, 'iu'));
  }
  cache.set(words, regexes);
  return regexes;
}

/**
 * @returns {string|null} le passage interdit trouvé, ou null
 */
function findBadWord(text, words) {
  const regexes = compileWords(words);
  if (!regexes.length || !text) return null;
  for (const v of variants(text)) {
    for (const re of regexes) {
      const m = v.match(re);
      if (m) return m[0];
    }
  }
  return null;
}

module.exports = { compileWords, findBadWord, wordPattern };
