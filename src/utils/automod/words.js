'use strict';

const { canonical, leet, variants } = require('./normalize');

/**
 * Mots interdits résistants aux contournements.
 * - « mot »  : mot entier ; lettres répétées tolérées (« cooon ») ; une ponctuation
 *              isolée entre les lettres aussi (« c.o.n »), sans couper un sigle (« P.D.G. »).
 * - « mot* » : préfixe (« arnaque* » attrape « arnaqueur »).
 * Le texte est testé sous plusieurs formes (accents, homoglyphes, leet, lettres espacées).
 *
 * Performances : deux éléments voisins d'un motif ne lisent jamais le même caractère (voir
 * wordPattern), ce qui exclut tout retour arrière catastrophique, même sur un message piégé
 * de 4000 caractères (tests/review6-automod.test.js) ; les grandes listes sont découpées en
 * blocs de taille raisonnable (le moteur RegExp natif reste rapide).
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

const isAlnum = (c) => /[\p{L}\p{N}]/u.test(c);
/** Forme comparée sans casse (« σ » et « ς » se confondent avec le drapeau i). */
const fold = (c) => c.toUpperCase().toLowerCase();

/**
 * Classe `cls` privée des symboles voisins de l'entrée (« ~ », « ! »…), suivie de `q` :
 * un séparateur ne peut pas lire le symbole qui le précède ou le suit dans le motif.
 */
function except(cls, items, q) {
  const re = new RegExp(cls, 'iu');
  const chars = [...new Set(items.filter((it) => it && !it.space && !it.alnum && re.test(it.char)).map((it) => it.char))];
  if (!chars.length) return `${cls}${q}`;
  return `(?:(?![${chars.map((c) => c.replace(/[\]\\^-]/g, '\\$&')).join('')}])${cls})${q}`;
}

/**
 * Motif d'un mot : chaque lettre peut se répéter et être suivie d'une ponctuation isolée.
 * Deux éléments voisins du motif ne lisent jamais le même caractère : sinon le moteur essaie
 * tous les découpages possibles (« k+[\s\p{P}]*k+[\s\p{P}]*k+ » gelait le bot plusieurs
 * secondes sur « kkkk…b »). Les textes reconnus restent les mêmes :
 *  - un même caractère répété d'un mot à l'autre (« k k k ») forme une seule suite
 *    « k+(?:[\s\p{P}]+k+|k){2} » : chaque groupe suivant commence soit par un séparateur,
 *    soit par exactement UNE lettre collée, les lettres en trop allant au groupe précédent ;
 *  - un séparateur voisin d'un symbole de l'entrée (« ~ », « ! ») ne lit pas ce symbole.
 */
function wordPattern(word) {
  const prefix = word.endsWith('*');
  // Les mots composés tolèrent n'importe quel séparateur, ou aucun : « fils de pute »
  // attrape aussi « fils-de-pute » et « filsdepute ».
  const clean = leet(canonical(prefix ? word.slice(0, -1) : word)).replace(/[\s\-_.']+/g, ' ').trim();
  // Une entrée sans lettre ni chiffre (« ... », « ! ») bloquerait presque tous les messages.
  if (!/[\p{L}\p{N}]/u.test(clean)) return null;
  // Fusionne les caractères identiques consécutifs (« loool » → l, o, l), puis un même
  // caractère répété d'un mot à l'autre (« k k k ») en une seule suite de 3.
  const items = [];
  for (const c of clean) {
    const last = items.at(-1);
    if (c === ' ') {
      items.push({ space: true });
      continue;
    }
    if (last && !last.space && fold(last.char) === fold(c)) continue;
    const before = items.at(-2);
    if (last?.space && before && !before.space && fold(before.char) === fold(c)) {
      items.pop();
      before.count += 1;
      continue;
    }
    items.push({ char: c, alnum: isAlnum(c), count: 1 });
  }
  const body = items
    .map((it, i) => {
      const prev = items[i - 1];
      const next = items[i + 1];
      if (it.space) return except('[\\s\\p{P}]', [prev, next], '*');
      const c = escape(it.char);
      const end = i === items.length - 1;
      // « mot* » finissant par une lettre : ses répétitions sont lues par [\p{L}\p{N}]*.
      const open = prefix && end && it.alnum;
      // Symbole en tête (« #nsfw ») : le motif est essayé à chaque position d'une suite « #### »
      // (rien ne l'en empêche, contrairement à une lettre) ; sans répétition, chaque essai est bref.
      const first = i === 0 && !it.alnum ? c : `${c}+`;
      let out;
      if (it.count > 1) {
        out = `${first}(?:${except('[\\s\\p{P}]', [it], '+')}${c}+|${c}){${it.count - 1}}`;
        // « k k* » : la suite va jusqu'à la dernière lettre (sinon [\p{L}\p{N}]* la relirait).
        if (open) out += `(?!${c})`;
      } else {
        out = open ? c : first;
      }
      return next && !next.space ? `${out}${except(SEP, [it, next], '?')}` : out;
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
 * Formes du texte à tester. Une suite de plus de 64 caractères identiques (« kkkk… ») est
 * raccourcie à 64 : une entrée (60 caractères au plus) n'en exige jamais autant, le verdict
 * est donc le même, mais l'analyse d'un message piégé reste bornée.
 */
function forms(text) {
  return [...new Set(variants(text).map((v) => v.replace(/(.)\1{64,}/gsu, (m, c) => c.repeat(64))))];
}

/**
 * @returns {string|null} le passage interdit trouvé, ou null
 */
function findBadWord(text, words) {
  const regexes = compileWords(words);
  if (!regexes.length || !text) return null;
  for (const v of forms(text)) {
    for (const re of regexes) {
      const m = v.match(re);
      if (m) return m[0];
    }
  }
  return null;
}

/**
 * Entrées de la liste qui bloquent ce texte (pour retirer un mot après un faux positif).
 * Une RegExp par entrée : réservé aux actions ponctuelles, pas à l'analyse des messages.
 * @returns {string[]} au plus `max` entrées, dans l'ordre de la liste
 */
function matchingWords(text, words, max = 5) {
  if (!text || !Array.isArray(words)) return [];
  const texts = forms(text);
  const out = [];
  for (const w of new Set(words.map((x) => String(x ?? '').trim()).filter(Boolean))) {
    const pattern = wordPattern(w);
    if (!pattern) continue;
    const re = new RegExp(`${START}(?:${pattern})${END}`, 'iu');
    if (texts.some((v) => re.test(v))) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** Une entrée de liste est-elle utilisable (au moins une lettre ou un chiffre) ? */
const isValidWord = (word) => wordPattern(String(word ?? '')) !== null;

module.exports = { compileWords, findBadWord, matchingWords, wordPattern, isValidWord };
