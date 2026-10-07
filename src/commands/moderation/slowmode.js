'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { parseDuration, formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

const MAX_SECONDS = 21_600; // limite Discord : 6 heures

module.exports = {
  category: 'moderation',
  botPermissions: [PermissionFlagsBits.ManageChannels],
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Définit le mode lent d\'un salon.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('duree').setDescription('Délai entre deux messages (ex : 10s, 5m, 1h) ou « 0 » pour désactiver').setRequired(true).setMaxLength(20))
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon (par défaut le salon actuel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildForum),
    ),
  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    const input = interaction.options.getString('duree').trim();
    const off = ['0', 'off', 'non', 'aucun'].includes(input.toLowerCase());
    const ms = off ? 0 : parseDuration(/^\d+$/.test(input) ? `${input}s` : input);
    if (!off && !ms) throw new UserError('Durée invalide. Exemples : `10s`, `5m`, `1h`, ou `0` pour désactiver.');
    const seconds = Math.round(ms / 1000);
    if (seconds > MAX_SECONDS) throw new UserError('Discord limite le mode lent à 6 heures.');
    if (typeof channel?.setRateLimitPerUser !== 'function') throw new UserError('Ce salon ne supporte pas le mode lent.');
    await channel.setRateLimitPerUser(seconds, `Slowmode par ${interaction.user.tag}`);
    await interaction.reply({
      embeds: [seconds ? embeds.success(`Mode lent de ${channel} réglé sur **${formatDuration(seconds * 1000)}**.`, '🐢 Mode lent') : embeds.success(`Mode lent désactivé dans ${channel}.`, '🐢 Mode lent')],
    });
  },
};
