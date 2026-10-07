'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { parseDuration } = require('../../utils/time');
const { ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { sanctionCard } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Applique un timeout (mute Discord) à un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à timeout').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 10m, 1h, 1d — max 28d)').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du timeout').setMaxLength(512)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const durationMs = parseDuration(interaction.options.getString('duree'));
    if (!durationMs) throw new UserError('Durée invalide. Exemples : `10m`, `1h`, `1d`.');

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    await interaction.deferReply();
    const { id, expiresAt } = await client.services.moderation.timeout(interaction.guild, member, interaction.member, reason, durationMs);
    await interaction.editReply({
      embeds: [sanctionCard({ id, type: 'timeout', user, moderator: interaction.user, reason, durationMs, expiresAt })],
      components: buttonRows(
        actionButton({ command: 'untimeout', action: 'revoke', args: [user.id], label: 'Retirer le timeout', emoji: ICONS.unmute, style: ButtonStyle.Success }),
        actionButton({ command: 'sanctions', action: 'history', args: [user.id], label: 'Sanctions', emoji: ICONS.history }),
      ),
    });
  },
};
