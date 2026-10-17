'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('tempRoleRejoin');

/**
 * Rôles temporaires (services/TempRoleService.js) : un membre qui quitte puis revient
 * AVANT l'échéance retrouve ses rôles temporaires. Quitter le serveur ne doit pas
 * permettre d'échapper à un rôle (ni de le perdre). L'échéance, elle, ne change pas.
 */
module.exports = {
  name: 'guildMemberAdd',
  async execute(client, member) {
    if (member.user?.bot) return;
    await client.services.tempRoles?.reapply(member).catch((e) => logger.debug('reapply', e?.message));
  },
};
