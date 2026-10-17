'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { field, ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { channelCard, channelForButton, channelForCommand } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');

/**
 * Masque le salon (l'état d'origine de ViewChannel est sauvegardé pour /unhide). Catégorie :
 * ses salons synchronisés sont masqués avec elle.
 * @returns {Promise<number>} salons masqués avec la catégorie
 */
function hide(client, channel, user) {
  return client.services.lockdown.hideChannel(channel, `Hide par ${user.tag}`);
}

/** Carte « Salon masqué » (+ salons de la catégorie masqués avec elle) + bouton inverse « Afficher ». */
function render(channel, moderator, ownerId, children = 0) {
  return {
    embeds: [channelCard('hide', channel, moderator, [
      children ? field(ICONS.count, 'Salons de la catégorie masqués', `**${children}**`) : null,
    ])],
    components: buttonRows(
      actionButton({ command: 'unhide', action: 'run', args: [channel.id, ownerId], label: 'Afficher', emoji: ICONS.visible, style: ButtonStyle.Success }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('hide')
    .setDescription('Cache un salon à @everyone.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
        ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory,
      )),

  async execute(interaction, client) {
    const channel = channelForCommand(interaction, 'salon', { overwrites: true });
    // Catégorie : un appel par salon synchronisé, plus de 3 s possible.
    await interaction.deferReply();
    const children = await hide(client, channel, interaction.user);
    await interaction.editReply(render(channel, interaction.user, interaction.user.id, children));
  },

  buttons: {
    /** cmd:hide:run:<channelId>:<ownerId> — « Masquer » (inverse de /unhide). */
    async run(interaction, client, [channelId, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const channel = await channelForButton(interaction, channelId, { overwrites: true });
      await interaction.deferUpdate();
      const children = await hide(client, channel, interaction.user);
      await interaction.editReply(render(channel, interaction.user, ownerId, children));
    },
  },
};
