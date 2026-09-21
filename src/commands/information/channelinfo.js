'use strict';

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');

const TYPE_NAMES = {
  [ChannelType.GuildText]: 'Textuel',
  [ChannelType.GuildVoice]: 'Vocal',
  [ChannelType.GuildCategory]: 'Catégorie',
  [ChannelType.GuildAnnouncement]: 'Annonces',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.GuildStageVoice]: 'Conférence',
};

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Affiche les informations d\'un salon.')
    .setDMPermission(false)
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon à inspecter (par défaut: actuel)')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    const embed = embeds.neutral(`# ${channel.name}`)
      .addFields(
        { name: 'ID', value: channel.id, inline: true },
        { name: 'Type', value: TYPE_NAMES[channel.type] || `${channel.type}`, inline: true },
        { name: 'Catégorie', value: channel.parent?.name || '—', inline: true },
        { name: 'Créé le', value: discordTimestamp(channel.createdTimestamp, 'D'), inline: true },
      );
    if (channel.topic) embed.addFields({ name: 'Sujet', value: channel.topic.slice(0, 1024) });
    await interaction.reply({ embeds: [embed] });
  },
};
