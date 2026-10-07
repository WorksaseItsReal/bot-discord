'use strict';

const { SlashCommandBuilder, version: djsVersion } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { formatDuration, discordTimestamp } = require('../../utils/time');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Affiche les informations et statistiques du bot.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const mem = process.memoryUsage().rss / 1024 / 1024;
    const members = client.guilds.cache.reduce((n, g) => n + (g.memberCount || 0), 0);
    const ws = Math.round(client.ws.ping);
    const embed = embeds
      .neutral(`🤖 ${client.user.username}`)
      .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
      .setDescription(`Bot de gestion tout-en-un : modération, sécurité, tickets, giveaways, **projets** et bien plus.\nCréé ${discordTimestamp(client.user.createdTimestamp, 'R')}.`)
      .addFields(
        { name: '📊 Statistiques', value: `Serveurs : **${client.guilds.cache.size}**\nMembres : **${members.toLocaleString('fr-FR')}**\nCommandes : **${client.commands.size}**`, inline: true },
        { name: '⚙️ Technique', value: `Version : **v${client.config.version}**\ndiscord.js : **v${djsVersion}**\nNode.js : **${process.version}**`, inline: true },
        { name: '💻 Système', value: `Uptime : **${formatDuration(client.uptime)}**\nMémoire : **${mem.toFixed(1)} Mo**\nLatence : **${ws < 0 ? 'N/A' : `${ws} ms`}**`, inline: true },
        { name: '📈 Depuis le démarrage', value: `Commandes exécutées : **${client.stats.commandsRun}** · Erreurs : **${client.stats.errors}**` },
      );
    await interaction.reply({ embeds: [embed] });
  },
};
