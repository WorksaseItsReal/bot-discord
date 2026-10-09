'use strict';

/**
 * Mini-jeux (/jeu) : une carte de partie supprimée (bouton 🗑️, modérateur, purge), un salon
 * ou un fil supprimé (fil : threadDelete ; salon : ses fils aussi) arrête la partie, ce qui
 * libère aussitôt ses verrous (une partie par joueur ou par salon) au lieu d'attendre
 * l'expiration après 10 minutes d'inactivité.
 * Messages partiels acceptés : seul l'identifiant est utilisé.
 */
module.exports = [
  {
    name: 'messageDelete',
    execute(client, message) {
      if (message?.id) client.services.games?.endByMessage(message.id);
    },
  },
  {
    name: 'messageDeleteBulk',
    execute(client, messages) {
      for (const id of messages?.keys?.() ?? []) client.services.games?.endByMessage(id);
    },
  },
  {
    name: 'channelDelete',
    execute(client, channel) {
      if (channel?.id) client.services.games?.endByChannel(channel.id);
    },
  },
  {
    // Un fil supprimé produit threadDelete (jamais channelDelete) : ses parties s'arrêtent aussi.
    name: 'threadDelete',
    execute(client, thread) {
      if (thread?.id) client.services.games?.endByChannel(thread.id);
    },
  },
];
