'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('guild');

module.exports = {
  name: 'guildDelete',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, guild) {
    // Panne Discord (serveur indisponible) : ce n'est pas un départ.
    if (guild.available === false) return;
    logger.info(`Retiré du serveur ${guild.name ?? 'inconnu'} (${guild.id}).`);
    // Départ daté : la config est purgée par le scheduler si le bot ne revient pas sous 30 jours.
    try {
      client.services.config.markLeft(guild.id);
    } catch (err) {
      logger.warn(`Impossible de dater le départ du serveur ${guild.id} :`, err?.message);
      client.services.config.invalidate(guild.id);
    }
    // États de verrouillage / masquage oubliés : le bot ne voit plus les salons changer pendant son
    // absence ; à son retour, ils annonceraient un lockdown fantôme et une levée rouvrirait des
    // salons passés en lecture seule entre-temps.
    try {
      client.repositories?.locks?.deleteGuild?.(guild.id);
    } catch (err) {
      logger.warn(`Impossible d'oublier les verrouillages du serveur ${guild.id} :`, err?.message);
    }
  },
};
