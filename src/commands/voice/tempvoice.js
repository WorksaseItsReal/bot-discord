'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { successReply, embeds } = require('../../utils/embeds');

module.exports = {
  category: 'voice',
  data: new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Configure les salons vocaux temporaires (join-to-create).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Active le système avec un salon hub.')
        .addChannelOption((o) => o.setName('hub').setDescription('Salon vocal "Créer un vocal"').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie où créer les vocaux').addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive les vocaux temporaires.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du système.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'setup') {
      const hub = interaction.options.getChannel('hub');
      const category = interaction.options.getChannel('categorie');
      config.update(guildId, { tempVoice: { enabled: true, hubChannelId: hub.id, categoryId: category?.id ?? null } });
      return interaction.reply(successReply(`Vocaux temporaires activés. Hub : ${hub}.`, { ephemeral: true }));
    }
    if (sub === 'disable') {
      config.update(guildId, { tempVoice: { enabled: false } });
      return interaction.reply(successReply('Vocaux temporaires désactivés.', { ephemeral: true }));
    }
    const cfg = config.get(guildId).tempVoice;
    return interaction.reply({
      embeds: [embeds.neutral('🔊 Vocaux temporaires').addFields(
        { name: 'Activé', value: cfg.enabled ? 'Oui' : 'Non', inline: true },
        { name: 'Hub', value: cfg.hubChannelId ? `<#${cfg.hubChannelId}>` : '—', inline: true },
      )],
      ephemeral: true,
    });
  },
};
