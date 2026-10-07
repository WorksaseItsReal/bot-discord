'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertOverwritable, channelCard, channelForButton } = require('../../services/LockdownService');
const { needPermission } = require('../../services/ModerationService');

async function hide(channel, user) {
  assertOverwritable(channel);
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { ViewChannel: false }, { reason: `Hide par ${user.tag}` });
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

  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await hide(channel, interaction.user);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:hide:run:<channelId>:<ownerId> — « Masquer » (inverse de /unhide). */
    async run(interaction, client, [channelId, ownerId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) throw needPermission('ManageChannels');
      const channel = await channelForButton(interaction, channelId);
      await hide(channel, interaction.user);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
