'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('automations');

/**
 * Automatisations (/automatisations) : publication automatique et fils (messages), rôle
 * vocal (connexions vocales, rattrapage au démarrage), remerciement de boost.
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
