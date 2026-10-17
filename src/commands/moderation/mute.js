'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { parseDuration } = require('../../utils/time');
const { ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { sanctionCard, historyButton, assertReason } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Rend muet un membre via le rôle Muted (permanent ou temporaire).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à mute').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 1h, 30m). Vide = permanent'))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du mute (visible dans l\'historique)').setMaxLength(512)),

  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const durationStr = interaction.options.getString('duree');
    const reason = interaction.options.getString('raison');
    const durationMs = durationStr ? parseDuration(durationStr) : null;
    if (durationStr && !durationMs) throw new UserError('Durée invalide. Exemples : `1h`, `30m`.');
    assertReason(client.services.config.get(interaction.guild.id), reason);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    await interaction.deferReply();
    const { id, expiresAt } = await client.services.moderation.mute(interaction.guild, member, interaction.member, reason, durationMs);
    await interaction.editReply({
      embeds: [sanctionCard({ id, type: 'mute', user, moderator: interaction.user, reason, durationMs, expiresAt })],
      components: buttonRows(
        actionButton({ command: 'unmute', action: 'revoke', args: [user.id], label: 'Démuter', emoji: ICONS.unmute, style: ButtonStyle.Success }),
        historyButton(user.id),
      ),
    });
  },
};
