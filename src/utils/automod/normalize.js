'use strict';

/**
 * Normalisation anti-contournement pour l'AutoMod.
 * Neutralise : accents, caractères invisibles, homoglyphes (cyrillique/grec, majuscules
 * comprises), petites capitales, lettres encadrées (🅲, 🄲, 🇨), leetspeak (c0n, @ss)
 * et lettres espacées (« c o n », « c.o.n », « c/o/n », « c😀o😀n »).
 * Tout est pur et testé (tests/automod.engine.test.js).
 */

/** Caractères invisibles utilisés pour casser les mots (zero-width, tags, Braille vide…). */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯⠀ㅤ﻿ﾠ\u{E0000}-\u{E007F}]/gu;

/** Homoglyphes MAJUSCULES (à traiter avant la mise en minuscules : Ν grec → N, pas v). */
const UPPER = {
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J',
};

/** Homoglyphes minuscules et petites capitales → lettre latine. */
const LOWER = {
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', ё: 'e', һ: 'h', н: 'h', і: 'i', ї: 'i', ј: 'j', к: 'k', ӏ: 'l', м: 'm',
  п: 'n', о: 'o', р: 'p', ԛ: 'q', г: 'r', ѕ: 's', т: 't', у: 'y', х: 'x', ү: 'y', ԝ: 'w', ɡ: 'g', ɩ: 'i',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  ℓ: 'l', '∂': 'd', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', ı: 'i',
  ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o',
  ᴘ: 'p', ǫ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
};

/** Lettres encadrées non décomposées par NFKD : 🄰-🅉, 🅐-🅩, 🅰-🆉, 🇦-🇿. */
const ENCLOSED = [
  [0x1f130, 0x1f149],
  [0x1f150, 0x1f169],
  [0x1f170, 0x1f189],
  [0x1f1e6, 0x1f1ff],
];
function enclosedToLatin(text) {
  // Deux indicateurs régionaux collés forment un drapeau (🇫🇷) : c'est un emoji, pas « fr ».
  return text.replace(/[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F130}-\u{1F189}\u{1F1E6}-\u{1F1FF}]/gu, (c) => {
    if ([...c].length === 2) return '🏳';
    const cp = c.codePointAt(0);
    const range = ENCLOSED.find(([a, b]) => cp >= a && cp <= b);
    return range ? String.fromCharCode(97 + cp - range[0]) : c;
  });
}

/** Leetspeak → lettre. Les symboles « ! | + » ne comptent qu'entre deux lettres. */
const LEET = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '€': 'e', '£': 'l', '!': 'i', '|': 'i', '+': 't' };
const INFIX_ONLY = new Set(['!', '|', '+']);

/**
 * Forme canonique : sans invisibles, homoglyphes ramenés au latin, sans accents,
 * minuscules. Les chiffres sont conservés (voir `leet()`).
 */
function canonical(text) {
  return enclosedToLatin(String(text ?? '').replace(INVISIBLE, ''))
    .replace(/[^\u0000-\u007f]/g, (c) => UPPER[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, (c) => LOWER[c] ?? c);
}

const isLetter = (c) => Boolean(c) && /\p{L}/u.test(c);

/**
 * Leetspeak → lettres, seulement à l'intérieur des mots : « c0n » → « con »,
 * mais « 79 ans », « 455 € » ou « code 8173 » restent intacts.
 */
function leet(text) {
  return text.replace(/[\p{L}\p{N}@$€£!|+]+/gu, (token) => {
    if (!/\p{L}/u.test(token)) return token; // jeton sans lettre (nombre) : inchangé
    const chars = [...token];
    return chars
      .map((c, i) => {
        const sub = LEET[c];
        if (!sub) return c;
        const prev = chars[i - 1];
        const next = chars[i + 1];
        if (INFIX_ONLY.has(c)) return isLetter(prev) && isLetter(next) ? sub : c;
        return isLetter(prev) || isLetter(next) || LEET[prev] || LEET[next] ? sub : c;
      })
      .join('');
  });
}

/**
 * Séparateurs tolérés entre lettres isolées : espaces, ponctuation et symboles (« · • — : = | »),
 * emojis (avec teinte de peau, variantes, ZWJ). Les symboles de leetspeak ($ € £ @) restent des lettres.
 */
const SEP = "(?:(?![@$€£])[\\s\\p{P}\\p{S}]|\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}]|\\uFE0F|\\u200D){1,6}";
/** Unité isolée : une lettre, ou un caractère de leetspeak (« c.0.n »). */
const UNIT = '[\\p{L}\\d@$€£]';
const SPACED_RE = new RegExp(`(?<![\\p{L}\\p{N}])${UNIT}(?:${SEP}${UNIT}(?![\\p{L}\\p{N}])){2,}`, 'gu');

/**
 * Recolle les lettres isolées séparées par des espaces, de la ponctuation ou des
 * emojis : « c o n », « c.o.n », « c/o/n », « c😀o😀n » → « con ». Les mots normaux ne bougent pas.
 */
function joinSpaced(text) {
  return text.replace(SPACED_RE, (m) => (/\p{L}/u.test(m) ? m.replace(/[^\p{L}\d@$€£]/gu, '') : m));
}

/**
 * Variantes à tester pour les mots interdits.
 * @returns {string[]} variantes uniques (canonique, leet, lettres recollées)
 */
function variants(text) {
  const base = canonical(text);
  const leeted = leet(base);
  // Recoller AVANT le leetspeak : « c.0.n » → « c0n » → « con » (un nombre « 1 2 3 » reste un nombre).
  return [...new Set([base, leeted, leet(joinSpaced(base)), joinSpaced(leeted)])];
}

/** Clé de comparaison de messages (doublons, spam inter-salons). */
function fingerprint(text) {
  // Pas de leetspeak ici : « !!! » doit disparaître comme ponctuation, pas devenir « iii ».
  return canonical(text).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/(.)\1{2,}/gu, '$1$1').trim();
}

module.exports = { canonical, leet, joinSpaced, variants, fingerprint, INVISIBLE };
