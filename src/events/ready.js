'use strict';

const { createLogger } = require('../core/logger');
const { setBrand } = require('../utils/embeds');
const { presenceSettings, startPresenceRotation } = require('../utils/presence');

const logger = createLogger('ready');

module.exports = {
  name: 'clientReady',
  once: true,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client) {
    setBrand({ name: client.user.username, iconURL: client.user.displayAvatarURL({ size: 128 }) });
    logger.info(`Connecté en tant que ${client.user.tag} — ${client.guilds.cache.size} serveur(s), ${client.commands.size} commandes.`);

    // Statuts tournants (PRESENCE_STATUSES / PRESENCE_INTERVAL_MINUTES, sinon statuts par défaut).
    const settings = presenceSettings(client.config);
    if (settings.invalid.length) logger.warn(`PRESENCE_STATUSES : ${settings.invalid.length} statut(s) ignoré(s) (vide, plus de 128 caractères ou plus de 10 statuts).`);
    startPresenceRotation(client, settings, (err) => logger.debug('Mise à jour du statut impossible :', err?.message));
  },
};
