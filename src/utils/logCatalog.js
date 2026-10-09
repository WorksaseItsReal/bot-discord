'use strict';

/**
 * Catalogue des logs : catégories (un salon chacune) et événements activables
 * un par un. Source unique pour /logs, le service de logs et la création
 * automatique des salons. Pur.
 */
const LOG_CATEGORIES = Object.freeze({
  moderation: {
    emoji: '🔨',
    label: 'Modération',
    channel: 'modération',
    description: 'Sanctions, levées de sanction, actions manuelles, tickets et signalements.',
    events: { sanction: 'Sanctions (warn, mute, timeout, kick, ban)', revocation: 'Levées de sanction', manualBan: 'Actions manuelles (bans, kicks, timeouts hors du bot)', ticket: 'Tickets ouverts', report: 'Signalements de messages' },
  },
  messages: {
    emoji: '💬',
    label: 'Messages',
    channel: 'messages',
    description: 'Messages supprimés, modifiés ou purgés en masse.',
    events: { messageDelete: 'Messages supprimés', messageEdit: 'Messages modifiés', messageBulkDelete: 'Suppressions en masse' },
  },
  members: {
    emoji: '👥',
    label: 'Membres',
    channel: 'membres',
    description: 'Arrivées, départs, vérifications, rôles, pseudos (avec l\'auteur) et boosts.',
    events: { memberJoin: 'Arrivées', memberLeave: 'Départs', memberRoles: 'Rôles ajoutés / retirés', memberNickname: 'Changements de pseudo', memberBoost: 'Boosts', memberVerify: 'Vérifications réussies' },
  },
  roles: {
    emoji: '🎭',
    label: 'Rôles',
    channel: 'rôles',
    description: 'Création, suppression et modification des rôles.',
    events: { roleCreate: 'Rôles créés', roleDelete: 'Rôles supprimés', roleUpdate: 'Rôles modifiés' },
  },
  channels: {
    emoji: '🗂️',
    label: 'Salons',
    channel: 'salons',
    description: 'Salons et fils créés, supprimés ou modifiés.',
    events: { channelCreate: 'Salons créés', channelDelete: 'Salons supprimés', channelUpdate: 'Salons modifiés', threadCreate: 'Fils créés', threadDelete: 'Fils supprimés' },
  },
  voice: {
    emoji: '🔊',
    label: 'Vocal',
    channel: 'vocal',
    description: 'Connexions, déconnexions et changements de salon vocal.',
    events: { voiceJoin: 'Connexions', voiceLeave: 'Déconnexions', voiceMove: 'Changements de salon' },
  },
  security: {
    emoji: '🛡️',
    label: 'Sécurité',
    channel: 'sécurité',
    description: 'Alertes AntiRaid et verrouillages du serveur.',
    events: { antiraid: 'Alertes AntiRaid', lockdown: 'Verrouillages / déverrouillages' },
  },
  automod: {
    emoji: '🤖',
    label: 'AutoMod',
    channel: 'automod',
    description: 'Messages filtrés par l\'AutoMod et sanctions automatiques.',
    events: { automod: 'Messages filtrés' },
  },
  server: {
    emoji: '🏠',
    label: 'Serveur',
    channel: 'serveur',
    description: 'Paramètres du serveur, emojis et administration de l\'économie.',
    events: { serverUpdate: 'Paramètres du serveur', emojiCreate: 'Emojis ajoutés', emojiDelete: 'Emojis supprimés', economy: 'Économie (soldes, boutique, réglages)' },
  },
});

const CATEGORY_KEYS = Object.keys(LOG_CATEGORIES);

/** événement → catégorie. */
const EVENT_CATEGORY = Object.freeze(
  Object.fromEntries(CATEGORY_KEYS.flatMap((c) => Object.keys(LOG_CATEGORIES[c].events).map((e) => [e, c]))),
);
const EVENT_KEYS = Object.keys(EVENT_CATEGORY);

/**
 * Dispositions de la création automatique : quelles catégories partagent un salon.
 * @type {Record<string, { label: string, emoji: string, description: string, groups: (selected: string[]) => Array<{ name: string, emoji: string, categories: string[] }> }>}
 */
const LAYOUTS = {
  perCategory: {
    label: 'Un salon par catégorie',
    emoji: '🗃️',
    description: 'Le plus lisible : chaque type de log a son salon.',
    groups: (selected) => selected.map((c) => ({ name: LOG_CATEGORIES[c].channel, emoji: LOG_CATEGORIES[c].emoji, categories: [c] })),
  },
  grouped: {
    label: 'Trois salons regroupés',
    emoji: '🗂️',
    description: 'Modération & sécurité · Messages · Serveur & membres.',
    groups: (selected) =>
      [
        { name: 'modération', emoji: '🔨', categories: ['moderation', 'security', 'automod'] },
        { name: 'messages', emoji: '💬', categories: ['messages'] },
        { name: 'serveur', emoji: '🏠', categories: ['members', 'roles', 'channels', 'voice', 'server'] },
      ]
        .map((g) => ({ ...g, categories: g.categories.filter((c) => selected.includes(c)) }))
        .filter((g) => g.categories.length),
  },
  single: {
    label: 'Un seul salon',
    emoji: '📜',
    description: 'Tout au même endroit : idéal pour un petit serveur.',
    groups: (selected) => (selected.length ? [{ name: 'logs', emoji: '📜', categories: [...selected] }] : []),
  },
};

/** Nom de salon Discord : « 📋・modération » (minuscules, sans espaces). Pur. */
function channelName(emoji, name) {
  return `${emoji}・${name}`.toLowerCase().replace(/\s+/g, '-').slice(0, 100);
}

module.exports = { LOG_CATEGORIES, CATEGORY_KEYS, EVENT_CATEGORY, EVENT_KEYS, LAYOUTS, channelName };
