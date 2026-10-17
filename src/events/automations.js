'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('automations');

/**
 * Automatisations (/automatisations) : publication automatique et fils (messages), rôle
 * vocal (connexions vocales ; rattrapage au démarrage, à la reprise de session, quand un
 * serveur redevient disponible, et toutes les 15 min par le scheduler), remerciement de boost.
 * Le log « Nouveau boost » reste dans logExtras.js ; les deux s'appuient sur la même
 * détection (`boostChange`, services/AutomationService.js).
 */
module.exports = [
  {
    name: 'messageCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    execute(client, message) {
      // Programmé (après le passage de l'AutoMod) : l'écouteur ne bloque rien.
      client.services.automations?.handleMessage(message);
    },
  },
  {
    name: 'voiceStateUpdate',
    execute(client, oldState, newState) {
      return client.services.automations?.handleVoiceUpdate(oldState, newState);
    },
  },
  {
    name: 'guildMemberUpdate',
    execute(client, oldMember, newMember) {
      return client.services.automations?.handleMemberUpdate(oldMember, newMember);
    },
  },
  {
    // Serveur redevenu disponible (panne Discord) : événements vocaux manqués rattrapés.
    name: 'guildAvailable',
    execute(client, guild) {
      client.services.automations?.requestReconcile(guild);
    },
  },
  {
    // Session reprise (RESUME) ou rouverte (nouvelle IDENTIFY après une coupure) : rattrapage
    // de tous les serveurs. Le tout premier « shardReady » (démarrage) est laissé à clientReady.
    name: 'shardResume',
    execute(client) {
      for (const guild of client.guilds.cache.values()) client.services.automations?.requestReconcile(guild);
    },
  },
  {
    name: 'shardReady',
    execute(client) {
      if (!client.isReady?.()) return;
      for (const guild of client.guilds.cache.values()) client.services.automations?.requestReconcile(guild);
    },
  },
  {
    name: 'clientReady',
    once: true,
    async execute(client) {
      // Rattrapage : rôle vocal donné aux membres déjà en vocal, retiré aux autres.
      for (const guild of client.guilds.cache.values()) {
        const n = await client.services.automations?.reconcileGuild(guild).catch((err) => logger.warn(`Rattrapage du rôle vocal (serveur ${guild.id}) :`, err?.message ?? err));
        if (n) logger.info(`Rôle vocal : ${n} membre(s) vérifié(s) sur ${guild.id}.`);
      }
    },
  },
];
