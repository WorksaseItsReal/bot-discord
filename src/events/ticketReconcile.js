'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('tickets');

/**
 * Ferme les tickets et conversations ModMail d'un serveur dont le salon a été supprimé
 * pendant l'absence du bot. @returns {Promise<{ tickets: number, modmail: number }>}
 */
async function reconcileGuild(client, guild) {
  const { tickets, modmail } = client.services ?? {};
  const out = { tickets: 0, modmail: 0 };
  if (guild.available === false) return out;
  try {
    if (tickets?.reconcile) out.tickets = await tickets.reconcile(guild);
    if (modmail?.reconcile) out.modmail = await modmail.reconcile(guild);
  } catch (err) {
    logger.warn(`Réconciliation des tickets impossible sur ${guild.id} :`, err?.message);
  }
  return out;
}

/**
 * Au démarrage : ferme les tickets et conversations ModMail dont le salon a été
 * supprimé pendant que le bot était hors ligne. Serveur par serveur, uniquement
 * pour les serveurs disponibles dans le cache (une panne n'efface rien).
 * `reconcileGuild` sert aussi à la réinvitation du bot (events/guildCreate.js).
 */
module.exports = {
  name: 'clientReady',
  once: true,
  reconcileGuild,
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client) {
    let ticketCount = 0;
    let modmailCount = 0;
    for (const guild of client.guilds.cache.values()) {
      const n = await reconcileGuild(client, guild);
      ticketCount += n.tickets;
      modmailCount += n.modmail;
    }
    if (ticketCount || modmailCount) {
      logger.info(`Réconciliation : ${ticketCount} ticket(s) et ${modmailCount} conversation(s) ModMail sans salon fermé(s).`);
    }
  },
};
