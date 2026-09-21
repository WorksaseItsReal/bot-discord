'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unhide')
    .setDescription('Rend un salon visible à @everyone.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)')),

  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: null }, { reason: `Unhide par ${interaction.user.tag}` });
    await interaction.reply(successReply(`👀 ${channel} est de nouveau visible.`));
  },
};
