'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Affiche l\'avatar d\'un utilisateur en grand.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur (par défaut vous-même).')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const user = interaction.options.getUser('cible') || interaction.user;
    const url = user.displayAvatarURL({ size: 1024 });
    await interaction.reply({ embeds: [embeds.neutral(`🖼️ Avatar de ${user.username}`).setImage(url).setURL(url)] });
  },
};
