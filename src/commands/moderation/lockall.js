'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('lockall')
    .setDescription('Verrouille tous les salons textuels du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction, client) {
    await interaction.deferReply();
    const n = await client.services.lockdown.enable(interaction.guild, interaction.member, `Lockall par ${interaction.user.tag}`);
    await interaction.editReply({ embeds: [embeds.success(`🔒 ${n} salon(s) verrouillé(s).`)] });
  },
};
