'use strict';

const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits } = require('discord.js');
const { requirePermission } = require('../../services/ModerationService');

/** Menu contextuel UTILISATEUR « Sanctions du membre » (modérateurs) : la fiche historique de /sanctions. */
module.exports = {
  category: 'moderation',
  description: 'Ouvre l\'historique de modération d\'un membre (comme /sanctions historique).',
  data: new ContextMenuCommandBuilder()
    .setName('Sanctions du membre')
    .setType(ApplicationCommandType.User)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  /** @param {import('discord.js').UserContextMenuCommandInteraction} interaction */
  async execute(interaction, client) {
    requirePermission(interaction, 'ModerateMembers');
    const { render } = require('./sanctions');
    await interaction.reply({ ...render(client, interaction.guild, `hist:${interaction.targetId}:0:all`), ephemeral: true });
  },
};
