'use strict';

const { createLogger } = require('../core/logger');
const { presenceSettings, startPresenceRotation } = require('../utils/presence');

const logger = createLogger('presence');

/**
 * Session rouverte par une NOUVELLE IDENTIFY (après une coupure sans reprise possible) : Discord
 * repart de la présence par défaut (« En ligne », sans activité). L'activité imposée par /bot (ou
 * la rotation des statuts) est réappliquée tout de suite, sans attendre le prochain tick (jusqu'à
 * 24 h). Une reprise (RESUME) garde la présence ; le tout premier shardReady (démarrage) est
 * laissé à clientReady (events/ready.js).
 */
module.exports = {
  name: 'shardReady',
  execute(client) {
    if (!client.isReady?.()) return;
    const onError = (err) => logger.debug('Mise à jour du statut impossible :', err?.message);
    if (client.services?.botProfile) client.services.botProfile.startPresence(onError);
    else startPresenceRotation(client, presenceSettings(client.config), onError);
  },
};
