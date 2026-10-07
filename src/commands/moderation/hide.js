'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { channelCard, channelForButton, channelForCommand } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');

/** Masque le salon (l'état d'origine de ViewChannel est sauvegardé pour /unhide). */
function hide(client, channel, user) {
  return client.services.lockdown.hideChannel(channel, `Hide par ${user.tag}`);
}

/** Carte « Salon masqué » + bouton inverse « Afficher ». */
function render(channel, moderator, ownerId) {
  return {
    embeds: [channelCard('hide', channel, moderator)],
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
    const channel = channelForCommand(interaction);
    await hide(client, channel, interaction.user);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:hide:run:<channelId>:<ownerId> — « Masquer » (inverse de /unhide). */
    async run(interaction, client, [channelId, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const channel = await channelForButton(interaction, channelId);
      await hide(client, channel, interaction.user);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
