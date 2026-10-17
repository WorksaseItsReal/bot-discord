'use strict';

const { handleMessage } = require('../services/secur/modules/messages');

/**
 * Secur, module « everyone » (SEC5) : un message qui notifie réellement @everyone / @here, d'un
 * auteur non exempté, est signalé au moteur (secur.signal). Sortie immédiate si le module n'est
 * pas actif (config en cache) ou si le message ne mentionne pas @everyone : aucun coût sinon.
 * Ignorés : ce bot, messages système, crossposts des salons suivis (webhooks de suivi).
 */
module.exports = {
  name: 'messageCreate',
  async execute(client, message) {
    if (!message?.guild || !message.mentions?.everyone) return;
    await handleMessage(client, message);
  },
};
