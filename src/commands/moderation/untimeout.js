'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buttonRows } = require('../../utils/ui');
const { sanctionCard, historyButton, revokeHandler } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

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

    // Retrait du timeout + levée en base + log : acquittement immédiat.
    await interaction.deferReply();
    await client.services.moderation.removeTimeout(interaction.guild, member, interaction.member);
    await interaction.editReply({
      embeds: [sanctionCard({ type: 'untimeout', user, moderator: interaction.user })],
      components: buttonRows(historyButton(user.id)),
    });
  },

  buttons: {
    /** cmd:untimeout:revoke:<userId> — bouton « Retirer le timeout » (permission + hiérarchie revérifiées). */
    revoke: revokeHandler({
      permission: 'ModerateMembers',
      type: 'untimeout',
      done: 'Retiré',
      async run(interaction, client, userId) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
        if (!member.isCommunicationDisabled()) throw new UserError('Ce membre n\'est plus en timeout.');
        // removeTimeout() applique assertCanModerate (hiérarchie du cliqueur et du bot).
        await client.services.moderation.removeTimeout(interaction.guild, member, interaction.member, `Timeout retiré via le bouton par ${interaction.user.tag}`);
        return member.user;
      },
    }),
  },
};
