'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('tempvoice');

/**
 * Au démarrage : supprime les vocaux temporaires restés vides pendant que le
 * bot était hors ligne et oublie ceux qui n'existent plus.
 */
module.exports = {
  name: 'clientReady',
  once: true,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client) {
    const service = client.services?.tempVoice;
    if (!service?.cleanup) return;
    try {
      const { deleted, dropped } = await service.cleanup(client);
      if (deleted || dropped) logger.info(`Vocaux temporaires nettoyés : ${deleted} salon(s) vide(s) supprimé(s), ${dropped} entrée(s) obsolète(s).`);
    } catch (err) {
      logger.warn('Nettoyage des vocaux temporaires impossible :', err?.message);
    }
  },
};
