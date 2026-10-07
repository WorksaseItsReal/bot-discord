'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { assertOverwritable } = require('../../services/LockdownService');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('hide')
    .setDescription('Cache un salon à @everyone.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
        ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory,
      )),

  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    assertOverwritable(channel);
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }, { reason: `Hide par ${interaction.user.tag}` });
    await interaction.reply(successReply(`🙈 ${channel} est maintenant caché.`));
  },
};
