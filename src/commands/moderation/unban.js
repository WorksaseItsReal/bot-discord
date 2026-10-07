'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ICONS, actionButton, buttonRows } = require('../../utils/ui');
const { sanctionCard, needPermission, settleAndAnnounce } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

function historyButton(userId) {
  return actionButton({ command: 'sanctions', action: 'history', args: [userId], label: 'Sanctions', emoji: ICONS.history });
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannit un utilisateur via son ID.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('ID de l\'utilisateur à débannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(512)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const userId = interaction.options.getString('user_id').trim();
    if (!/^\d{17,20}$/.test(userId)) throw new UserError('ID utilisateur invalide : il doit contenir 17 à 20 chiffres.');
    const reason = interaction.options.getString('raison');
    const { user } = await client.services.moderation.unban(interaction.guild, userId, interaction.member, reason);
    await interaction.reply({
      embeds: [sanctionCard({ type: 'unban', user, userId, moderator: interaction.user, reason })],
      components: buttonRows(historyButton(userId)),
    });
  },

  buttons: {
    /**
     * cmd:unban:revoke:<userId> — bouton « Débannir » des cartes de bannissement.
     * Revérifie la permission du cliqueur et que l'utilisateur est toujours banni.
     */
    async revoke(interaction, client, [userId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) throw needPermission('BanMembers');
      if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
        throw new UserError('Il me manque la permission **Bannir des membres** pour débannir.');
      }
      // ModerationService.unban vérifie que l'utilisateur est toujours banni.
      const reason = `Débanni via le bouton par ${interaction.user.tag}`;
      const { user } = await client.services.moderation.unban(interaction.guild, userId, interaction.member, reason);
      await settleAndAnnounce(interaction, {
        label: `Débanni par ${interaction.user.username}`,
        embed: sanctionCard({ type: 'unban', user, userId, moderator: interaction.user }),
        buttons: [historyButton(userId)],
      });
    },
  },
};
