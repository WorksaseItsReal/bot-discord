'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { successReply } = require('../../utils/embeds');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('hide')
    .setDescription('Cache un salon à @everyone.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)')),

  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }, { reason: `Hide par ${interaction.user.tag}` });
    await interaction.reply(successReply(`🙈 ${channel} est maintenant caché.`));
  },
};
