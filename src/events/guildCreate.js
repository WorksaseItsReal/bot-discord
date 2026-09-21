'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('guild');

module.exports = {
  name: 'guildCreate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, guild) {
    logger.info(`Ajouté au serveur ${guild.name} (${guild.id}) — ${guild.memberCount} membres.`);
    // Initialise la config par défaut (lazy: sera créée au premier accès)
    client.services.config.get(guild.id);
  },
};
