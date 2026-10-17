'use strict';

const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits } = require('discord.js');
const { requirePermission } = require('../../services/ModerationService');
const { userCard } = require('../information/userinfo');

/** Menu contextuel UTILISATEUR « Infos du membre » (modérateurs) : la fiche de /user, en éphémère. */
module.exports = {
  category: 'moderation',
  description: 'Affiche la fiche d\'un membre (comme /user), visible de vous seul.',
  data: new ContextMenuCommandBuilder()
    .setName('Infos du membre')
    .setType(ApplicationCommandType.User)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  /** @param {import('discord.js').UserContextMenuCommandInteraction} interaction */
  async execute(interaction) {
    requirePermission(interaction, 'ModerateMembers');
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(await userCard(interaction, interaction.targetUser));
  },
};
