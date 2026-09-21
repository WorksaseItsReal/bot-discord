'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('logs');

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
   */
  async send(guildId, category, embed) {
    try {
      const cfg = this.config.get(guildId);
      const channelId = cfg.logChannels?.[category];
      if (!channelId) return;
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      await channel.send({ embeds: [embed] });
    } catch (err) {
      logger.debug(`Impossible d'envoyer un log (${category}) pour ${guildId}:`, err?.message);
    }
  }
}

module.exports = { LoggingService };
