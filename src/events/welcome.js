'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('welcome');

/**
 * Accueil des nouveaux membres (services/WelcomeService.js).
 *  - L'arrivée est traitée par guildMemberAdd.js, APRÈS l'AntiRaid (membre sanctionné : rien).
 *  - guildMemberUpdate : écran d'adhésion de Discord accepté (pending → false) → accueil.
 *  - guildMemberRemove : message de départ.
 */
module.exports = [
  {
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      await client.services.welcome?.handleScreeningPassed(oldMember, newMember).catch((e) => logger.debug('screening', e?.message));
    },
  },
  {
    name: 'guildMemberRemove',
    async execute(client, member) {
      await client.services.welcome?.handleLeave(member).catch((e) => logger.debug('leave', e?.message));
    },
  },
];
