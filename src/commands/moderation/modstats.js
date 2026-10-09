'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, wide, ICONS, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { TYPE_LABELS, sanctionIcon, requirePermission } = require('../../services/ModerationService');
const { REPORT_ICON } = require('../../services/ReportService');
const { snowflake } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

/**
 * /modstats : activité de l'équipe de modération sur 7, 30 ou 90 jours, à partir des
 * tables existantes — sanctions (par modérateur, par type, tendance, raisons les plus
 * fréquentes), signalements traités et tickets pris en charge (encore ouverts : un
 * ticket fermé est retiré de la base). Réponse éphémère, « Exclure temporairement des
 * membres » revérifiée à chaque clic.
 *
 * Boutons : cmd:modstats:view:<jours>:<idModérateur|all>
 */

const DAY_MS = 86_400_000;
const PERIODS = [7, 30, 90];
/** Ordre d'affichage des types de sanction. */
const TYPE_ORDER = ['warn', 'mute', 'timeout', 'kick', 'softban', 'tempban', 'ban'];
const SPARK = '▁▂▃▄▅▆▇█';
const MAX_MODERATORS = 10;

// ---------------------------------------------------------------- helpers purs

/** Période valide (7, 30 ou 90 jours), 30 par défaut. Pur. */
function parsePeriod(raw) {
  const n = Number(raw);
  return PERIODS.includes(n) ? n : 30;
}

/**
 * Regroupe les lignes (modérateur, type, n) : totaux par type et par modérateur. Pur.
 * @returns {{ total: number, byType: Record<string, number>, moderators: Array<{ id: string, total: number, byType: Record<string, number> }> }}
 */
function summarize(rows = []) {
  const byType = {};
  const mods = new Map();
  let total = 0;
  for (const { moderator_id: id, type, n } of rows) {
    total += n;
    byType[type] = (byType[type] ?? 0) + n;
    const m = mods.get(id) ?? { id, total: 0, byType: {} };
    m.total += n;
    m.byType[type] = (m.byType[type] ?? 0) + n;
    mods.set(id, m);
  }
  const moderators = [...mods.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  return { total, byType, moderators };
}

/**
 * Mini-histogramme (▁▂▃…█) des dates sur [since, until[ en `buckets` intervalles. Pur.
 * @returns {{ line: string, counts: number[] }}
 */
function sparkline(times, since, until, buckets) {
  const counts = new Array(Math.max(1, buckets)).fill(0);
  const span = Math.max(1, until - since);
  for (const t of times) {
    if (t < since || t >= until) continue;
    const i = Math.min(counts.length - 1, Math.floor(((t - since) / span) * counts.length));
    counts[i] += 1;
  }
  const max = Math.max(...counts);
  const line = counts.map((n) => (n ? SPARK[Math.min(SPARK.length - 1, Math.ceil((n / max) * SPARK.length) - 1)] : '·')).join('');
  return { line, counts };
}

/** « ↗ +50 % par rapport aux 30 jours précédents ». Pur. */
function trendText(current, previous, days) {
  const ref = `les ${days} jours précédents`;
  if (!previous && !current) return `Aucune sanction, comme ${ref}.`;
  if (!previous) return `↗ **${current}** sanction(s), contre aucune ${ref}.`;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `→ Stable par rapport à ${ref} (**${previous}**).`;
  return `${pct > 0 ? '↗' : '↘'} **${pct > 0 ? '+' : ''}${pct} %** par rapport à ${ref} (**${previous}**).`;
}

/** « ⚠️ 3 · ⛔ 1 » : détail par type. Pur. */
function typeBreakdown(byType) {
  return TYPE_ORDER.filter((t) => byType[t]).map((t) => `${sanctionIcon(t)} ${byType[t]}`).join(' · ');
}

/** Nombre d'intervalles du mini-histogramme selon la période (jours ou semaines). Pur. */
function bucketsFor(days) {
  return days <= 30 ? days : Math.ceil(days / 7);
}

// ---------------------------------------------------------------- vue

/** Modérateur affiché : le bot (AutoMod, escalades) est nommé comme tel. */
function moderatorLabel(client, id) {
  return id === client.user?.id ? `${ICONS.bot} <@${id}> *(AutoMod, automatique)*` : `<@${id}>`;
}

/**
 * Carte des statistiques.
 * @param {{ days: number, moderatorId?: string|null, now?: number }} opts
 */
function statsView(client, guild, { days, moderatorId = null, now = Date.now() }) {
  const until = now + 1;
  const since = now - days * DAY_MS;
  const sanctions = client.repositories.sanctions.stats(guild.id, { since, until, moderatorId });
  const previous = client.repositories.sanctions.stats(guild.id, { since: since - days * DAY_MS, until: since, moderatorId, reasons: 0 }).times.length;
  const { total, byType, moderators } = summarize(sanctions.byModType);
  const spark = sparkline(sanctions.times, since, until, bucketsFor(days));
  const reports = client.repositories.reports?.handledStats?.(guild.id, { since, until, moderatorId }) ?? [];
  const handled = reports.filter((r) => r.status === 'handled').reduce((a, r) => a + r.n, 0);
  const dismissed = reports.filter((r) => r.status === 'dismissed').reduce((a, r) => a + r.n, 0);
  const reportsByMod = new Map();
  for (const r of reports) reportsByMod.set(r.handled_by, (reportsByMod.get(r.handled_by) ?? 0) + r.n);
  const tickets = client.repositories.tickets?.claimedStats?.(guild.id, { since, moderatorId }) ?? [];
  const claimed = tickets.reduce((a, r) => a + r.n, 0);

  const modLines = moderators.slice(0, MAX_MODERATORS).map((m, i) => `\`${i + 1}.\` ${moderatorLabel(client, m.id)} — **${m.total}** · ${typeBreakdown(m.byType)}`);
  if (moderators.length > MAX_MODERATORS) modLines.push(subtext(`… et ${moderators.length - MAX_MODERATORS} autre(s)`));
  const reportLines = [...reportsByMod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${moderatorLabel(client, id)} — **${n}**`);
  const ticketLines = tickets.sort((a, b) => b.n - a.n).slice(0, 5).map((r) => `${moderatorLabel(client, r.claimed_by)} — **${r.n}**`);
  const scale = days <= 30 ? 'un caractère = un jour' : 'un caractère = une semaine';

  return {
    embeds: [
      card({
        tone: 'info',
        section: 'moderation',
        icon: ICONS.stats,
        title: `Statistiques de modération · ${days} jours`,
        description: [
          moderatorId ? `${ICONS.moderator} Modérateur : ${moderatorLabel(client, moderatorId)}` : `${ICONS.members} Toute l'équipe de modération`,
          `Depuis le ${discordTimestamp(since, 'D')} : **${total}** sanction(s).`,
          trendText(total, previous, days),
          '',
          `\`${spark.line}\``,
          subtext(`Tendance : ${scale}, du plus ancien au plus récent.`),
        ],
        fields: [
          field(ICONS.count, 'Sanctions', `**${total}**`),
          field(REPORT_ICON, 'Signalements traités', `**${handled + dismissed}**${handled + dismissed ? `\n${subtext(`${handled} traité(s) · ${dismissed} classé(s)`)}` : ''}`),
          field(ICONS.ticket, 'Tickets pris en charge', `**${claimed}**\n${subtext('tickets encore ouverts')}`),
          wide(ICONS.list, 'Par type', TYPE_ORDER.filter((t) => byType[t]).map((t) => `${sanctionIcon(t)} ${TYPE_LABELS[t] ?? t} · **${byType[t]}**`).join('\n') || '*Aucune sanction sur cette période.*'),
          moderatorId ? null : wide(ICONS.moderator, 'Par modérateur', modLines.join('\n') || '*Aucune sanction sur cette période.*'),
          wide(ICONS.reason, 'Raisons les plus fréquentes', sanctions.reasons.map((r, i) => `\`${i + 1}.\` ${truncate(r.reason.replace(/\s+/g, ' ').replace(/`/g, 'ˋ'), 90)} — **${r.n}**`).join('\n') || '*Aucune raison renseignée.*'),
          !moderatorId && reportLines.length ? wide(REPORT_ICON, 'Signalements par membre du staff', reportLines.join('\n')) : null,
          !moderatorId && ticketLines.length ? wide(ICONS.ticket, 'Tickets par membre du staff', ticketLines.join('\n')) : null,
        ],
        footer: 'Sanctions enregistrées par le bot · les sanctions supprimées de l\'historique ne comptent pas',
      }),
    ],
    components: buttonRows(
      ...PERIODS.map((d) => actionButton({
        command: 'modstats',
        action: 'view',
        args: [d, moderatorId ?? 'all'],
        label: `${d} jours`,
        emoji: ICONS.date,
        style: d === days ? ButtonStyle.Primary : ButtonStyle.Secondary,
        disabled: d === days,
      })),
      actionButton({ command: 'modstats', action: 'view', args: [days, moderatorId ?? 'all', 'r'], label: 'Actualiser', emoji: ICONS.refresh }),
      moderatorId ? actionButton({ command: 'modstats', action: 'view', args: [days, 'all'], label: 'Toute l\'équipe', emoji: ICONS.members }) : null,
    ),
  };
}

const guard = (interaction) => requirePermission(interaction, 'ModerateMembers');

module.exports = {
  category: 'moderation',
  summarize,
  sparkline,
  trendText,
  parsePeriod,
  bucketsFor,
  statsView,
  data: new SlashCommandBuilder()
    .setName('modstats')
    .setDescription('Statistiques de l\'équipe de modération (sanctions, signalements, tickets).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addIntegerOption((o) =>
      o.setName('periode').setDescription('Période analysée (30 jours par défaut)')
        .addChoices({ name: '7 jours', value: 7 }, { name: '30 jours', value: 30 }, { name: '90 jours', value: 90 }))
    .addUserOption((o) => o.setName('moderateur').setDescription('Seulement ce modérateur')),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    guard(interaction);
    const days = parsePeriod(interaction.options.getInteger('periode') ?? 30);
    const moderator = interaction.options.getUser('moderateur');
    await interaction.reply({ ...statsView(client, interaction.guild, { days, moderatorId: moderator?.id ?? null }), ephemeral: true });
  },

  buttons: {
    /** cmd:modstats:view:<jours>:<idModérateur|all>[:r] — période, actualisation, toute l'équipe. */
    async view(interaction, client, [rawDays, rawMod]) {
      guard(interaction);
      if (!PERIODS.includes(Number(rawDays))) throw new UserError('Bouton invalide (période).');
      const moderatorId = rawMod === 'all' ? null : snowflake(rawMod, 'modérateur');
      await interaction.update(statsView(client, interaction.guild, { days: Number(rawDays), moderatorId }));
    },
  },
};
