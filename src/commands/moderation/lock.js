'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { successReply } = require('../../utils/embeds');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Verrouille un salon (empêche @everyone d\'écrire).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(ChannelType.GuildText)),

  async execute(interaction, client) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await client.services.lockdown.lockChannel(channel, interaction.member, `Lock par ${interaction.user.tag}`);
    await interaction.reply(successReply(`🔒 ${channel} verrouillé.`));
  },
};
