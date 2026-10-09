'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { field, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { sanctionCard, historyButton, assertReason, resolveTargetMember } = require('../../services/ModerationService');

const DAY_S = 86_400;

/**
 * /softban : bannit puis débannit aussitôt, pour supprimer les messages récents d'un
 * membre (spam, raid) sans l'exclure définitivement. Enregistré comme sanction
 * `softban` (historique, fiches, /modstats) ; mêmes garde-fous que /ban (hiérarchie,
 * confirmation si `moderation.confirmDangerous`, raison obligatoire si configurée).
 */
module.exports = {
  category: 'moderation',
  botPermissions: [PermissionFlagsBits.BanMembers],
  data: new SlashCommandBuilder()
    .setName('softban')
    .setDescription('Expulse un membre en supprimant ses messages récents (ban + débannissement immédiat).')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à softbannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du softban').setMaxLength(512))
    .addIntegerOption((o) =>
      o.setName('jours_messages').setDescription('Messages supprimés : jours en arrière (1 à 7, 1 par défaut)').setMinValue(1).setMaxValue(7),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const days = Math.min(7, Math.max(1, interaction.options.getInteger('jours_messages') ?? 1));
    const cfg = client.services.config.get(interaction.guild.id);
    assertReason(cfg, reason);
    // Données résolues de l'interaction : un fetch en échec ne peut pas faire sauter la hiérarchie.
    const targetMember = resolveTargetMember(interaction, 'membre');

    if (cfg.moderation.confirmDangerous) {
      const ok = await confirm(interaction, {
        description: `Softbannir ${user} ? Ses messages des **${days}** dernier${days > 1 ? 's' : ''} jour${days > 1 ? 's' : ''} seront supprimés ; il pourra revenir avec une invitation.`,
        confirmLabel: 'Softbannir',
      });
      if (!ok) return;
    } else {
      // DM + ban + débannissement + log : peut dépasser 3 s.
      await interaction.deferReply();
    }

    const { id, unbanned } = await client.services.moderation.softban(interaction.guild, user, interaction.member, reason, {
      deleteMessageSeconds: days * DAY_S,
      targetMember,
    });

    const payload = {
      embeds: [
        sanctionCard({
          id,
          type: 'softban',
          user,
          moderator: interaction.user,
          reason,
          tone: unbanned ? undefined : 'danger',
          fields: [
            field(ICONS.delete, 'Messages purgés', `${days} dernier${days > 1 ? 's' : ''} jour${days > 1 ? 's' : ''}`),
            field(ICONS.unlock, 'Débannissement', unbanned ? '✅ Immédiat' : `${ICONS.warning} **Échec** : il reste banni`),
          ],
        }),
      ],
      components: buttonRows(
        unbanned ? null : actionButton({ command: 'unban', action: 'revoke', args: [user.id], label: 'Débannir', emoji: ICONS.unlock, style: ButtonStyle.Success }),
        historyButton(user.id),
      ),
    };
    // Après confirmation, la carte remplace la demande de confirmation (éphémère).
    await interaction.editReply(payload);
  },
};
