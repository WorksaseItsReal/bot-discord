'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { confirm } = require('../../utils/confirmation');
const { card, field, wide, ICONS, actionButton, buttonRows, ButtonStyle, subtext } = require('../../utils/ui');
const { parseDuration, discordTimestamp, formatDuration } = require('../../utils/time');
const { serverLockCard } = require('../../services/LockdownService');
const { timedDuration } = require('../../services/TimedLockService');
const { logCard } = require('../../services/LoggingService');
const { assertAdmin } = require('../../services/ModerationService');
const { PAUSE_HOURS, DEFAULT_HOURS, normalizeHours } = require('../../services/RaidResponseService');
const { UserError } = require('../../core/errors');

/** Choix de durée des suspensions natives (1 à 24 h). */
const HOUR_CHOICES = PAUSE_HOURS.map((h) => ({ name: h === 1 ? '1 heure' : `${h} heures`, value: h }));
/** Cibles du bouton « Reprendre » : cmd:lockdown:resume:<invites|dms|all>. */
const RESUME_TARGETS = { invites: { invites: true, dms: false }, dms: { invites: false, dms: true }, all: { invites: true, dms: true } };

function enableButton() {
  return actionButton({ command: 'lockdown', action: 'enable', label: 'Activer le lockdown', emoji: '🚨', style: ButtonStyle.Danger });
}

function disableButton() {
  return actionButton({ command: 'lockdown', action: 'disable', label: 'Lever le lockdown', emoji: ICONS.unlock, style: ButtonStyle.Success });
}

/** Boutons « Reprendre » des mesures natives en cours (invitations, MP, les deux). Pur. */
function resumeButtons(state, now = Date.now()) {
  const inv = state?.invitesDisabledUntil > now;
  const dms = state?.dmsDisabledUntil > now;
  return [
    inv ? actionButton({ command: 'lockdown', action: 'resume', args: ['invites'], label: 'Rétablir les invitations', emoji: ICONS.link }) : null,
    dms ? actionButton({ command: 'lockdown', action: 'resume', args: ['dms'], label: 'Rétablir les MP', emoji: ICONS.mail }) : null,
    inv && dms ? actionButton({ command: 'lockdown', action: 'resume', args: ['all'], label: 'Tout rétablir', emoji: ICONS.unlock, style: ButtonStyle.Success }) : null,
  ];
}

/** Libellés accordés : invitations (féminin) et MP (masculin). */
const LABELS = { invites: { on: 'Actives', off: 'Suspendues' }, dms: { on: 'Actifs', off: 'Suspendus' } };

/** Valeur d'un champ « suspendu jusqu'à » (ou actif). Pur. */
function untilText(until, now = Date.now(), kind = 'invites') {
  const l = LABELS[kind] ?? LABELS.invites;
  return until && until > now ? `🔴 ${l.off} jusqu'à ${discordTimestamp(until, 'f')}\n${discordTimestamp(until, 'R')}` : `🟢 ${l.on}`;
}

/** Résumé de la riposte automatique (raidResponse). Pur. */
function riposteText(rr = {}) {
  if (!rr.onWave) return 'Coupée';
  const what = [rr.invites ? 'invitations' : null, rr.dms ? 'MP' : null].filter(Boolean).join(' et ') || 'rien';
  return `Active : ${what} suspendus ${normalizeHours(rr.hours)} h à chaque vague (une fois par 10 min au plus)`;
}

/**
 * Panneau d'état : salons verrouillés, levée programmée, mesures natives de Discord (invitations,
 * MP, raid détecté) et riposte automatique, avec les boutons d'action adaptés.
 * @param {object|null} incidents état lu par RaidResponseService.status (null : lecture impossible)
 */
function renderStatus(client, guild, incidents = null) {
  const lockdown = client.services.lockdown;
  const n = lockdown.status(guild);
  const timer = n ? client.services.timedLocks?.activeFor(guild.id, 'lockdown', guild.id) : null;
  const now = Date.now();
  const rr = client.services.config.get(guild.id)?.raidResponse ?? {};
  const paused = incidents && (incidents.invitesDisabledUntil > now || incidents.dmsDisabledUntil > now);
  return {
    embeds: [
      card({
        tone: n || paused ? 'caution' : 'neutral',
        section: 'security',
        icon: n ? ICONS.lock : ICONS.unlock,
        title: 'Lockdown',
        description: n
          ? `🔴 Lockdown **en cours** : ${n > 1 ? `**${n}** salons sont` : '**1** salon est'} en lecture seule.`
          : '🟢 Aucun salon n\'est verrouillé. Le serveur fonctionne normalement.',
        fields: [
          field(ICONS.count, 'Salons verrouillés', `**${n}**`),
          n ? field(ICONS.expires, 'Levée automatique', timer ? `${discordTimestamp(timer.expires_at, 'f')}\n${discordTimestamp(timer.expires_at, 'R')}` : 'Aucune (manuelle)') : null,
          field(ICONS.link, 'Invitations', incidents ? untilText(incidents.invitesDisabledUntil, now, 'invites') : '*Indisponible*'),
          field(ICONS.mail, 'MP entre membres', incidents ? untilText(incidents.dmsDisabledUntil, now, 'dms') : '*Indisponible*'),
          incidents?.raidDetectedAt ? field('🚨', 'Raid détecté par Discord', `${discordTimestamp(incidents.raidDetectedAt, 'f')}\n${discordTimestamp(incidents.raidDetectedAt, 'R')}`) : null,
          wide(ICONS.shield, 'Riposte automatique', riposteText(rr)),
        ],
      }),
    ],
    components: buttonRows(n ? disableButton() : enableButton(), ...resumeButtons(incidents, now)),
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

function raidResponse(client) {
  const svc = client.services.raidResponse;
  if (!svc) throw new UserError('La riposte native est indisponible pour le moment. Réessayez dans un instant.');
  return svc;
}

/** Log « Mesures d'incident » (catégorie Sécurité), APRÈS la réponse. */
async function logIncident(client, guild, { tone, icon, title, description, actor, fields = [] }) {
  const embed = logCard({ category: 'security', tone, icon, title, description, fields: [field(ICONS.moderator, 'Par', actor ? `<@${actor.id}>` : '—'), ...fields], id: actor?.id });
  await Promise.resolve(client.services.logging?.send?.(guild.id, 'security', embed, undefined, { event: 'incident' })).catch(() => false);
}

/** Lignes décrivant l'état après une pause ou une reprise. Pur. */
function stateFields(state, now = Date.now()) {
  return [
    field(ICONS.link, 'Invitations', untilText(state.invitesDisabledUntil, now, 'invites')),
    field(ICONS.mail, 'MP entre membres', untilText(state.dmsDisabledUntil, now, 'dms')),
  ];
}

/** /lockdown suspendre : invitations et/ou MP suspendus (outil natif de Discord). */
async function runPause(interaction, client) {
  const invites = interaction.options.getBoolean('invitations') ?? true;
  const dms = interaction.options.getBoolean('messages_prives') ?? false;
  const hours = normalizeHours(interaction.options.getInteger('duree') ?? DEFAULT_HOURS);
  if (!invites && !dms) throw new UserError('Choisissez au moins les invitations ou les messages privés.');
  const svc = raidResponse(client);
  svc.assertCanManage(interaction.guild);
  await interaction.deferReply({ ephemeral: true });
  const state = await svc.pause(interaction.guild, { invites, dms, hours, actorId: interaction.user.id, reason: `/lockdown suspendre par ${interaction.user.tag}` });
  const what = [invites ? 'les **invitations**' : null, dms ? 'les **MP entre membres**' : null].filter(Boolean).join(' et ');
  const description = [
    `${what[0].toUpperCase()}${what.slice(1)} ${invites && dms ? 'sont suspendus' : invites ? 'sont suspendues' : 'sont suspendus'} pour **${hours} h** au plus.`,
    subtext('Outil natif de Discord : une échéance déjà plus lointaine est conservée. Jamais renouvelée automatiquement au-delà de 24 h.'),
  ];
  await interaction.editReply({
    embeds: [card({ tone: 'caution', section: 'security', icon: '⏸️', title: 'Mesures d\'incident activées', description, fields: stateFields(state) })],
    components: buttonRows(...resumeButtons(state)),
  });
  await logIncident(client, interaction.guild, { tone: 'caution', icon: '⏸️', title: 'Mesures d\'incident activées', description: description[0], actor: interaction.user, fields: stateFields(state) });
}

/** /lockdown reprendre (et bouton cmd:lockdown:resume) : échéances remises à null. */
async function runResume(interaction, client, { invites, dms }) {
  if (!invites && !dms) throw new UserError('Choisissez au moins les invitations ou les messages privés.');
  const svc = raidResponse(client);
  svc.assertCanManage(interaction.guild);
  await interaction.deferReply({ ephemeral: true });
  const state = await svc.resume(interaction.guild, { invites, dms });
  const what = [invites ? 'les invitations' : null, dms ? 'les MP entre membres' : null].filter(Boolean).join(' et ');
  const description = `${what[0].toUpperCase()}${what.slice(1)} ${invites && !dms ? 'sont rétablies' : 'sont rétablis'}.`;
  await interaction.editReply({
    embeds: [card({ tone: 'success', section: 'security', icon: '▶️', title: 'Mesures d\'incident levées', description, fields: stateFields(state) })],
    components: buttonRows(...resumeButtons(state)),
  });
  await logIncident(client, interaction.guild, { tone: 'success', icon: '▶️', title: 'Mesures d\'incident levées', description, actor: interaction.user, fields: stateFields(state) });
}

/** /lockdown riposte : réglage raidResponse (riposte automatique aux vagues de l'AntiRaid). */
async function runRiposte(interaction, client) {
  const guild = interaction.guild;
  const before = client.services.config.get(guild.id).raidResponse ?? {};
  const onWave = interaction.options.getBoolean('actif', true);
  const invites = interaction.options.getBoolean('invitations') ?? before.invites ?? true;
  const dms = interaction.options.getBoolean('messages_prives') ?? before.dms ?? false;
  const hours = normalizeHours(interaction.options.getInteger('duree') ?? before.hours ?? DEFAULT_HOURS);
  if (onWave && !invites && !dms) throw new UserError('Choisissez au moins les invitations ou les messages privés à suspendre.');
  const after = { onWave, invites, dms, hours };
  client.services.config.update(guild.id, { raidResponse: after });
  const cfg = client.services.config.get(guild.id);
  const me = guild.members?.me;
  const warnings = [
    onWave && !cfg.antiraid?.enabled ? 'L\'AntiRaid est coupé : aucune vague ne sera détectée tant qu\'il ne sera pas activé (`/antiraid`).' : null,
    onWave && me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageGuild) ? 'Il me manque la permission **Gérer le serveur** : la suspension échouera.' : null,
  ].filter(Boolean);
  await interaction.reply({
    embeds: [card({
      tone: onWave ? (warnings.length ? 'warning' : 'success') : 'neutral',
      section: 'security',
      icon: ICONS.shield,
      title: 'Riposte automatique',
      description: onWave
        ? `À chaque vague d'arrivées de l'AntiRaid, Discord suspendra ${[invites ? 'les invitations' : null, dms ? 'les MP entre membres' : null].filter(Boolean).join(' et ')} pendant **${hours} h** (une fois par 10 minutes au plus, jamais renouvelée au-delà de 24 h).`
        : 'La riposte automatique est **coupée** : les vagues d\'arrivées ne suspendent plus les invitations.',
      fields: [wide(ICONS.shield, 'Réglage', riposteText(after)), warnings.length ? wide(ICONS.warning, 'Attention', warnings.join('\n')) : null],
    })],
    ephemeral: true,
  });
  const changes = Object.entries(after)
    .filter(([k, v]) => before[k] !== v)
    .map(([k, v]) => `raidResponse.${k} : ${before[k] === undefined ? '—' : String(before[k])} → ${String(v)}`);
  if (changes.length) await Promise.resolve(client.services.secur?.journal?.(guild, { actorId: interaction.user.id, actor: interaction.user, source: '/lockdown riposte', changes })).catch(() => {});
}

/** /lockdown status : état local, puis mesures natives lues chez Discord (deferReply avant). */
async function runStatus(interaction, client) {
  await interaction.deferReply({ ephemeral: true });
  const incidents = await client.services.raidResponse?.status(interaction.guild).catch(() => null) ?? null;
  await interaction.editReply(renderStatus(client, interaction.guild, incidents));
}

const hoursOption = (o, description) => o.setName('duree').setDescription(description).addChoices(...HOUR_CHOICES);

module.exports = {
  category: 'security',
  renderStatus,
  resumeButtons,
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Verrouillage d\'urgence du serveur et mesures d\'incident de Discord.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s.setName('enable').setDescription('Active le lockdown (verrouille tous les salons).')
        .addStringOption((o) => o.setName('duree').setDescription('Lever automatiquement après (ex : 30m, 2h, 1d). Vide = jusqu\'à /lockdown disable').setMaxLength(20)))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive le lockdown (restaure les salons).'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du lockdown et des mesures d\'incident.'))
    .addSubcommand((s) =>
      s.setName('suspendre').setDescription('Suspend les invitations et/ou les MP entre membres (outil de Discord, 24 h au plus).')
        .addBooleanOption((o) => o.setName('invitations').setDescription('Suspendre les arrivées par invitation (oui par défaut)'))
        .addBooleanOption((o) => o.setName('messages_prives').setDescription('Suspendre les MP entre membres non amis (non par défaut)'))
        .addIntegerOption((o) => hoursOption(o, 'Durée de la suspension (6 heures par défaut)')))
    .addSubcommand((s) =>
      s.setName('reprendre').setDescription('Rétablit les invitations et/ou les MP suspendus.')
        .addBooleanOption((o) => o.setName('invitations').setDescription('Rétablir les invitations (oui par défaut)'))
        .addBooleanOption((o) => o.setName('messages_prives').setDescription('Rétablir les MP entre membres (oui par défaut)')))
    .addSubcommand((s) =>
      s.setName('riposte').setDescription('Riposte automatique : suspendre les invitations à chaque vague d\'arrivées.')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer la riposte automatique aux vagues de l\'AntiRaid').setRequired(true))
        .addBooleanOption((o) => o.setName('invitations').setDescription('Suspendre les invitations (oui par défaut)'))
        .addBooleanOption((o) => o.setName('messages_prives').setDescription('Suspendre aussi les MP entre membres (non par défaut)'))
        .addIntegerOption((o) => hoursOption(o, 'Durée de chaque suspension (6 heures par défaut)'))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return runStatus(interaction, client);
    if (sub === 'enable') {
      const raw = interaction.options.getString('duree');
      return runEnable(interaction, client, raw ? timedDuration(raw, parseDuration) : null);
    }
    if (sub === 'disable') return runDisable(interaction, client);
    assertAdmin(interaction);
    if (sub === 'suspendre') return runPause(interaction, client);
    if (sub === 'reprendre') {
      return runResume(interaction, client, {
        invites: interaction.options.getBoolean('invitations') ?? true,
        dms: interaction.options.getBoolean('messages_prives') ?? true,
      });
    }
    if (sub === 'riposte') return runRiposte(interaction, client);
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
    /** cmd:lockdown:resume:<invites|dms|all> — rétablit les invitations et/ou les MP ; Administrateur. */
    async resume(interaction, client, [target]) {
      assertAdmin(interaction);
      const which = Object.hasOwn(RESUME_TARGETS, target) ? RESUME_TARGETS[target] : null;
      if (!which) throw new UserError('Ce bouton est invalide.');
      return runResume(interaction, client, which);
    },
  },
};
