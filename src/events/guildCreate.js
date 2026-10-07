'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('guild');

module.exports = {
  name: 'guildCreate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, guild) {
    logger.info(`Ajouté au serveur ${guild.name} (${guild.id}) — ${guild.memberCount} membres.`);
    // De retour sur un serveur quitté : annule la purge programmée de sa config.
    if (client.services.config.clearLeft(guild.id)) logger.info(`Purge de la configuration annulée pour ${guild.id}.`);
    // Initialise la config par défaut (lazy: sera créée au premier accès)
    client.services.config.get(guild.id);
  },
};
