'use strict';

/**
 * Normalisation anti-contournement pour l'AutoMod.
 * Neutralise : accents, caractères invisibles, homoglyphes (cyrillique/grec),
 * leetspeak (c0n, @ss), lettres espacées (« c o n », « c.o.n »).
 * Tout est pur et testé (tests/automod.engine.test.js).
 */

/** Caractères invisibles utilisés pour casser les mots (zero-width, soft hyphen…). */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ﻿ﾠ]/g;

/** Homoglyphes courants → lettre latine (après passage en minuscules). */
const HOMOGLYPHS = {
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', ё: 'e', һ: 'h', н: 'h', і: 'i', ї: 'i', ј: 'j', к: 'k', ӏ: 'l', м: 'm',
  п: 'n', о: 'o', р: 'p', ԛ: 'q', г: 'r', ѕ: 's', т: 't', у: 'y', х: 'x', ү: 'y', ԝ: 'w', ɡ: 'g', ɩ: 'i',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  ℓ: 'l', '∂': 'd', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', ı: 'i',
};

/** Leetspeak → lettre. */
const LEET = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e', '£': 'l', '+': 't' };

/**
 * Forme canonique : minuscules, sans invisibles, sans accents, homoglyphes ramenés au latin.
 * Les chiffres sont conservés (voir `leet()`).
 */
function canonical(text) {
  return String(text ?? '')
    .replace(INVISIBLE, '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, (c) => HOMOGLYPHS[c] ?? c);
}

/** Remplace le leetspeak par des lettres (« c0n » → « con »). */
function leet(text) {
  return text.replace(/[0-9@$!|€£+]/g, (c) => LEET[c] ?? c);
}

/**
 * Recolle les lettres isolées séparées par des espaces ou de la ponctuation :
 * « c o n », « c.o.n », « c-o-n » → « con ». Ne touche pas aux mots normaux.
 */
function joinSpaced(text) {
  return text.replace(/(?<![\p{L}\p{N}])\p{L}(?:[\s.\-_*~,'`]{1,3}\p{L}(?![\p{L}\p{N}])){2,}/gu, (m) => m.replace(/[^\p{L}]/gu, ''));
}

/**
 * Variantes à tester pour les mots interdits.
 * @returns {string[]} variantes uniques (canonique, leet, lettres recollées)
 */
function variants(text) {
  const base = canonical(text);
  const leeted = leet(base);
  return [...new Set([base, leeted, joinSpaced(leeted)])];
}

/** Clé de comparaison de messages (doublons, spam inter-salons). */
function fingerprint(text) {
  // Pas de leetspeak ici : « !!! » doit disparaître comme ponctuation, pas devenir « iii ».
  return canonical(text).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/(.)\1{2,}/gu, '$1$1').trim();
}

module.exports = { canonical, leet, joinSpaced, variants, fingerprint, INVISIBLE };
