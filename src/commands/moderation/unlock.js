'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows } = require('../../utils/ui');
const { channelCard, channelForButton, channelForCommand } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');
const { LOCK_CHANNEL_TYPES } = require('./lock');

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
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(...LOCK_CHANNEL_TYPES)),

  async execute(interaction, client) {
    const channel = channelForCommand(interaction);
    await client.services.lockdown.unlockChannel(channel, `Unlock par ${interaction.user.tag}`);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:unlock:run:<channelId>:<ownerId> — « Déverrouiller » (inverse de /lock). */
    async run(interaction, client, [channelId, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const channel = await channelForButton(interaction, channelId);
      await client.services.lockdown.unlockChannel(channel, `Unlock par ${interaction.user.tag}`);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
