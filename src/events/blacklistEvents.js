'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('blacklistEvents');

/**
 * Liste noire et blrank (services/BlacklistService.js, SEC3) :
 *  - guildBanRemove : un blacklisté débanni (à la main, par un autre bot…) est rebanni aussitôt,
 *    avec un log « Débannissement annulé » qui nomme l'auteur ;
 *  - guildMemberUpdate : un membre du blrank qui gagne un rôle le perd (3 fois au plus par 10 min).
 * L'arrivée d'un blacklisté est traitée par guildMemberAdd.js, AVANT l'AntiRaid.
 */
module.exports = [
  {
    name: 'guildBanRemove',
    async execute(client, ban) {
      await client.services.blacklist?.handleUnban(ban.guild, ban.user).catch((e) => logger.warn('Débannissement d\'un blacklisté :', e?.message));
    },
  },
  {
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      await client.services.blacklist?.handleMemberUpdate(oldMember, newMember).catch((e) => logger.warn('Blrank :', e?.message));
    },
  },
];
