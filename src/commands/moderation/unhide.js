'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows } = require('../../utils/ui');
const { channelCard, channelForButton, channelForCommand } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');

/** Rend le salon visible (restaure l'état sauvegardé par /hide, sinon retire le refus). */
function unhide(client, channel, user) {
  return client.services.lockdown.unhideChannel(channel, `Unhide par ${user.tag}`);
}

/** Carte « Salon visible » + bouton inverse « Masquer ». */
function render(channel, moderator, ownerId) {
  return {
    embeds: [channelCard('unhide', channel, moderator)],
    components: buttonRows(
      actionButton({ command: 'hide', action: 'run', args: [channel.id, ownerId], label: 'Masquer', emoji: ICONS.hidden }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unhide')
    .setDescription('Rend un salon visible à @everyone.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
        ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory,
      )),

  async execute(interaction, client) {
    const channel = channelForCommand(interaction, 'salon', { overwrites: true });
    await unhide(client, channel, interaction.user);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:unhide:run:<channelId>:<ownerId> — « Afficher » (inverse de /hide). */
    async run(interaction, client, [channelId, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const channel = await channelForButton(interaction, channelId, { overwrites: true });
      await unhide(client, channel, interaction.user);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
