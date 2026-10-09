'use strict';

/**
 * Détecteurs AutoMod purs (sans état ni dépendance Discord) → faciles à tester.
 * Chaque fonction renvoie true si le contenu VIOLE la règle.
 */

const INVITE_REGEX = /(discord\.(gg|io|me|li)|discordapp\.com\/invite|discord\.com\/invite)\/\S+/i;
const LINK_REGEX = /https?:\/\/\S+/i;

function hasInvite(content) {
  return INVITE_REGEX.test(content || '');
}

function hasLink(content) {
  return LINK_REGEX.test(content || '');
}

/** @returns {boolean} true si le pourcentage de majuscules dépasse le seuil. */
function isExcessiveCaps(content, { percent = 70, minLength = 10 } = {}) {
  const letters = (content || '').replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length < minLength) return false;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
  return (upper / letters.length) * 100 >= percent;
}

/** Mentions de membres, de rôles, et @everyone / @here. */
function countMentions(content) {
  return (content.match(/<@!?\d+>|<@&\d+>|@(?:everyone|here)\b/g) || []).length;
}

function isMassMention(content, { limit = 5 } = {}) {
  return countMentions(content || '') >= limit;
}

function countEmojis(content) {
  const custom = (content.match(/<a?:\w+:\d+>/g) || []).length;
  // Emojis unicode (approché)
  const unicode = (content.match(/\p{Extended_Pictographic}/gu) || []).length;
  return custom + unicode;
}

function isEmojiSpam(content, { limit = 8 } = {}) {
  return countEmojis(content || '') >= limit;
}

/** RegExp compilée par liste de mots (référence du tableau) : la config est mise en cache. */
const badWordCache = new WeakMap();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * RegExp « mot entier » pour une liste de mots interdits (insensible à la casse,
 * frontières Unicode : « con » ne correspond pas à « conseil » ni à « déconné »).
 * @param {string[]} words
 * @returns {RegExp|null}
 */
function badWordRegex(words) {
  if (badWordCache.has(words)) return badWordCache.get(words);
  const parts = [...new Set(words.map((w) => String(w ?? '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const re = parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  badWordCache.set(words, re);
  return re;
}

function containsBadWord(content, words = []) {
  if (!Array.isArray(words) || !words.length) return false;
  const re = badWordRegex(words);
  return Boolean(re && re.test(content || ''));
}

module.exports = {
  hasInvite,
  hasLink,
  isExcessiveCaps,
  countMentions,
  isMassMention,
  countEmojis,
  isEmojiSpam,
  containsBadWord,
  badWordRegex,
  INVITE_REGEX,
  LINK_REGEX,
};
