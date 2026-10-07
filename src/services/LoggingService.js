'use strict';

const { createLogger } = require('../core/logger');
const { card } = require('../utils/ui');

const logger = createLogger('logs');

/** En-tête « Logs · <catégorie> » de chaque catégorie de logs. */
const LOG_SECTIONS = Object.freeze({
  moderation: { emoji: '🔨', label: 'Modération' },
  messages: { emoji: '💬', label: 'Messages' },
  members: { emoji: '👥', label: 'Membres' },
  roles: { emoji: '🎭', label: 'Rôles' },
  channels: { emoji: '🗂️', label: 'Salons' },
  voice: { emoji: '🔊', label: 'Vocal' },
  security: { emoji: '🛡️', label: 'Sécurité' },
  automod: { emoji: '🤖', label: 'AutoMod' },
});

/** Section d'une carte de log : `{ emoji, label: 'Logs · Messages' }`. */
function logSection(category) {
  const meta = LOG_SECTIONS[category] ?? { emoji: '📋', label: category };
  return { emoji: meta.emoji, label: `Logs · ${meta.label}` };
}

/**
 * Carte de log standard : section « Logs · … », miniature de l'utilisateur
 * concerné et identifiant en pied de page (`ID : …`).
 * @param {{
 *   category: keyof LOG_SECTIONS, tone?: string, icon?: string, title: string,
 *   description?: string|string[], user?: import('discord.js').User|null,
 *   thumbnail?: string|null, fields?: object[], id?: string|null,
 * }} opts
 */
function logCard({ category, tone = 'info', icon, title, description, user, thumbnail, fields = [], id }) {
  const footerId = id ?? user?.id;
  return card({
    tone,
    section: logSection(category),
    icon,
    title,
    description,
    thumbnail: thumbnail ?? user?.displayAvatarURL?.() ?? null,
    fields,
    footer: footerId ? `ID : ${footerId}` : undefined,
  });
}

/** Liste de mentions qui tient dans `max` caractères sans couper une mention. Pur. */
function fitList(items, max = 1000, separator = ' ') {
  if (!items?.length) return null;
  const out = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    if (used + items[i].length + separator.length > max - 12) {
      out.push(`+${items.length - i}`);
      break;
    }
    out.push(items[i]);
    used += items[i].length + separator.length;
  }
  return out.join(separator);
}

/**
 * Envoie des embeds de log dans le salon configuré pour chaque catégorie.
 * Tolère silencieusement l'absence de configuration ou de permissions.
 */
class LoggingService {
  /**
   * @param {import('discord.js').Client} client
   * @param {import('./ConfigService').ConfigService} configService
   */
  constructor(client, configService) {
    this.client = client;
    this.config = configService;
  }

  /**
   * @param {string} guildId
   * @param {'moderation'|'messages'|'members'|'roles'|'channels'|'voice'|'security'|'automod'} category
   * @param {import('discord.js').EmbedBuilder} embed
   * @param {import('discord.js').ActionRowBuilder[]} [components] boutons optionnels (ex : « Aller au message »)
   */
  async send(guildId, category, embed, components) {
    try {
      const cfg = this.config.get(guildId);
      const channelId = cfg.logChannels?.[category];
      if (!channelId) return;
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      const payload = { embeds: [embed] };
      if (components?.length) payload.components = components;
      await channel.send(payload);
    } catch (err) {
      logger.debug(`Impossible d'envoyer un log (${category}) pour ${guildId}:`, err?.message);
    }
  }
}

module.exports = { LoggingService, LOG_SECTIONS, logSection, logCard, fitList };
