'use strict';

const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits } = require('discord.js');
const { requirePermission } = require('../../services/ModerationService');

/**
 * Menu contextuel UTILISATEUR « Note de modération » (modérateurs) : formulaire de note
 * interne, enregistrée par cmd:sanctions:noteusersubmit (ModNoteRepository).
 */
module.exports = {
  category: 'moderation',
  description: 'Ajoute une note interne sur un membre (sans effet pour lui), comme /sanctions note.',
  data: new ContextMenuCommandBuilder()
    .setName('Note de modération')
    .setType(ApplicationCommandType.User)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  /** @param {import('discord.js').UserContextMenuCommandInteraction} interaction */
  async execute(interaction) {
    requirePermission(interaction, 'ModerateMembers');
    const { noteModal } = require('./sanctions');
    const name = interaction.targetMember?.displayName ?? interaction.targetUser.username;
    await interaction.showModal(noteModal(`cmd:sanctions:noteusersubmit:${interaction.targetId}`, `Note · ${name}`));
  },
};
