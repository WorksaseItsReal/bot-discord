'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { field, ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { parseDuration, discordTimestamp } = require('../../utils/time');
const { channelCard, channelForButton, channelForCommand } = require('../../services/LockdownService');
const { timedDuration } = require('../../services/TimedLockService');
const { requirePermission } = require('../../services/ModerationService');

/** Salons où l'on peut écrire : textuels, annonces, forums, texte des vocaux. */
const LOCK_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice];

/** Carte « Salon verrouillé » (+ levée automatique) + bouton inverse « Déverrouiller ». */
function render(channel, moderator, ownerId, until = null) {
  return {
    embeds: [channelCard('lock', channel, moderator, [
      until ? field(ICONS.expires, 'Levée automatique', `${discordTimestamp(until, 'f')}\n${discordTimestamp(until, 'R')}`) : null,
    ])],
    components: buttonRows(
      actionButton({ command: 'unlock', action: 'run', args: [channel.id, ownerId], label: 'Déverrouiller', emoji: ICONS.unlock, style: ButtonStyle.Success }),
      deleteButton(ownerId),
    ),
  };
}

/**
 * Verrouille puis programme (duree) ou annule (sans duree) la levée automatique :
 * un verrouillage sans durée est permanent, même si une levée était prévue.
 * @returns {number|null} échéance de la levée automatique
 */
async function lockFor(client, channel, member, tag, durationMs = null) {
  await client.services.lockdown.lockChannel(channel, member, `Lock par ${tag}`);
  const timed = client.services.timedLocks;
  if (!durationMs) {
    timed?.cancel(channel.guildId ?? channel.guild?.id, 'lock', channel.id, 'replaced');
    return null;
  }
  return timed.schedule({ guildId: channel.guildId ?? channel.guild?.id, channelId: channel.id, kind: 'lock', durationMs, moderatorId: member?.id ?? null });
}

module.exports = {
  category: 'moderation',
  LOCK_CHANNEL_TYPES,
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Verrouille un salon (empêche @everyone d\'écrire).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut: actuel)').addChannelTypes(...LOCK_CHANNEL_TYPES))
    .addStringOption((o) => o.setName('duree').setDescription('Déverrouiller automatiquement après (ex : 30m, 2h, 1d). Vide = permanent').setMaxLength(20)),

  async execute(interaction, client) {
    const channel = channelForCommand(interaction, 'salon', { overwrites: true });
    const raw = interaction.options.getString('duree');
    const durationMs = raw ? timedDuration(raw, parseDuration) : null;
    const until = await lockFor(client, channel, interaction.member, interaction.user.tag, durationMs);
    await interaction.reply(render(channel, interaction.user, interaction.user.id, until));
  },

  buttons: {
    /** cmd:lock:run:<channelId>:<ownerId> — « Verrouiller » (inverse de /unlock) : verrouillage permanent. */
    async run(interaction, client, [channelId, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const channel = await channelForButton(interaction, channelId, { overwrites: true });
      await lockFor(client, channel, interaction.member, interaction.user.tag);
      await interaction.update(render(channel, interaction.user, ownerId));
    },
  },
};
