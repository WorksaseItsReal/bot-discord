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
    .setName('untimeout')
    .setDescription('Retire le timeout d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre concerné').setRequired(true)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');
    if (!member.isCommunicationDisabled()) throw new UserError('Ce membre n\'est pas en timeout.');

    await client.services.moderation.removeTimeout(interaction.guild, member, interaction.member);
    await interaction.reply({
      embeds: [sanctionCard({ type: 'untimeout', user, moderator: interaction.user })],
      components: buttonRows(historyButton(user.id)),
    });
  },

  buttons: {
    /** cmd:untimeout:revoke:<userId> — bouton « Retirer le timeout » (permission + hiérarchie revérifiées). */
    async revoke(interaction, client, [userId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) throw needPermission('ModerateMembers');
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
      if (!member.isCommunicationDisabled()) throw new UserError('Ce membre n\'est plus en timeout.');
      // removeTimeout() applique assertCanModerate (hiérarchie du cliqueur et du bot).
      await client.services.moderation.removeTimeout(interaction.guild, member, interaction.member, `Timeout retiré via le bouton par ${interaction.user.tag}`);
      await settleAndAnnounce(interaction, {
        label: `Retiré par ${interaction.user.username}`,
        embed: sanctionCard({ type: 'untimeout', user: member.user, moderator: interaction.user }),
        buttons: [historyButton(userId)],
      });
    },
  },
};
