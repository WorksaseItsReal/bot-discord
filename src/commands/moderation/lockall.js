'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { serverLockCard } = require('../../services/LockdownService');
const { assertAdmin, requirePermission } = require('../../services/ModerationService');
const { confirm } = require('../../utils/confirmation');

/** Carte « Serveur verrouillé » + bouton inverse « Tout déverrouiller ». */
function render(count, moderator, ownerId) {
  return {
    embeds: [serverLockCard({ enabled: true, count, moderator, section: 'moderation' })],
    components: buttonRows(
      actionButton({ command: 'unlockall', action: 'run', args: [ownerId], label: 'Tout déverrouiller', emoji: ICONS.unlock, style: ButtonStyle.Success }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('lockall')
    .setDescription('Verrouille tous les salons écrits du serveur (texte, annonces, forums, vocaux).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, client) {
    // Comme Discord : modifier les permissions des salons exige « Gérer les salons » et « Gérer les rôles ».
    requirePermission(interaction, 'ManageChannels');
    requirePermission(interaction, 'ManageRoles');
    if (client.services.config?.get(interaction.guild.id)?.moderation?.confirmDangerous) {
      const ok = await confirm(interaction, { description: 'Verrouiller **tous** les salons écrits du serveur ?', confirmLabel: 'Tout verrouiller' });
      if (!ok) return;
    } else {
      await interaction.deferReply();
    }
    const n = await client.services.lockdown.enable(interaction.guild, interaction.member, `Lockall par ${interaction.user.tag}`);
    await interaction.editReply(render(n, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:lockall:run:<ownerId> — « Tout verrouiller » (inverse de /unlockall), réservé aux administrateurs. */
    async run(interaction, client, [ownerId]) {
      assertAdmin(interaction);
      await interaction.deferUpdate();
      const n = await client.services.lockdown.enable(interaction.guild, interaction.member, `Lockall par ${interaction.user.tag}`);
      await interaction.editReply(render(n, interaction.user, ownerId));
    },
  },
};
