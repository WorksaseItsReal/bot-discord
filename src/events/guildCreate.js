'use strict';

const { createLogger } = require('../core/logger');
const { reconcileGuild } = require('./ticketReconcile');

const logger = createLogger('guild');

module.exports = {
  name: 'guildCreate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, guild) {
    logger.info(`Ajouté au serveur ${guild.name} (${guild.id}) — ${guild.memberCount} membres.`);
    // De retour sur un serveur quitté : annule la purge programmée de sa config.
    if (client.services.config.clearLeft(guild.id)) logger.info(`Purge de la configuration annulée pour ${guild.id}.`);
    // Initialise la config par défaut (lazy: sera créée au premier accès)
    client.services.config.get(guild.id);
    // Réinvitation : tickets et conversations ModMail dont le salon a été supprimé pendant
    // l'absence du bot (sinon le membre reste bloqué par sa limite jusqu'au redémarrage).
    return reconcileGuild(client, guild).then((n) => {
      if (n.tickets || n.modmail) logger.info(`Réconciliation (${guild.id}) : ${n.tickets} ticket(s) et ${n.modmail} conversation(s) ModMail sans salon fermé(s).`);
    });
  },
};
