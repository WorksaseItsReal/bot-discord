'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('tickets');

/**
 * Au démarrage : ferme les tickets et conversations ModMail dont le salon a été
 * supprimé pendant que le bot était hors ligne. Serveur par serveur, uniquement
 * pour les serveurs disponibles dans le cache (une panne n'efface rien).
 */
module.exports = {
  name: 'clientReady',
  once: true,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client) {
    const { tickets, modmail } = client.services ?? {};
    let ticketCount = 0;
    let modmailCount = 0;
    for (const guild of client.guilds.cache.values()) {
      if (guild.available === false) continue;
      try {
        if (tickets?.reconcile) ticketCount += await tickets.reconcile(guild);
        if (modmail?.reconcile) modmailCount += await modmail.reconcile(guild);
      } catch (err) {
        logger.warn(`Réconciliation des tickets impossible sur ${guild.id} :`, err?.message);
      }
    }
    if (ticketCount || modmailCount) {
      logger.info(`Réconciliation : ${ticketCount} ticket(s) et ${modmailCount} conversation(s) ModMail sans salon fermé(s).`);
    }
  },
};
