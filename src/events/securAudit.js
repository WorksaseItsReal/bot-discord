'use strict';

/**
 * Secur (anti-nuke) : chaque entrée du journal d'audit passe par le moteur (modules du registre,
 * accès de whitelist donnés par un non-owner). Sortie immédiate si rien n'est actif.
 * Serveur quitté : l'état mémoire de Secur est oublié (les données le sont 30 jours plus tard
 * par la purge des serveurs quittés).
 * Requiert l'intent GuildModeration et la permission « Voir les logs du serveur ».
 */
module.exports = [
  {
    name: 'guildAuditLogEntryCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    async execute(client, entry, guild) {
      await client.services?.secur?.handleAuditEntry?.(entry, guild);
    },
  },
  {
    name: 'guildDelete',
    execute(client, guild) {
      if (guild?.available === false) return; // panne Discord passagère : pas un départ
      client.services?.secur?.forgetGuild?.(guild?.id);
    },
  },
];
