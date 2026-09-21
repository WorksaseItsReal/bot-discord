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
    mutedRoleId: null,
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
    // Chaque filtre : { enabled, action, ...seuils }. action: delete|warn|timeout
    filters: {
      antiSpam: { enabled: false, limit: 5, windowSeconds: 5, action: 'timeout', duration: '5m' },
      antiFlood: { enabled: false, limit: 7, windowSeconds: 10, action: 'delete' },
      antiLink: { enabled: false, action: 'delete' },
      antiInvite: { enabled: false, action: 'delete' },
      antiMassMention: { enabled: false, limit: 5, action: 'timeout', duration: '10m' },
      antiCaps: { enabled: false, percent: 70, minLength: 10, action: 'delete' },
      badWords: { enabled: false, words: [], action: 'delete' },
      antiRepeat: { enabled: false, action: 'delete' },
      antiEmojiSpam: { enabled: false, limit: 8, action: 'delete' },
      antiDuplicate: { enabled: false, action: 'delete' },
    },
  },
  antiraid: {
    enabled: false,
    joinThreshold: 10,
    joinWindowSeconds: 10,
    minAccountAgeDays: 0,
    antiBot: false,
    action: 'kick', // kick | ban | lockdown
    alertChannel: null,
    // Seuils de destruction (via audit log)
    channelDeleteThreshold: 3,
    roleDeleteThreshold: 3,
    banThreshold: 5,
    destructiveWindowSeconds: 10,
    punishExecutor: 'strip', // strip (retire les rôles) | ban | none
  },
  whitelist: {
    users: [],
    roles: [],
  },
  tickets: {
    categoryId: null,
    supportRoleId: null,
    logChannel: null,
    maxPerUser: 1,
  },
  modmail: {
    enabled: false,
    categoryId: null,
    staffRoleId: null,
    logChannel: null,
  },
  suggestions: {
    channelId: null,
  },
  giveaways: {
    // rien de configurable au niveau serveur pour l'instant (tout au niveau du giveaway)
  },
  tempVoice: {
    enabled: false,
    hubChannelId: null,   // salon "Créer un vocal"
    categoryId: null,
    nameTemplate: 'Vocal de {user}',
  },
  autobackup: {
    enabled: false,
    intervalHours: 24,
    lastRun: 0,
  },
});

module.exports = { defaultGuildConfig };
