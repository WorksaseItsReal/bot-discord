'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('guild');

module.exports = {
  name: 'guildDelete',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, guild) {
    logger.info(`Retiré du serveur ${guild.name ?? 'inconnu'} (${guild.id}).`);
    client.services.config.invalidate(guild.id);
  },
};
