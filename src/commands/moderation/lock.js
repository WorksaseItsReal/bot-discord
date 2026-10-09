'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { field, ICONS, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { parseDuration, discordTimestamp } = require('../../utils/time');
const { channelCard, channelForButton, channelForCommand, normalizeLock, SCOPES } = require('../../services/LockdownService');
const { UserError } = require('../../core/errors');
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
 * Verrouille puis programme (duree) ou annule (sans duree) la levée automatique, dans la
 * même section que le verrouillage (une levée automatique simultanée ne peut pas s'intercaler) :
 * un verrouillage sans durée est permanent, même si une levée était prévue.
 * @returns {Promise<number|null>} échéance de la levée automatique
 */
async function lockFor(client, channel, member, tag, durationMs = null) {
  return client.services.lockdown.lockChannel(channel, member, `Lock par ${tag}`, {
    timer: durationMs ? { durationMs, moderatorId: member?.id ?? null } : null,
  });
}

/**
 * Le salon est-il déjà verrouillé SANS échéance (/lock permanent, lockdown manuel ou AntiRaid) ?
 * Un /lock duree le rouvrirait à l'échéance : refusé. Un verrou mémorisé mais rouvert hors du
 * bot (plus de refus d'écrire) ne compte pas.
 */
function lockedWithoutExpiry(client, channel) {
  const guildId = channel.guildId ?? channel.guild?.id;
  const saved = client.services.lockdown.locks.get(guildId, channel.id);
  if (!saved) return false;
  const everyone = channel.permissionOverwrites?.cache?.get(channel.guild?.roles?.everyone?.id ?? guildId);
  if (!everyone?.deny?.has?.(PermissionFlagsBits.SendMessages)) return false;
  const timed = client.services.timedLocks;
  if (timed?.activeFor(guildId, 'lock', channel.id)) return false;
  const scope = normalizeLock(saved.data).scope ?? SCOPES.lockdown;
  return !(scope === SCOPES.lockdown && timed?.activeFor(guildId, 'lockdown', guildId));
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
    if (durationMs && lockedWithoutExpiry(client, channel)) {
      throw new UserError(`${channel} est déjà verrouillé **sans échéance** (AntiRaid, lockdown ou /lock) : \`/unlock\` d'abord, ou relancez sans durée.`);
    }
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
