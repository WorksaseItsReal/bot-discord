'use strict';

const { EmbedBuilder } = require('discord.js');
const { config } = require('../config');

/**
 * Fabrique d'embeds thématisés. Centralise couleurs et style pour éviter la
 * duplication dans toutes les commandes.
 */

function base(color) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

const embeds = {
  success: (description, title) => base(config.colors.success).setDescription(`${config.emojis.success} ${description}`).setTitle(title ?? null),
  error: (description, title) => base(config.colors.error).setDescription(`${config.emojis.error} ${description}`).setTitle(title ?? null),
  warning: (description, title) => base(config.colors.warning).setDescription(`${config.emojis.warning} ${description}`).setTitle(title ?? null),
  info: (description, title) => base(config.colors.info).setDescription(`${config.emojis.info} ${description}`).setTitle(title ?? null),
  moderation: (title) => base(config.colors.moderation).setTitle(title ?? null),
  security: (title) => base(config.colors.security).setTitle(title ?? null),
  neutral: (title) => base(config.colors.primary).setTitle(title ?? null),
};

/** Réponse d'erreur normalisée (éphémère par défaut). */
function errorReply(description) {
  return { embeds: [embeds.error(description)], ephemeral: true };
}

/** Réponse de succès normalisée. */
function successReply(description, { ephemeral = false } = {}) {
  return { embeds: [embeds.success(description)], ephemeral };
}

module.exports = { embeds, errorReply, successReply };
