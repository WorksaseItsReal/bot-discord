'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { parseDuration, formatDuration } = require('../../utils/time');
const { card, field, ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { channelForButton } = require('../../services/LockdownService');
const { needPermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

const MAX_SECONDS = 21_600; // limite Discord : 6 heures

async function apply(channel, seconds, user) {
  if (typeof channel?.setRateLimitPerUser !== 'function') throw new UserError('Ce salon ne prend pas en charge le mode lent.');
  await channel.setRateLimitPerUser(seconds, `Slowmode par ${user.tag}`);
}

/**
 * Carte de résultat + bouton inverse : « Désactiver » quand le mode lent est actif,
 * « Rétablir » (ancienne valeur) quand il vient d'être désactivé.
 */
function render(channel, seconds, previous, moderator, ownerId) {
  const on = seconds > 0;
  // previous : délai en vigueur avant l'action (sert au bouton « Rétablir »).
  const inverse = on
    ? actionButton({ command: 'slowmode', action: 'set', args: [channel.id, 0, ownerId], label: 'Désactiver', emoji: '🐇', style: ButtonStyle.Success })
    : previous > 0
      ? actionButton({ command: 'slowmode', action: 'set', args: [channel.id, previous, ownerId], label: `Rétablir (${formatDuration(previous * 1000)})`, emoji: '🐢' })
      : null;
  return {
    embeds: [
      card({
        tone: on ? 'caution' : 'success',
        section: 'moderation',
        icon: '🐢',
        title: on ? 'Mode lent activé' : 'Mode lent désactivé',
        description: on
          ? `Dans ${channel}, chaque membre doit attendre **${formatDuration(seconds * 1000)}** entre deux messages.`
          : `Les membres peuvent de nouveau écrire librement dans ${channel}.`,
        fields: [
          field(ICONS.channel, 'Salon', `${channel}`),
          field(ICONS.duration, 'Délai', on ? `**${formatDuration(seconds * 1000)}**` : 'Aucun'),
          field(ICONS.moderator, 'Modérateur', `<@${moderator.id}>`),
        ],
      }),
    ],
    components: buttonRows(inverse, deleteButton(ownerId)),
  };
}

module.exports = {
  category: 'moderation',
  botPermissions: [PermissionFlagsBits.ManageChannels],
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Définit le mode lent d\'un salon.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('duree').setDescription('Délai entre deux messages (ex : 10s, 5m, 1h) ou « 0 » pour désactiver').setRequired(true).setMaxLength(20))
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon (par défaut le salon actuel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildForum),
    ),
  async execute(interaction) {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    const input = interaction.options.getString('duree').trim();
    const off = ['0', 'off', 'non', 'aucun'].includes(input.toLowerCase());
    const ms = off ? 0 : parseDuration(/^\d+$/.test(input) ? `${input}s` : input);
    if (!off && !ms) throw new UserError('Durée invalide. Exemples : `10s`, `5m`, `1h`, ou `0` pour désactiver.');
    const seconds = Math.round(ms / 1000);
    if (seconds > MAX_SECONDS) throw new UserError('Discord limite le mode lent à 6 heures.');
    const previous = channel?.rateLimitPerUser ?? 0;
    await apply(channel, seconds, interaction.user);
    await interaction.reply(render(channel, seconds, previous, interaction.user, interaction.user.id));
  },

  buttons: {
    /** cmd:slowmode:set:<channelId>:<secondes>:<ownerId> — bouton inverse (« Gérer les salons » revérifiée). */
    async set(interaction, client, [channelId, rawSeconds, ownerId]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) throw needPermission('ManageChannels');
      const seconds = Math.min(MAX_SECONDS, Math.max(0, Number.parseInt(rawSeconds, 10) || 0));
      const channel = await channelForButton(interaction, channelId);
      // Valeur actuelle conservée pour proposer « Rétablir » après une désactivation.
      const previous = channel.rateLimitPerUser ?? 0;
      await apply(channel, seconds, interaction.user);
      await interaction.update(render(channel, seconds, previous, interaction.user, ownerId));
    },
  },
};
