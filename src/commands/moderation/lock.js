'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { channelCard, channelForButton, channelForCommand } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');

/** Salons où l'on peut écrire : textuels, annonces, forums, texte des vocaux. */
const LOCK_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice];

/** Carte « Salon verrouillé » + bouton inverse « Déverrouiller ». */
function render(channel, moderator, ownerId) {
  return {
    embeds: [channelCard('lock', channel, moderator)],
    components: buttonRows(
      actionButton({ command: 'unlock', action: 'run', args: [channel.id, ownerId], label: 'Déverrouiller', emoji: ICONS.unlock, style: ButtonStyle.Success }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'moderation',
  LOCK_CHANNEL_TYPES,
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Verrouille un salon (empêche @everyone d\'écrire).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(...LOCK_CHANNEL_TYPES)),

  async execute(interaction, client) {
    const channel = channelForCommand(interaction, 'salon', { overwrites: true });
    await client.services.lockdown.lockChannel(channel, interaction.member, `Lock par ${interaction.user.tag}`);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:lock:run:<channelId>:<ownerId> — « Verrouiller » (inverse de /unlock). */
    async run(interaction, client, [channelId, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const channel = await channelForButton(interaction, channelId, { overwrites: true });
      await client.services.lockdown.lockChannel(channel, interaction.member, `Lock par ${interaction.user.tag}`);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
