'use strict';

const { AuditLogEvent } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { fetchExecutor } = require('../utils/audit');

module.exports = [
  {
    name: 'guildBanAdd',
    async execute(client, ban) {
      const executor = await fetchExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
      await client.services.logging.send(
        ban.guild.id,
        'moderation',
        embeds.moderation('🔨 Membre banni').addFields(
          { name: 'Utilisateur', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
          { name: 'Par', value: executor ? `<@${executor}>` : 'Inconnu', inline: true },
        ),
      );
      if (executor) await client.services.antiraid.handleDestructive(ban.guild, executor, 'ban').catch(() => {});
    },
  },
  {
    name: 'guildBanRemove',
    async execute(client, ban) {
      await client.services.logging.send(ban.guild.id, 'moderation', embeds.success(`${ban.user.tag} (${ban.user.id}) a été débanni.`, '🔓 Débannissement'));
    },
  },
];
