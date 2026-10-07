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
    .setName('unmute')
    .setDescription('Retire le mute d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),

  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');
    await client.services.moderation.unmute(interaction.guild, member, interaction.member);
    await interaction.reply({
      embeds: [sanctionCard({ type: 'unmute', user, moderator: interaction.user })],
      components: buttonRows(historyButton(user.id)),
    });
  },

  buttons: {
    /** cmd:unmute:revoke:<userId> — bouton « Démuter » des cartes de mute (permission + hiérarchie revérifiées). */
    async revoke(interaction, client, [userId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) throw needPermission('ModerateMembers');
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
      // unmute() applique assertCanModerate (hiérarchie du cliqueur et du bot) et vérifie le rôle Muted.
      await client.services.moderation.unmute(interaction.guild, member, interaction.member, `Démute via le bouton par ${interaction.user.tag}`);
      await settleAndAnnounce(interaction, {
        label: `Démuté par ${interaction.user.username}`,
        embed: sanctionCard({ type: 'unmute', user: member.user, moderator: interaction.user }),
        buttons: [historyButton(userId)],
      });
    },
  },
};
