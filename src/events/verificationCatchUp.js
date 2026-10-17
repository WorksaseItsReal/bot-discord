'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('verificationCatchUp');

const stopping = (client) => Boolean(client.shutdownPromise);

/**
 * Vérification en mode « retrait » : au démarrage, les arrivées faites pendant un arrêt du
 * bot reçoivent le rôle « non vérifié » (WelcomeService.catchUpOfflineJoins). Un serveur à
 * la fois, sans bloquer les autres gestionnaires de clientReady ; seuls les serveurs dont la
 * vérification est active en mode « retrait » sont lus.
 */
module.exports = {
  name: 'clientReady',
  once: true,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client) {
    const welcome = client.services?.welcome;
    if (!welcome?.catchUpOfflineJoins) return;
    const run = async () => {
      for (const guildId of [...client.guilds.cache.keys()]) {
        if (stopping(client)) return;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        await welcome.catchUpOfflineJoins(guild).catch((e) => logger.warn(`Rattrapage de la vérification (${guildId}) :`, e?.message));
      }
    };
    run().catch((e) => logger.warn('Rattrapage de la vérification :', e?.message));
  },
};
