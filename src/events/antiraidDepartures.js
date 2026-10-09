'use strict';

/**
 * AntiRaid : mémorise les départs d'arrivants récents. L'entrée d'audit d'une expulsion
 * (MemberKick) arrive généralement après le départ du membre, sorti du cache : sans
 * cette trace, l'expulsion d'un raider pourrait être comptée comme destructrice.
 */
module.exports = {
  name: 'guildMemberRemove',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, member) {
    client.services.antiraid?.rememberDeparture?.(member);
  },
};
