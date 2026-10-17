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

    // Statuts tournants : activité imposée par /bot (prioritaire), sinon PRESENCE_STATUSES /
    // PRESENCE_INTERVAL_MINUTES, sinon statuts par défaut. Un seul minuteur (client.presenceTimer).
    const settings = presenceSettings(client.config);
    if (settings.invalid.length) logger.warn(`PRESENCE_STATUSES : ${settings.invalid.length} statut(s) ignoré(s) (vide, plus de 128 caractères ou plus de 10 statuts).`);
    const onError = (err) => logger.debug('Mise à jour du statut impossible :', err?.message);
    if (client.services?.botProfile) client.services.botProfile.startPresence(onError);
    else startPresenceRotation(client, settings, onError);
  },
};
