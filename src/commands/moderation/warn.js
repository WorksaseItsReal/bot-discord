'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { parseDuration } = require('../../utils/time');
const { field, wide, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { sanctionCard } = require('../../services/ModerationService');
const { describeThreshold } = require('../../services/StrikeService');
const { UserError } = require('../../core/errors');

/** Ton de la carte selon l'escalade réellement appliquée. */
const ESCALATION_TONES = { timeout: 'caution', kick: 'caution', ban: 'danger' };

/**
 * Avertit un membre, incrémente ses strikes et applique automatiquement
 * l'escalade configurée (mute/timeout, kick, ban) si un palier est atteint.
 */
module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Avertit un membre et met à jour ses strikes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à avertir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison de l\'avertissement').setMaxLength(512)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    // Avertissement + escalade éventuelle (timeout/kick/ban, DM, logs) : peut dépasser 3 s.
    await interaction.deferReply();
    const { moderation, strikes } = client.services;
    const { id } = await moderation.warn(interaction.guild, member, interaction.member, reason);
    const { count, action } = strikes.add(interaction.guild.id, user.id, 1);

    let escalation = null;
    if (action && count === action.strikes) {
      escalation = await applyEscalation(client, interaction, member, action, count);
    }
    const next = strikes.nextThreshold?.(interaction.guild.id, count);

    await interaction.editReply({
      embeds: [
        sanctionCard({
          id,
          type: 'warn',
          user,
          moderator: interaction.user,
          reason,
          tone: escalation?.ok ? ESCALATION_TONES[escalation.type] : undefined,
          fields: [
            field(ICONS.warn, 'Strikes', `**${count}**`),
            next ? field(ICONS.stats, 'Prochain palier', describeThreshold(next)) : null,
            escalation ? wide('⚡', 'Escalade automatique', truncate(escalation.text, 1024)) : null,
          ],
        }),
      ],
      components: buttonRows(
        escalation?.ok && escalation.type === 'timeout'
          ? actionButton({ command: 'untimeout', action: 'revoke', args: [user.id], label: 'Retirer le timeout', emoji: ICONS.unmute, style: ButtonStyle.Success })
          : null,
        escalation?.ok && escalation.type === 'ban'
          ? actionButton({ command: 'unban', action: 'revoke', args: [user.id], label: 'Débannir', emoji: ICONS.unlock, style: ButtonStyle.Success })
          : null,
        actionButton({ command: 'sanctions', action: 'history', args: [user.id], label: 'Sanctions', emoji: ICONS.history }),
      ),
    });
  },
};

/** @returns {Promise<{ ok: boolean, type: 'timeout'|'kick'|'ban'|null, text: string }|null>} */
async function applyEscalation(client, interaction, member, action, count) {
  const { moderation } = client.services;
  const reason = `Escalade automatique (${count} strikes)`;
  try {
    if (action.action === 'mute' || action.action === 'timeout') {
      const ms = parseDuration(action.duration || '1h') || 3_600_000;
      await moderation.timeout(interaction.guild, member, interaction.guild.members.me, reason, ms);
      return { ok: true, type: 'timeout', text: `${ICONS.mute} Timeout de **${action.duration || '1h'}** appliqué (palier de ${count} strikes).` };
    }
    if (action.action === 'kick') {
      await moderation.kick(interaction.guild, member, interaction.guild.members.me, reason);
      return { ok: true, type: 'kick', text: `${ICONS.kick} Membre **expulsé** (palier de ${count} strikes).` };
    }
    if (action.action === 'ban') {
      await moderation.ban(interaction.guild, member.user, interaction.guild.members.me, reason, { targetMember: member });
      return { ok: true, type: 'ban', text: `${ICONS.ban} Membre **banni** (palier de ${count} strikes).` };
    }
  } catch (err) {
    return { ok: false, type: null, text: `${ICONS.error} Échec de l'escalade : ${err.message}` };
  }
  return null;
}
