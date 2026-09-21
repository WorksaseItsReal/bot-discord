'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unlockall')
    .setDescription('Déverrouille tous les salons textuels du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction, client) {
    await interaction.deferReply();
    const n = await client.services.lockdown.disable(interaction.guild, interaction.member);
    await interaction.editReply({ embeds: [embeds.success(`🔓 ${n} salon(s) déverrouillé(s).`)] });
  },
};
