'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { parseDuration, formatDuration, discordTimestamp } = require('../../utils/time');
const { card, field, ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { timedDuration } = require('../../services/TimedLockService');
const { requirePermission } = require('../../services/ModerationService');
const { memberCanIn } = require('../../utils/access');
const { snowflake } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const MAX_SECONDS = 21_600; // limite Discord : 6 heures

/**
 * « Gérer les salons » sur le salon VISÉ (pas seulement celui de la commande) : native, ou
 * déléguée par /permissions (palier « courant ») à un membre qui voit ce salon (utils/access.js).
 */
function assertCanSlow(interaction, channel) {
  if (!memberCanIn(interaction, channel, [PermissionFlagsBits.ManageChannels])) {
    throw new UserError(`Il vous faut la permission **Gérer les salons** dans ${channel ?? 'ce salon'}.`);
  }
}

/** Salon visé par l'option `salon` (ou le salon actuel), contrôlé par assertCanSlow. */
function channelForCommand(interaction) {
  const picked = interaction.options.getChannel('salon');
  const channel = picked ? interaction.guild.channels.cache.get(picked.id) ?? picked : interaction.channel;
  assertCanSlow(interaction, channel);
  return channel;
}

/** Salon d'un bouton (identifiant validé, salon de CE serveur), contrôlé par assertCanSlow. */
async function channelForButton(interaction, rawChannelId) {
  const channelId = snowflake(rawChannelId, 'salon');
  const channel = interaction.guild.channels.cache.get(channelId)
    ?? (await interaction.client.channels.fetch(channelId).catch(() => null));
  if (!channel || channel.guildId !== interaction.guildId) throw new UserError('Ce salon n\'existe plus.');
  assertCanSlow(interaction, channel);
  return channel;
}

/**
 * Applique le mode lent puis programme (pendant) ou annule la levée automatique :
 * une nouvelle valeur manuelle remplace toujours une levée prévue.
 * @returns {Promise<number|null>} échéance de la levée automatique
 */
async function apply(client, channel, seconds, user, { previous = 0, durationMs = null } = {}) {
  if (typeof channel?.setRateLimitPerUser !== 'function') throw new UserError('Ce salon ne prend pas en charge le mode lent.');
  await channel.setRateLimitPerUser(seconds, `Slowmode par ${user.tag}`);
  const timed = client.services.timedLocks;
  if (!durationMs) {
    timed?.cancel(channel.guildId ?? channel.guild?.id, 'slowmode', channel.id, 'replaced');
    return null;
  }
  return timed.schedule({ guildId: channel.guildId ?? channel.guild?.id, channelId: channel.id, kind: 'slowmode', durationMs, moderatorId: user.id, data: { applied: seconds, previous } });
}

/**
 * Carte de résultat + bouton inverse : « Désactiver » quand le mode lent est actif,
 * « Rétablir » (ancienne valeur) quand il vient d'être désactivé.
 */
function render(channel, seconds, previous, moderator, ownerId, until = null) {
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
          until ? field(ICONS.expires, 'Levée automatique', `${discordTimestamp(until, 'f')}\n${discordTimestamp(until, 'R')}\n${previous ? `retour à ${formatDuration(previous * 1000)}` : 'désactivé ensuite'}`) : null,
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
    )
    .addStringOption((o) => o.setName('pendant').setDescription('Revenir automatiquement au délai d\'avant après (ex : 30m, 2h, 1d)').setMaxLength(20)),
  async execute(interaction, client) {
    const channel = channelForCommand(interaction);
    const input = interaction.options.getString('duree').trim();
    const off = ['0', 'off', 'non', 'aucun'].includes(input.toLowerCase());
    const ms = off ? 0 : parseDuration(/^\d+$/.test(input) ? `${input}s` : input);
    if (!off && !ms) throw new UserError('Durée invalide. Exemples : `10s`, `5m`, `1h`, ou `0` pour désactiver.');
    const seconds = Math.round(ms / 1000);
    if (seconds > MAX_SECONDS) throw new UserError('Discord limite le mode lent à 6 heures.');
    const rawFor = interaction.options.getString('pendant');
    const durationMs = rawFor ? timedDuration(rawFor, parseDuration) : null;
    const previous = channel?.rateLimitPerUser ?? 0;
    if (durationMs && seconds === previous) throw new UserError(`Le mode lent de ${channel} est déjà de cette valeur : rien à rétablir ensuite.`);
    const until = await apply(client, channel, seconds, interaction.user, { previous, durationMs });
    await interaction.reply(render(channel, seconds, previous, interaction.user, interaction.user.id, until));
  },

  buttons: {
    /** cmd:slowmode:set:<channelId>:<secondes>:<ownerId> — bouton inverse (« Gérer les salons » revérifiée). */
    async set(interaction, client, [channelId, rawSeconds, ownerId]) {
      requirePermission(interaction, 'ManageChannels');
      const seconds = Math.min(MAX_SECONDS, Math.max(0, Number.parseInt(rawSeconds, 10) || 0));
      const channel = await channelForButton(interaction, channelId);
      // Valeur actuelle conservée pour proposer « Rétablir » après une désactivation.
      const previous = channel.rateLimitPerUser ?? 0;
      await apply(client, channel, seconds, interaction.user);
      await interaction.update(render(channel, seconds, previous, interaction.user, ownerId));
    },
  },
};
