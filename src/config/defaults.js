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
    server: null,
  },
  // Réglages des logs (/logs). Les salons par catégorie sont dans logChannels.
  logs: {
    enabled: true,
    disabledEvents: [],      // événements désactivés (clés de utils/logCatalog.js)
    disabledCategories: [],  // catégories en pause (le salon est conservé)
    ignoredChannels: [],     // messages de ces salons (et de leurs fils) non journalisés
    ignoreBots: true,        // messages des bots non journalisés
    staffRoleId: null,       // rôle qui peut lire les salons de logs créés automatiquement
    categoryId: null,        // catégorie « Logs » créée automatiquement
    createdChannels: [],     // salons créés par le bot (pour le nettoyage)
    setup: { layout: 'perCategory', categories: ['moderation', 'messages', 'members', 'roles', 'channels', 'voice', 'security', 'automod', 'server'] },
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
    // Prévenir le membre : 'channel' (message éphémère dans le salon, supprimé après quelques
    // secondes), 'dm' (message privé) ou 'none'.
    notify: 'channel',
    // Sanctions progressives : au-delà de N infractions dans la fenêtre, la sanction monte.
    escalation: {
      enabled: true,
      windowMinutes: 30,
      steps: [
        { count: 3, action: 'timeout', duration: '10m' },
        { count: 5, action: 'timeout', duration: '1h' },
        { count: 8, action: 'kick', duration: null },
      ],
    },
    // Restrictions des nouveaux venus (comptes récents ou arrivés depuis peu).
    newMembers: {
      enabled: false,
      accountAgeDays: 7,
      joinedMinutes: 30,
      blockLinks: true,
      blockInvites: true,
      blockMedia: false,
    },
    // Chaque filtre : { enabled, action, ...seuils }. action : delete | warn | timeout | kick (antiHacked : quarantine)
    filters: {
      antiSpam: { enabled: false, limit: 5, windowSeconds: 5, action: 'timeout', duration: '5m' },
      antiFlood: { enabled: false, limit: 7, windowSeconds: 10, action: 'delete' },
      antiLink: { enabled: false, action: 'delete', allowedDomains: [] },
      antiInvite: { enabled: false, action: 'delete', allowedCodes: [], allowOwnServer: true },
      antiPhishing: { enabled: false, threshold: 3, action: 'timeout', duration: '1d' },
      antiCrossChannel: { enabled: false, channels: 3, windowSeconds: 60, minLength: 20, action: 'timeout', duration: '1h' },
      antiMassMention: { enabled: false, limit: 5, action: 'timeout', duration: '10m' },
      antiCaps: { enabled: false, percent: 70, minLength: 10, action: 'delete' },
      badWords: { enabled: false, words: [], action: 'delete' },
      antiRepeat: { enabled: false, action: 'delete' },
      antiEmojiSpam: { enabled: false, limit: 8, action: 'delete' },
      antiDuplicate: { enabled: false, action: 'delete' },
      antiWall: { enabled: false, maxLines: 15, maxLength: 1500, action: 'delete' },
      antiZalgo: { enabled: false, action: 'delete' },
      // Compte piraté : même lot de pièces jointes ou même message dans `channels` salons en
      // `windowSeconds` s, ou lien d'arnaque d'un score ≥ `scamScore`. Action « quarantine » :
      // timeout (`duration`) + suppression de ses messages des `purgeMinutes` dernières minutes
      // (+ retrait des rôles si `removeRoles`, rendus à la levée).
      antiHacked: { enabled: false, channels: 3, windowSeconds: 60, minLength: 20, scamScore: 5, action: 'quarantine', duration: '1d', purgeMinutes: 10, removeRoles: false },
    },
    // Exemptions propres à un filtre (en plus des exemptions globales) : chaque filtre accepte
    // `exemptChannels: []` et `exemptRoles: []` (réglables dans la vue du filtre).
  },
  antiraid: {
    enabled: false,
    joinThreshold: 10,
    joinWindowSeconds: 10,
    minAccountAgeDays: 0,
    antiBot: false,
    action: 'kick', // kick | ban | lockdown
    newAccountAction: null, // kick | ban — comptes récents / bots (null : ban si action = ban, sinon kick)
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
  projects: {
    openCreation: true,     // tout le monde peut créer un projet (sinon : gestionnaires uniquement)
    managerRoleId: null,    // rôle pouvant gérer TOUS les projets (en plus de « Gérer le serveur »)
    channelId: null,        // salon de publication par défaut
    maxPerUser: 10,         // projets actifs max par membre (hors gestionnaires)
  },
  autobackup: {
    enabled: false,
    intervalHours: 24,
    lastRun: 0,
  },
});

module.exports = { defaultGuildConfig };
