'use strict';

/**
 * Détecteurs de forme (pas de contenu) : majuscules, emojis, zalgo, pavés.
 */

/** Pourcentage de majuscules parmi les lettres (toutes langues). */
function capsRatio(text) {
  const letters = String(text ?? '').replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '');
  const upper = (letters.match(/\p{Lu}/gu) || []).length;
  const lower = (letters.match(/\p{Ll}/gu) || []).length;
  const total = upper + lower;
  return { ratio: total ? upper / total : 0, letters: total };
}

function isExcessiveCaps(text, { percent = 70, minLength = 10 } = {}) {
  const { ratio, letters } = capsRatio(text);
  return letters >= minLength && ratio * 100 >= percent;
}

/** Emojis : personnalisés + unicode (une séquence ZWJ compte pour un). */
function countEmojis(text) {
  const str = String(text ?? '');
  const custom = (str.match(/<a?:\w+:\d+>/g) || []).length;
  const unicode = (str.replace(/<a?:\w+:\d+>/g, '').match(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu) || []).length;
  return custom + unicode;
}

/**
 * Zalgo : diacritiques EMPILÉS (au moins 3 sur une même lettre). L'hindi, l'arabe
 * vocalisé ou le vietnamien (1 à 2 signes par lettre) ne sont pas concernés.
 */
function isZalgo(text, { minMarks = 10 } = {}) {
  const runs = String(text ?? '').normalize('NFD').match(/\p{M}{3,}/gu) || [];
  return runs.reduce((n, r) => n + r.length, 0) >= minMarks;
}

/** Pavé : trop de lignes ou trop de caractères. */
function isWall(text, { maxLines = 15, maxLength = 1500 } = {}) {
  const str = String(text ?? '');
  return str.split('\n').length > maxLines || str.length > maxLength;
}

/**
 * Mentions d'un message Discord (utilise les données résolues quand elles existent).
 * @param {import('discord.js').Message | null} message
 * @param {string} text
 */
function countMentions(message, text = '') {
  if (message?.mentions) {
    const m = message.mentions;
    return (m.users?.size ?? 0) + (m.roles?.size ?? 0) + (m.everyone ? 1 : 0);
  }
  return (String(text).match(/<@!?\d+>|<@&\d+>|@(?:everyone|here)\b/g) || []).length;
}

module.exports = { capsRatio, isExcessiveCaps, countEmojis, isZalgo, isWall, countMentions };
