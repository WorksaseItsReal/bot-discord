'use strict';

/**
 * Compteurs de statistiques : déclenchements (avec anti-rebond) de la mise à jour groupée
 * et nettoyage de la configuration quand un salon compteur est supprimé à la main.
 * Le passage périodique (toutes les 10 min) est géré par StatsCounterService.start().
 */
const schedule = (client, guildId, delay) => client.services.counters?.schedule(guildId, delay);

module.exports = [
  {
    name: 'clientReady',
    once: true,
    execute(client) {
      // Premier passage peu après le démarrage (un salon dont la valeur n'a pas changé n'est pas renommé).
      for (const guildId of client.guilds.cache.keys()) schedule(client, guildId, 15_000);
    },
  },
  {
    name: 'guildMemberAdd',
    execute(client, member) {
      schedule(client, member.guild.id);
    },
  },
  {
    name: 'guildMemberRemove',
    execute(client, member) {
      schedule(client, member.guild.id);
    },
  },
  {
    name: 'guildUpdate',
    execute(client, oldGuild, newGuild) {
      if (oldGuild.premiumSubscriptionCount !== newGuild.premiumSubscriptionCount) schedule(client, newGuild.id);
    },
  },
  {
    name: 'guildMemberUpdate',
    execute(client, oldMember, newMember) {
      if (Boolean(oldMember.premiumSince) !== Boolean(newMember.premiumSince)) schedule(client, newMember.guild.id);
    },
  },
  {
    name: 'channelDelete',
    execute(client, channel) {
      if (channel.guild) client.services.counters?.forgetChannel(channel.guild.id, channel.id);
    },
  },
];
