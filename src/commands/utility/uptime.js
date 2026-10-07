'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { formatDuration, discordTimestamp } = require('../../utils/time');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder().setName('uptime').setDescription('Depuis combien de temps le bot est en ligne.'),
  async execute(interaction, client) {
    const embed = embeds
      .neutral('⏱️ Disponibilité')
      .addFields(
        { name: 'En ligne depuis', value: `**${formatDuration(client.uptime)}**`, inline: true },
        { name: 'Démarré', value: discordTimestamp(client.startedAt, 'f'), inline: true },
        { name: 'Commandes exécutées', value: `${client.stats.commandsRun}`, inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};
