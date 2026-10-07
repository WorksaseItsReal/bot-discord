'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, ICONS, userLine, code, actionButton, buttonRows } = require('../../utils/ui');
const { needPermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/** Vérifie que `actor` peut renommer `target` (propriétaire, hiérarchie, rôle du bot). */
function assertCanRename(guild, actor, target) {
  if (target.id === guild.ownerId) throw new UserError('Impossible de modifier le pseudo du propriétaire du serveur.');
  if (target.id !== actor.id && actor.id !== guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
    throw new UserError('Ce membre a un rôle supérieur ou égal au vôtre.');
  }
  if (!target.manageable) throw new UserError('Mon rôle est trop bas pour modifier le pseudo de ce membre.');
}

/**
 * Bouton « Annuler » : restaure l'ancien pseudo, encodé dans le customId.
 * Omis si l'ancien pseudo ne tient pas dans la limite de 100 caractères.
 */
function undoButton(targetId, previous) {
  const encoded = encodeURIComponent(previous ?? '');
  if (`cmd:pseudo:undo:${targetId}:${encoded}`.length > 100) return null;
  return actionButton({ command: 'pseudo', action: 'undo', args: [targetId, encoded], label: 'Annuler', emoji: '↩️' });
}

function render(target, moderator, before, after, { restored = false } = {}) {
  const title = restored ? 'Pseudo restauré' : after ? 'Pseudo modifié' : 'Pseudo réinitialisé';
  return {
    embeds: [
      card({
        tone: restored ? 'success' : 'info',
        section: 'moderation',
        icon: '✏️',
        title,
        description: after ? `${target} s'appelle désormais **${after}**.` : `${target} utilise de nouveau son nom d'utilisateur.`,
        thumbnail: target.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(target.user ?? target)),
          field('⬅️', 'Avant', before ? code(before) : '*aucun*'),
          field('➡️', 'Après', after ? code(after) : '*aucun*'),
        ],
        footer: `Par ${moderator.username ?? moderator.tag}`,
      }),
    ],
    components: restored ? [] : buttonRows(undoButton(target.id, before)),
  };
}

module.exports = {
  category: 'moderation',
  undoButton,
  botPermissions: [PermissionFlagsBits.ManageNicknames],
  data: new SlashCommandBuilder()
    .setName('pseudo')
    .setDescription('Change ou réinitialise le pseudo d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption((o) => o.setName('pseudo').setDescription('Nouveau pseudo (vide = réinitialiser)').setMaxLength(32)),
  async execute(interaction) {
    const user = interaction.options.getUser('membre');
    const nickname = interaction.options.getString('pseudo')?.trim() || null;
    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError('Ce membre n\'est pas sur le serveur.');
    assertCanRename(interaction.guild, interaction.member, target);
    const before = target.nickname;
    await target.setNickname(nickname, `Pseudo modifié par ${interaction.user.tag}`);
    await interaction.reply({ ...render(target, interaction.user, before, nickname), ephemeral: true });
  },

  buttons: {
    /** cmd:pseudo:undo:<targetId>:<ancien pseudo encodé> — permission et hiérarchie revérifiées. */
    async undo(interaction, client, [targetId, encoded = '']) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)) throw needPermission('ManageNicknames');
      const target = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!target) throw new UserError('Ce membre n\'est plus sur le serveur.');
      assertCanRename(interaction.guild, interaction.member, target);
      let previous;
      try {
        previous = decodeURIComponent(encoded) || null;
      } catch {
        throw new UserError('Impossible de retrouver l\'ancien pseudo.');
      }
      const current = target.nickname;
      await target.setNickname(previous, `Pseudo restauré par ${interaction.user.tag}`);
      await interaction.update(render(target, interaction.user, current, previous, { restored: true }));
    },
  },
};
