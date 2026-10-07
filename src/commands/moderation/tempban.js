'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { parseDuration, formatDuration } = require('../../utils/time');
const { ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { sanctionCard, historyButton, assertReason, resolveTargetMember } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('tempban')
    .setDescription('Bannit temporairement un membre (débannissement automatique).')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 7d, 12h)').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(512)),

  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const durationMs = parseDuration(interaction.options.getString('duree'));
    if (!durationMs) throw new UserError('Durée invalide. Exemples : `7d`, `12h`.');
    const reason = interaction.options.getString('raison');
    const cfg = client.services.config.get(interaction.guild.id);
    assertReason(cfg, reason);
    // Données résolues de l'interaction : un fetch en échec ne peut plus faire sauter la hiérarchie.
    const member = resolveTargetMember(interaction, 'membre');
    // Même règle que /ban : confirmation des actions dangereuses si configurée.
    if (cfg.moderation?.confirmDangerous) {
      const ok = await confirm(interaction, {
        description: `Bannir ${user} pour **${formatDuration(durationMs)}** ?`,
        confirmLabel: 'Bannir',
      });
      if (!ok) return;
    } else {
      // DM + action + log : peut dépasser 3 s.
      await interaction.deferReply();
    }
    const { id, expiresAt } = await client.services.moderation.ban(interaction.guild, user, interaction.member, reason, { durationMs, targetMember: member });
    await interaction.editReply({
      embeds: [sanctionCard({ id, type: 'tempban', user, moderator: interaction.user, reason, durationMs, expiresAt })],
      components: buttonRows(
        actionButton({ command: 'unban', action: 'revoke', args: [user.id], label: 'Débannir', emoji: ICONS.unlock, style: ButtonStyle.Success }),
        historyButton(user.id),
      ),
    });
  },
};
