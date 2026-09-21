'use strict';

const { ActivityType } = require('discord.js');
const { createLogger } = require('../core/logger');

const logger = createLogger('ready');

module.exports = {
  name: 'clientReady',
  once: true,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client) {
    const guilds = client.guilds.cache.size;
    logger.info(`Connecté en tant que ${client.user.tag} — ${guilds} serveur(s).`);
    client.user.setPresence({
      activities: [{ name: `/help • ${guilds} serveurs`, type: ActivityType.Watching }],
      status: 'online',
    });
  },
};
