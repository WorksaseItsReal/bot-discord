'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { parseDuration } = require('../../utils/time');
const { field, wide, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { permissionLabel } = require('../../utils/permissionNames');
const { sanctionCard, historyButton, assertReason } = require('../../services/ModerationService');
const { describeThreshold, escalationReason, ACTION_LABELS, ACTION_PERMISSIONS } = require('../../services/StrikeService');
const { UserError } = require('../../core/errors');

/** Ton de la carte selon l'escalade réellement appliquée. */
const ESCALATION_TONES = { timeout: 'caution', kick: 'caution', ban: 'danger' };

/**
 * Avertit un membre, incrémente ses strikes et applique automatiquement
 * l'escalade configurée (mute/timeout, kick, ban) si un palier est atteint.
 *
 * Règle d'escalade (voir StrikeService.pendingEscalation) : le plus haut palier
 * atteint est appliqué s'il n'a pas déjà été appliqué à ce membre (d'après son
 * historique de sanctions, colonne escalation_step). L'escalade n'est appliquée que si l'INVOCATEUR a la
 * permission correspondante (Expulser / Bannir / Exclure temporairement) : sinon,
 * la carte indique que le palier est atteint et la permission requise, et le
 * palier sera appliqué au prochain warn d'un modérateur qui l'a.
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
    assertReason(client.services.config.get(interaction.guild.id), reason);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    // Avertissement + escalade éventuelle (timeout/kick/ban, DM, logs) : peut dépasser 3 s.
    await interaction.deferReply();
    const { moderation, strikes } = client.services;
    const guildId = interaction.guild.id;
    const { id } = await moderation.warn(interaction.guild, member, interaction.member, reason);
    const { count } = strikes.add(guildId, user.id, 1);

    const step = strikes.pendingEscalation(guildId, count, moderation.appliedEscalationLevel(guildId, user.id));
    const escalation = step ? await applyEscalation(client, interaction, member, step) : null;
    const next = strikes.nextThreshold(guildId, count);

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
        historyButton(user.id),
      ),
    });
  },
};

/**
 * Applique le palier `step` au nom de l'invocateur (sanction enregistrée avec lui
 * comme modérateur), après avoir vérifié qu'il en a la permission.
 * @returns {Promise<{ ok: boolean, type: 'timeout'|'kick'|'ban'|null, text: string }|null>}
 */
async function applyEscalation(client, interaction, member, step) {
  const { moderation } = client.services;
  const permission = ACTION_PERMISSIONS[step.action];
  if (!permission) return null;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits[permission])) {
    const label = ACTION_LABELS[step.action] ?? step.action;
    return {
      ok: false,
      type: null,
      text: `${ICONS.warning} Palier de **${step.strikes} strikes** atteint (${label}), mais il faut la permission **${permissionLabel(permission)}** pour l'appliquer. Il sera appliqué au prochain avertissement donné par un modérateur qui l'a.`,
    };
  }
  const reason = escalationReason(step);
  const moderator = interaction.member;
  try {
    if (step.action === 'mute' || step.action === 'timeout') {
      const ms = parseDuration(step.duration || '1h') || 3_600_000;
      await moderation.timeout(interaction.guild, member, moderator, reason, ms, { escalationStep: step.strikes });
      return { ok: true, type: 'timeout', text: `${ICONS.mute} Timeout de **${step.duration || '1h'}** appliqué (palier de ${step.strikes} strikes).` };
    }
    if (step.action === 'kick') {
      await moderation.kick(interaction.guild, member, moderator, reason, { escalationStep: step.strikes });
      return { ok: true, type: 'kick', text: `${ICONS.kick} Membre **expulsé** (palier de ${step.strikes} strikes).` };
    }
    if (step.action === 'ban') {
      await moderation.ban(interaction.guild, member.user, moderator, reason, { targetMember: member, escalationStep: step.strikes });
      return { ok: true, type: 'ban', text: `${ICONS.ban} Membre **banni** (palier de ${step.strikes} strikes).` };
    }
  } catch (err) {
    return { ok: false, type: null, text: `${ICONS.error} Échec de l'escalade : ${err.message}` };
  }
  return null;
}

module.exports.applyEscalation = applyEscalation;
