'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buttonRows } = require('../../utils/ui');
const { sanctionCard, historyButton, revokeHandler } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

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
    revoke: revokeHandler({
      permission: 'ModerateMembers',
      type: 'unmute',
      done: 'Démuté',
      async run(interaction, client, userId) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
        // unmute() applique assertCanModerate (hiérarchie du cliqueur et du bot) et vérifie le rôle Muted.
        await client.services.moderation.unmute(interaction.guild, member, interaction.member, `Démute via le bouton par ${interaction.user.tag}`);
        return member.user;
      },
    }),
  },
};
