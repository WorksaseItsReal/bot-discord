'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { channelCard, channelForButton } = require('../../services/LockdownService');
const { needPermission } = require('../../services/ModerationService');

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
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Verrouille un salon (empêche @everyone d\'écrire).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(ChannelType.GuildText)),

  async execute(interaction, client) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await client.services.lockdown.lockChannel(channel, interaction.member, `Lock par ${interaction.user.tag}`);
    await interaction.reply(render(channel, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:lock:run:<channelId>:<ownerId> — « Verrouiller » (inverse de /unlock). */
    async run(interaction, client, [channelId, ownerId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) throw needPermission('ManageChannels');
      const channel = await channelForButton(interaction, channelId);
      await client.services.lockdown.lockChannel(channel, interaction.member, `Lock par ${interaction.user.tag}`);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
