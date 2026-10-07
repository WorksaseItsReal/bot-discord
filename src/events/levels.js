'use strict';

/**
 * Niveaux / XP. Fichier séparé de messageCreate.js (AutoMod) et voiceStateUpdate.js (logs).
 *
 * L'XP d'un message est accordée APRÈS l'AutoMod : LevelService#handleMessage programme
 * le gain quelques secondes plus tard et l'abandonne si le message a été supprimé
 * entre-temps (messageDelete ci-dessous, ou marque posée par l'AutoMod dans LoggingService).
 */
module.exports = [
  {
    name: 'messageCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    execute(client, message) {
      if (!message.guild || message.author?.bot) return;
      client.services.levels?.handleMessage(message);
    },
  },
  {
    name: 'messageDelete',
    execute(client, message) {
      client.services.levels?.markDeleted(message?.id);
    },
  },
  {
    name: 'messageDeleteBulk',
    execute(client, messages) {
      for (const id of messages?.keys?.() ?? []) client.services.levels?.markDeleted(id);
    },
  },
  {
    name: 'voiceStateUpdate',
    execute(client, oldState, newState) {
      client.services.levels?.trackVoice(oldState, newState);
    },
  },
];
