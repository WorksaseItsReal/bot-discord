'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('levelRewardsRejoin');

/**
 * Niveaux : un membre qui revient retrouve ses rôles de récompense (son niveau est conservé),
 * à l'arrivée ou, s'il passe par l'écran d'adhésion, quand il l'accepte. Si la vérification
 * est active, ils sont rendus par la vérification réussie (WelcomeService#verify) : jamais
 * d'accès par une récompense avant la vérification. Voir LevelService#restoreRewards.
 */
module.exports = [
  {
    name: 'guildMemberAdd',
    async execute(client, member) {
      if (!member?.guild || member.user?.bot) return;
      await client.services.levels?.restoreRewards?.(member).catch((e) => logger.debug('restoreRewards', e?.message));
    },
  },
  {
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      if (!newMember?.guild || newMember.user?.bot || oldMember?.pending !== true || newMember.pending !== false) return;
      await client.services.levels?.restoreRewards?.(newMember).catch((e) => logger.debug('restoreRewards', e?.message));
    },
  },
];
