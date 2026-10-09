'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows } = require('../../utils/ui');
const { serverLockCard } = require('../../services/LockdownService');
const { assertAdmin, requirePermission } = require('../../services/ModerationService');

/** Carte « Serveur déverrouillé » + bouton inverse « Tout verrouiller ». */
function render(count, moderator, ownerId) {
  return {
    embeds: [serverLockCard({ enabled: false, count, moderator, section: 'moderation' })],
    components: buttonRows(
      actionButton({ command: 'lockall', action: 'run', args: [ownerId], label: 'Tout verrouiller', emoji: ICONS.lock }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unlockall')
    .setDescription('Lève le verrouillage posé par /lockall ou /lockdown.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, client) {
    // Comme Discord : modifier les permissions des salons exige « Gérer les salons » et « Gérer les rôles ».
    requirePermission(interaction, 'ManageChannels');
    requirePermission(interaction, 'ManageRoles');
    await interaction.deferReply();
    const n = await client.services.lockdown.disable(interaction.guild, interaction.member);
    await interaction.editReply(render(n, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:unlockall:run:<ownerId> — « Tout déverrouiller » (inverse de /lockall), réservé aux administrateurs. */
    async run(interaction, client, [ownerId]) {
      assertAdmin(interaction);
      await interaction.deferUpdate();
      const n = await client.services.lockdown.disable(interaction.guild, interaction.member);
      await interaction.editReply(render(n, interaction.user, ownerId));
    },
  },
};
