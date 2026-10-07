'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows } = require('../../utils/ui');
const { channelCard, channelForButton } = require('../../services/LockdownService');
const { needPermission } = require('../../services/ModerationService');

/** Carte « Salon déverrouillé » + bouton inverse « Verrouiller ». */
function render(channel, moderator, ownerId) {
  return {
    embeds: [channelCard('unlock', channel, moderator)],
    components: buttonRows(
      actionButton({ command: 'lock', action: 'run', args: [channel.id, ownerId], label: 'Verrouiller', emoji: ICONS.lock }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Déverrouille un salon.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(ChannelType.GuildText)),

  async execute(interaction, client) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await client.services.lockdown.unlockChannel(channel);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:unlock:run:<channelId>:<ownerId> — « Déverrouiller » (inverse de /lock). */
    async run(interaction, client, [channelId, ownerId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) throw needPermission('ManageChannels');
      const channel = await channelForButton(interaction, channelId);
      await client.services.lockdown.unlockChannel(channel);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
