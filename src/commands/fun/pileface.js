'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('pileface')
    .setDescription('Lance une pièce : pile ou face ?')
    .addStringOption((o) => o.setName('pari').setDescription('Votre pari').addChoices({ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' })),
  async execute(interaction) {
    const result = Math.random() < 0.5 ? 'pile' : 'face';
    const bet = interaction.options.getString('pari');
    const embed = embeds.fun('🪙 Pile ou face').setDescription(`La pièce tourne… et tombe sur **${result.toUpperCase()}** !`);
    if (bet) embed.addFields({ name: 'Votre pari', value: bet === result ? `✅ **${bet}** — gagné !` : `❌ **${bet}** — perdu…` });
    await interaction.reply({ embeds: [embed] });
  },
};
