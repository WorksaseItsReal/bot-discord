'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { parseDuration, formatDuration } = require('../../utils/time');
const { field, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { sanctionCard } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannit un membre (définitivement ou temporairement).')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à bannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du bannissement').setMaxLength(512))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 7d, 12h). Vide = permanent'))
    .addIntegerOption((o) =>
      o.setName('purge_jours').setDescription('Supprimer les messages des X derniers jours (0-7)').setMinValue(0).setMaxValue(7),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const durationStr = interaction.options.getString('duree');
    const purgeDays = interaction.options.getInteger('purge_jours') ?? 0;

    const durationMs = durationStr ? parseDuration(durationStr) : null;
    if (durationStr && !durationMs) throw new UserError('Durée invalide. Exemples valides : `7d`, `12h`, `1h30m`.');

    const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
    const cfg = client.services.config.get(interaction.guild.id);

    if (cfg.moderation.confirmDangerous) {
      const ok = await confirm(interaction, {
        description: `Bannir ${user} ${durationMs ? `pour **${formatDuration(durationMs)}**` : '**définitivement**'} ?`,
        confirmLabel: 'Bannir',
      });
      if (!ok) return;
    } else {
      // DM + action + log : peut dépasser 3 s.
      await interaction.deferReply();
    }

    const { id, expiresAt } = await client.services.moderation.ban(interaction.guild, user, interaction.member, reason, {
      durationMs,
      deleteMessageSeconds: purgeDays * 86400,
      targetMember,
    });

    const payload = {
      embeds: [
        sanctionCard({
          id,
          type: durationMs ? 'tempban' : 'ban',
          user,
          moderator: interaction.user,
          reason,
          durationMs,
          expiresAt,
          fields: [purgeDays ? field(ICONS.delete, 'Messages purgés', `${purgeDays} dernier${purgeDays > 1 ? 's' : ''} jour${purgeDays > 1 ? 's' : ''}`) : null],
        }),
      ],
      components: buttonRows(
        actionButton({ command: 'unban', action: 'revoke', args: [user.id], label: 'Débannir', emoji: ICONS.unlock, style: ButtonStyle.Success }),
        actionButton({ command: 'sanctions', action: 'history', args: [user.id], label: 'Sanctions', emoji: ICONS.history }),
      ),
    };
    // Après confirmation, la carte remplace la demande de confirmation (éphémère).
    await interaction.editReply(payload);
  },
};
