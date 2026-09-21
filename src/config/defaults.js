'use strict';

/**
 * Configuration par défaut d'un serveur (guild).
 * Toute donnée est spécifique à un guildId ; ceci sert de base lors du
 * premier accès à la configuration d'un serveur.
 */
const defaultGuildConfig = Object.freeze({
  locale: 'fr',
  logChannels: {
    moderation: null,
    messages: null,
    members: null,
    roles: null,
    channels: null,
    voice: null,
    security: null,
    automod: null,
  },
  moderation: {
    dmOnSanction: true,
    requireReason: false,
    confirmDangerous: true,
  },
  strikes: {
    enabled: true,
    // Paliers configurables: nombre de strikes -> sanction
    thresholds: [
      { strikes: 3, action: 'mute', duration: '1h' },
      { strikes: 5, action: 'kick', duration: null },
      { strikes: 7, action: 'ban', duration: null },
    ],
  },
  automod: {
    enabled: false,
    ignoredChannels: [],
    ignoredRoles: [],
  },
  antiraid: {
    enabled: false,
    joinThreshold: 10,
    joinWindowSeconds: 10,
  },
  whitelist: {
    users: [],
    roles: [],
  },
});

module.exports = { defaultGuildConfig };
