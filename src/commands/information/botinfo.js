'use strict';

const { SlashCommandBuilder, version: djsVersion } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { formatDuration } = require('../../utils/time');

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Affiche les informations et statistiques du bot.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const mem = process.memoryUsage().rss / 1024 / 1024;
    const embed = embeds.neutral(`🤖 ${client.user.username}`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Version', value: `v${client.config.version}`, inline: true },
        { name: 'discord.js', value: `v${djsVersion}`, inline: true },
        { name: 'Node.js', value: process.version, inline: true },
        { name: 'Serveurs', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Utilisateurs (cache)', value: `${client.users.cache.size}`, inline: true },
        { name: 'Commandes', value: `${client.commands.size}`, inline: true },
        { name: 'Uptime', value: formatDuration(client.uptime), inline: true },
        { name: 'Mémoire', value: `${mem.toFixed(1)} Mo`, inline: true },
        { name: 'Latence WS', value: `${Math.max(0, Math.round(client.ws.ping))}ms`, inline: true },
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
