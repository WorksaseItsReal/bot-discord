'use strict';

/**
 * Statistiques du serveur (/statistiques, /activite) : collecte de COMPTEURS uniquement
 * (jamais le contenu). Tout passe par ActivityService, qui garde les compteurs en mémoire
 * et les écrit par lots (toutes les 30 s et à l'arrêt) : aucune écriture par message.
 * Bots, webhooks, messages système et salons ignorés des logs ne comptent pas.
 */
const activity = (client) => client.services.activity;

module.exports = [
  {
    name: 'messageCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    execute(client, message) {
      activity(client)?.recordMessage(message);
    },
  },
  {
    name: 'voiceStateUpdate',
    execute(client, oldState, newState) {
      activity(client)?.trackVoice(oldState, newState);
    },
  },
  {
    name: 'guildMemberAdd',
    execute(client, member) {
      activity(client)?.recordFlow(member, 'join');
    },
  },
  {
    name: 'guildMemberRemove',
    execute(client, member) {
      activity(client)?.recordFlow(member, 'leave');
    },
  },
  {
    // Démarrage : début de collecte des serveurs et membres déjà en vocal.
    name: 'clientReady',
    once: true,
    execute(client) {
      activity(client)?.onReady();
    },
  },
  {
    name: 'guildCreate',
    execute(client, guild) {
      activity(client)?.onGuildAvailable(guild);
    },
  },
  {
    // Serveur quitté : ses sessions vocales sont closes (sinon créditées indéfiniment).
    name: 'guildDelete',
    execute(client, guild) {
      if (guild?.available === false) return; // panne passagère, pas un départ
      activity(client)?.onGuildRemoved(guild?.id);
    },
  },
];
