'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');

module.exports = {
  category: 'suggestions',
  data: new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Système de suggestions.')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Définit le salon des suggestions.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Propose une suggestion.')
        .addStringOption((o) => o.setName('contenu').setDescription('Votre suggestion').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('approve').setDescription('Approuve une suggestion.').addIntegerOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('deny').setDescription('Refuse une suggestion.').addIntegerOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les dernières suggestions.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { suggestions, config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'setup') {
      requireManage(interaction);
      const channel = interaction.options.getChannel('salon');
      config.update(guildId, { suggestions: { channelId: channel.id } });
      return interaction.reply(successReply(`Salon de suggestions : ${channel}.`, { ephemeral: true }));
    }
    if (sub === 'create') {
      const content = interaction.options.getString('contenu');
      const id = await suggestions.create(interaction.guild, interaction.user, content);
      return interaction.reply(successReply(`Suggestion **#${id}** publiée.`, { ephemeral: true }));
    }
    if (sub === 'approve' || sub === 'deny') {
      requireManage(interaction);
      const id = interaction.options.getInteger('id');
      await suggestions.setStatus(interaction.guild, id, sub === 'approve' ? 'approved' : 'denied');
      return interaction.reply(successReply(`Suggestion #${id} ${sub === 'approve' ? 'approuvée' : 'refusée'}.`, { ephemeral: true }));
    }
    if (sub === 'list') {
      const list = client.repositories.suggestions.list(guildId, 15);
      if (!list.length) return interaction.reply({ embeds: [embeds.info('Aucune suggestion.')], ephemeral: true });
      const embed = embeds.neutral('💡 Suggestions').setDescription(
        list.map((s) => `**#${s.id}** [${s.status}] — ${s.content.slice(0, 80)}`).join('\n'),
      );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};

function requireManage(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    const { UserError } = require('../../core/errors');
    throw new UserError('Vous n\'avez pas la permission requise.');
  }
}
