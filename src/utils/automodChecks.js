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

function countMentions(content) {
  return (content.match(/<@!?(\d+)>|<@&(\d+)>/g) || []).length;
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

function containsBadWord(content, words = []) {
  if (!words.length) return false;
  const lower = (content || '').toLowerCase();
  return words.some((w) => w && lower.includes(String(w).toLowerCase()));
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
  INVITE_REGEX,
  LINK_REGEX,
};
