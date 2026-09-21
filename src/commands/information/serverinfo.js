'use strict';

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Affiche les informations détaillées du serveur.')
    .setDMPermission(false),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const { guild } = interaction;
    await guild.members.fetch().catch(() => {});
    const channels = guild.channels.cache;
    const text = channels.filter((c) => c.type === ChannelType.GuildText).size;
    const voice = channels.filter((c) => c.type === ChannelType.GuildVoice).size;
    const owner = await guild.fetchOwner().catch(() => null);

    const embed = embeds.neutral(`📊 ${guild.name}`)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: guild.id, inline: true },
        { name: 'Propriétaire', value: owner ? `${owner.user.tag}` : 'Inconnu', inline: true },
        { name: 'Créé le', value: discordTimestamp(guild.createdTimestamp, 'D'), inline: true },
        { name: 'Membres', value: `${guild.memberCount}`, inline: true },
        { name: 'Salons', value: `💬 ${text} · 🔊 ${voice}`, inline: true },
        { name: 'Rôles', value: `${guild.roles.cache.size}`, inline: true },
        { name: 'Emojis', value: `${guild.emojis.cache.size}`, inline: true },
        { name: 'Boosts', value: `${guild.premiumSubscriptionCount ?? 0} (niveau ${guild.premiumTier})`, inline: true },
      );
    if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));
    await interaction.reply({ embeds: [embed] });
  },
};
