'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder().setName('ping').setDescription('Affiche la latence du bot et de l\'API Discord.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const sent = await interaction.reply({ embeds: [embeds.info('Mesure en cours...')], fetchReply: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const ws = Math.round(client.ws.ping);
    await interaction.editReply({
      embeds: [
        embeds.info(`🏓 **Pong !**\n> Aller-retour : \`${roundtrip}ms\`\n> WebSocket : \`${ws < 0 ? 'N/A' : `${ws}ms`}\``),
      ],
    });
  },
};
