'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows } = require('../../utils/ui');
const { assertOverwritable, channelCard, channelForButton } = require('../../services/LockdownService');
const { needPermission } = require('../../services/ModerationService');

async function unhide(channel, user) {
  assertOverwritable(channel);
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { ViewChannel: null }, { reason: `Unhide par ${user.tag}` });
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

  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await unhide(channel, interaction.user);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:unhide:run:<channelId>:<ownerId> — « Afficher » (inverse de /hide). */
    async run(interaction, client, [channelId, ownerId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) throw needPermission('ManageChannels');
      const channel = await channelForButton(interaction, channelId);
      await unhide(channel, interaction.user);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
