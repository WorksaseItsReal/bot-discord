'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { ICONS, actionButton, buttonRows } = require('../../utils/ui');
const { sanctionCard } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulse un membre du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à expulser').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison de l\'expulsion').setMaxLength(512)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    const cfg = client.services.config.get(interaction.guild.id);
    if (cfg.moderation.confirmDangerous) {
      const ok = await confirm(interaction, { description: `Expulser ${user} du serveur ?`, confirmLabel: 'Expulser' });
      if (!ok) return;
    } else {
      // DM + action + log : peut dépasser 3 s.
      await interaction.deferReply();
    }

    const { id } = await client.services.moderation.kick(interaction.guild, member, interaction.member, reason);
    const payload = {
      embeds: [sanctionCard({ id, type: 'kick', user, moderator: interaction.user, reason })],
      components: buttonRows(actionButton({ command: 'sanctions', action: 'history', args: [user.id], label: 'Sanctions', emoji: ICONS.history })),
    };
    // Après confirmation, la carte remplace la demande de confirmation (éphémère).
    await interaction.editReply(payload);
  },
};
