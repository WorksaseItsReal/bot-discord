'use strict';

const { ActivityType } = require('discord.js');
const { createLogger } = require('../core/logger');
const { setBrand } = require('../utils/embeds');

const logger = createLogger('ready');

/** Intervalle de rotation du statut du bot. */
const PRESENCE_INTERVAL_MS = 60_000;

module.exports = {
  name: 'clientReady',
  once: true,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client) {
    setBrand({ name: client.user.username, iconURL: client.user.displayAvatarURL({ size: 128 }) });
    logger.info(`Connecté en tant que ${client.user.tag} — ${client.guilds.cache.size} serveur(s), ${client.commands.size} commandes.`);

    const presences = [
      () => ({ name: '/help • toutes les commandes', type: ActivityType.Watching }),
      () => ({ name: `${client.guilds.cache.size} serveur(s)`, type: ActivityType.Watching }),
      () => ({ name: '/projet • vos projets', type: ActivityType.Playing }),
      () => ({ name: `${client.guilds.cache.reduce((n, g) => n + (g.memberCount || 0), 0)} membres`, type: ActivityType.Listening }),
    ];
    let i = 0;
    const update = () => {
      try {
        client.user.setPresence({ activities: [presences[i % presences.length]()], status: 'online' });
        i += 1;
      } catch (err) {
        logger.debug('Mise à jour du statut impossible :', err?.message);
      }
    };
    update();
    client.presenceTimer = setInterval(update, PRESENCE_INTERVAL_MS);
    client.presenceTimer.unref?.();
  },
};
