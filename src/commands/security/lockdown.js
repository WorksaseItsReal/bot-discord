'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { card, field, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { parseDuration, discordTimestamp, formatDuration } = require('../../utils/time');
const { serverLockCard } = require('../../services/LockdownService');
const { timedDuration } = require('../../services/TimedLockService');
const { assertAdmin } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

function enableButton() {
  return actionButton({ command: 'lockdown', action: 'enable', label: 'Activer le lockdown', emoji: '🚨', style: ButtonStyle.Danger });
}

function disableButton() {
  return actionButton({ command: 'lockdown', action: 'disable', label: 'Lever le lockdown', emoji: ICONS.unlock, style: ButtonStyle.Success });
}

/** Panneau d'état : nombre de salons verrouillés, levée programmée + bouton d'action adapté. */
function renderStatus(client, guild) {
  const lockdown = client.services.lockdown;
  const n = lockdown.status(guild);
  const timer = n ? client.services.timedLocks?.activeFor(guild.id, 'lockdown', guild.id) : null;
  return {
    embeds: [
      card({
        tone: n ? 'caution' : 'neutral',
        section: 'security',
        icon: n ? ICONS.lock : ICONS.unlock,
        title: 'Lockdown',
        description: n
          ? `🔴 Lockdown **en cours** : ${n > 1 ? `**${n}** salons sont` : '**1** salon est'} en lecture seule.`
          : '🟢 Aucun salon n\'est verrouillé. Le serveur fonctionne normalement.',
        fields: [
          field(ICONS.count, 'Salons verrouillés', `**${n}**`),
          n ? field(ICONS.expires, 'Levée automatique', timer ? `${discordTimestamp(timer.expires_at, 'f')}\n${discordTimestamp(timer.expires_at, 'R')}` : 'Aucune (manuelle)') : null,
        ],
      }),
    ],
    components: buttonRows(n ? disableButton() : enableButton()),
  };
}

/**
 * Lockdown avec durée refusé si un lockdown SANS échéance est déjà en cours (AntiRaid ou
 * manuel) : sa levée automatique rouvrirait aussi les salons verrouillés par ce lockdown.
 * Un lockdown déjà temporaire peut être reprogrammé.
 */
function assertNoPermanentLockdown(client, guild) {
  if (!client.services.lockdown.status(guild)) return;
  if (client.services.timedLocks?.activeFor(guild.id, 'lockdown', guild.id)) return;
  throw new UserError('Un lockdown **sans échéance** est déjà en cours (AntiRaid ou manuel) : `/lockdown disable` d\'abord, ou relancez sans durée.');
}

/**
 * Demande confirmation puis verrouille tout ; la carte remplace la confirmation.
 * `durationMs` : levée automatique programmée (étape du scheduler) ; sans durée, le
 * lockdown est permanent (une levée déjà programmée est annulée par enable()).
 */
async function runEnable(interaction, client, durationMs = null) {
  if (durationMs) assertNoPermanentLockdown(client, interaction.guild);
  const ok = await confirm(interaction, {
    description: `Verrouiller **tous** les salons écrits du serveur${durationMs ? ` pendant **${formatDuration(durationMs)}**` : ''} ?`,
    confirmLabel: 'Lockdown',
  });
  if (!ok) return;
  // Relu après la confirmation : l'AntiRaid a pu verrouiller le serveur entre-temps.
  if (durationMs) assertNoPermanentLockdown(client, interaction.guild);
  const n = await client.services.lockdown.enable(interaction.guild, interaction.member, `Lockdown par ${interaction.user.tag}`);
  const until = durationMs && n
    ? client.services.timedLocks.schedule({ guildId: interaction.guild.id, channelId: interaction.guild.id, kind: 'lockdown', durationMs, moderatorId: interaction.user.id })
    : null;
  await interaction.editReply({ embeds: [serverLockCard({ enabled: true, count: n, moderator: interaction.user, until })], components: buttonRows(disableButton()) });
}

async function runDisable(interaction, client) {
  await interaction.deferReply({ ephemeral: true });
  const n = await client.services.lockdown.disable(interaction.guild, interaction.member);
  await interaction.editReply({ embeds: [serverLockCard({ enabled: false, count: n, moderator: interaction.user })], components: buttonRows(enableButton()) });
}

module.exports = {
  category: 'security',
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Verrouillage d\'urgence de tout le serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s.setName('enable').setDescription('Active le lockdown (verrouille tous les salons).')
        .addStringOption((o) => o.setName('duree').setDescription('Lever automatiquement après (ex : 30m, 2h, 1d). Vide = jusqu\'à /lockdown disable').setMaxLength(20)))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive le lockdown (restaure les salons).'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du lockdown.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return interaction.reply({ ...renderStatus(client, interaction.guild), ephemeral: true });
    if (sub === 'enable') {
      const raw = interaction.options.getString('duree');
      return runEnable(interaction, client, raw ? timedDuration(raw, parseDuration) : null);
    }
    if (sub === 'disable') return runDisable(interaction, client);
  },

  buttons: {
    /** cmd:lockdown:enable — avec confirmation, réservé aux administrateurs (sans levée automatique). */
    async enable(interaction, client) {
      assertAdmin(interaction);
      return runEnable(interaction, client);
    },
    /** cmd:lockdown:disable — aussi proposé sur les alertes AntiRaid ; réservé aux administrateurs. */
    async disable(interaction, client) {
      assertAdmin(interaction);
      return runDisable(interaction, client);
    },
  },
};
