'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { card, field, wide, ICONS, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');
const { requirePermission } = require('../../services/ModerationService');
const { RETENTION } = require('../../services/ActivityService');
const A = require('../../utils/activity');

/**
 * /statistiques : statistiques du serveur (éphémère). Lecture réservée à « Gérer le serveur »,
 * sauf si un administrateur les rend publiques (stats.public) ; chacun peut voir les siennes.
 * Vues (menu) : serveur · salons · membres · heures · croissance · reglages (+ wipe : confirmation).
 * La période (7, 30 ou 90 jours) est le bouton de période désactivé du message.
 */

const SECTION = { emoji: '📊', label: 'Statistiques' };
const PERIODS = [7, 30, 90];
const DEFAULT_PERIOD = 30;
const RETENTION_CHOICES = [7, 14, 30, 60, 90, 180, 365];
const SNOWFLAKE = /^\d{17,20}$/;

const VIEWS = [
  { value: 'serveur', label: 'Serveur', emoji: ICONS.server, description: 'Messages par jour, arrivées, départs, membres actifs' },
  { value: 'salons', label: 'Salons', emoji: ICONS.channel, description: 'Salons les plus actifs (texte et vocal)' },
  { value: 'membres', label: 'Membres', emoji: ICONS.members, description: 'Membres les plus actifs (texte et vocal)' },
  { value: 'heures', label: 'Heures de pointe', emoji: ICONS.time, description: 'Messages par heure (UTC)' },
  { value: 'croissance', label: 'Croissance', emoji: '📈', description: 'Nombre de membres jour par jour' },
];
const SETTINGS_VIEW = { value: 'reglages', label: 'Réglages', emoji: ICONS.settings, description: 'Collecte, accès, conservation des données' };
const VIEW_KEYS = new Set([...VIEWS.map((v) => v.value), SETTINGS_VIEW.value, 'wipe']);
const MANAGER_VIEWS = new Set(['reglages', 'wipe']);

const row = (component) => new ActionRowBuilder().addComponents(component);
const isManager = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
const statsOf = (client, guildId) => client.services.config.get(guildId).stats ?? {};

/**
 * Salons visibles par @everyone (fils exclus : leurs messages comptent pour leur salon).
 * Un lecteur sans « Gérer le serveur » ne voit les chiffres QUE de ces salons. Pur.
 * @returns {string[]}
 */
function publicChannels(guild) {
  const everyone = guild?.roles?.everyone ?? guild?.roles?.cache?.get?.(guild?.id);
  const channels = guild?.channels?.cache;
  if (!everyone || !channels?.values) return [];
  return [...channels.values()].filter((c) => !c.isThread?.() && c.permissionsFor?.(everyone)?.has?.(PermissionFlagsBits.ViewChannel)).map((c) => c.id);
}

/**
 * Lecteur d'une vue : gestionnaire (tout) ou non (salons visibles par @everyone pour les
 * chiffres, et seulement les salons que LUI peut voir dans les listes de salons).
 * @param {{ member?: object|null, refresh?: boolean }} [opts]
 */
function makeReader(guild, manager, { member = null, refresh = false } = {}) {
  if (manager) return { manager: true, scope: null, scopeKey: 'all', canSee: () => true, refresh };
  const scope = publicChannels(guild);
  const visible = new Set(scope);
  const canSee = (id) => {
    if (!visible.has(id)) return false;
    const channel = guild?.channels?.cache?.get?.(id);
    const perms = member && channel?.permissionsFor ? channel.permissionsFor(member) : null;
    return perms ? perms.has(PermissionFlagsBits.ViewChannel) : true;
  };
  return { manager: false, scope, scopeKey: 'public', canSee, refresh };
}

/** Lecteur d'une interaction (« Actualiser » ne recalcule que pour un gestionnaire). */
function readerOf(interaction, { refresh = false } = {}) {
  const manager = isManager(interaction);
  return makeReader(interaction.guild, manager, { member: interaction.member, refresh: refresh && manager });
}

/** Données d'une vue, en cache 60 s par (serveur, vue, période, portée du lecteur). */
function viewData(client, guild, reader, key, compute) {
  const activity = client.services.activity;
  const fullKey = `${guild.id}:${key}:${reader.scopeKey}`;
  return activity.cachedView ? activity.cachedView(fullKey, compute, { refresh: reader.refresh }) : compute();
}

/** Délai entre deux clics (navigation, actualisation) d'un lecteur sans « Gérer le serveur ». */
function assertViewCooldown(interaction, client) {
  if (isManager(interaction)) return;
  const left = client.services.activity.takeViewCooldown?.(interaction.guildId, interaction.user.id) ?? 0;
  if (left > 0) throw new UserError(`Patientez **${Math.ceil(left / 1000)} s** avant de changer de vue ou d'actualiser les statistiques.`);
}

/**
 * Lecture autorisée ? « Gérer le serveur », statistiques publiques, ou ses propres statistiques.
 * @param {string} [selfId] membre consulté (vue « membre »)
 */
function assertRead(interaction, client, selfId) {
  if (isManager(interaction)) return;
  if (statsOf(client, interaction.guildId).public) return;
  if (selfId && selfId === interaction.user.id) return;
  throw new UserError('Les statistiques de ce serveur sont réservées à l\'équipe (permission **Gérer le serveur**). Vous pouvez consulter les vôtres avec `/statistiques membre`.');
}

function parsePeriod(raw) {
  const n = Number(raw);
  return PERIODS.includes(n) ? n : DEFAULT_PERIOD;
}

/** Période affichée par un message : son bouton de période désactivé. */
function periodOfMessage(message) {
  for (const r of message?.components ?? []) {
    for (const c of r.components ?? []) {
      const id = c.customId ?? c.custom_id ?? c.data?.custom_id ?? '';
      const m = /^cmd:statistiques:(?:go|member):[^:]+:(\d+)$/.exec(id);
      if (m && (c.disabled ?? c.data?.disabled)) return parsePeriod(m[1]);
    }
  }
  return DEFAULT_PERIOD;
}

// ---------------------------------------------------------------- composants

function navRow(current, manager) {
  const options = [...VIEWS, ...(manager ? [SETTINGS_VIEW] : [])];
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:statistiques:nav')
      .setPlaceholder('Changer de vue…')
      .addOptions(options.map((o) => ({ ...o, default: o.value === current }))),
  );
}

/** Boutons de période (celui en cours est désactivé) + actualiser. */
function periodButtons(action, target, period) {
  return [
    ...PERIODS.map((p) => actionButton({
      command: 'statistiques',
      action,
      args: [target, p],
      label: `${p} jours`,
      emoji: ICONS.date,
      style: p === period ? ButtonStyle.Primary : ButtonStyle.Secondary,
      disabled: p === period,
    })),
    actionButton({ command: 'statistiques', action, args: [target, period, 'r'], label: 'Actualiser', emoji: ICONS.refresh }),
  ];
}

// ---------------------------------------------------------------- données

/** En-tête commun : début de la collecte, état. */
function collectionLine(client, guild) {
  const activity = client.services.activity;
  if (!activity.collecting(guild.id)) return `${ICONS.warning} La collecte est **désactivée** : les chiffres ne progressent plus.`;
  const since = activity.since(guild.id);
  return subtext(since ? `Collecte depuis le ${discordTimestamp(since, 'D')} · jours et heures en UTC · bots et salons ignorés des logs exclus` : 'La collecte vient de démarrer : les chiffres se rempliront au fil de l\'activité.');
}

/** Membres connus (nom lisible) ou mention par identifiant. */
const mention = (id) => `<@${id}>`;
const channelMention = (id) => `<#${id}>`;

function emptyNote(totals) {
  return totals.messages || totals.voice ? null : `\n${ICONS.info} Aucune activité enregistrée sur cette période pour l'instant.`;
}

// ---------------------------------------------------------------- vues

function serverView(client, guild, period, now, manager, notice, reader) {
  const span = Math.max(period, 30);
  const days = A.lastDays(span, now);
  const from = A.addDays(A.dayKey(now), -(period - 1));
  const { series, totals, flows } = viewData(client, guild, reader, `serveur:${period}:${A.dayKey(now)}`, () => {
    const repo = client.services.activity.read();
    return { series: A.fillSeries(repo.daily(guild.id, days[0], reader.scope), days), totals: repo.totals(guild.id, from, reader.scope), flows: repo.flows(guild.id, from) };
  });
  const joins = flows.reduce((n, f) => n + f.joins, 0);
  const leaves = flows.reduce((n, f) => n + f.leaves, 0);
  const periodSeries = series.slice(-period);
  const best = periodSeries.reduce((b, v, i) => (v > b.v ? { v, i } : b), { v: 0, i: -1 });
  const bestDay = best.i >= 0 ? A.formatDay(days[days.length - period + best.i]) : null;
  const line = (n) => {
    const values = series.slice(-n);
    return `**${n} j** \`${A.sparkline(values)}\` **${A.fr(values.reduce((a, b) => a + b, 0))}**`;
  };
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.server,
        title: `Statistiques · ${guild.name}`,
        description: [
          notice ? `${notice}\n` : null,
          `Sur les **${period} derniers jours** : **${A.fr(totals.messages)}** message(s), **${A.fr(totals.members)}** membre(s) actif(s), **${A.formatVoice(totals.voice)}** de vocal.`,
          emptyNote(totals),
          '',
          '**Messages par jour**',
          line(7),
          line(30),
          period === 90 ? line(90) : null,
          '',
          collectionLine(client, guild),
        ],
        fields: [
          field('📨', 'Messages', `**${A.fr(totals.messages)}**\n${A.perDay(totals.messages, period)} / jour`),
          field(ICONS.members, 'Membres actifs', `**${A.fr(totals.members)}**\nmessage ou vocal`),
          field(ICONS.voice, 'Vocal', `**${A.formatVoice(totals.voice)}**`),
          field('📥', 'Arrivées', `**${A.fr(joins)}**`),
          field('📤', 'Départs', `**${A.fr(leaves)}**`),
          field('⚖️', 'Solde', `**${A.signed(joins - leaves)}**`),
          field(ICONS.star, 'Jour record', bestDay ? `${bestDay}\n**${A.fr(best.v)}** messages` : '*Aucun*'),
          field(ICONS.channel, 'Salons actifs', `**${A.fr(totals.channels)}**`),
          field(ICONS.members, 'Membres', `**${A.fr(guild.memberCount)}**`),
        ],
        footer: `Période : ${period} jours`,
      }),
    ],
    components: [navRow('serveur', manager), ...buttonRows(periodButtons('go', 'serveur', period))],
  };
}

function channelsView(client, guild, period, now, manager, reader) {
  const from = A.addDays(A.dayKey(now), -(period - 1));
  const data = viewData(client, guild, reader, `salons:${period}:${A.dayKey(now)}`, () => {
    const repo = client.services.activity.read();
    // Marge (15 / 10) : les salons que ce lecteur ne voit pas sont retirés ensuite.
    return { totals: repo.sums(guild.id, from, reader.scope), text: repo.topChannels(guild.id, from, 15, reader.scope), voice: repo.topVoiceChannels(guild.id, from, 10, reader.scope) };
  });
  const totals = data.totals;
  const text = data.text.filter((c) => reader.canSee(c.channel_id)).slice(0, 10);
  const voice = data.voice.filter((c) => reader.canSee(c.channel_id)).slice(0, 5);
  const textLines = text.map((c, i) => `**${i + 1}.** ${channelMention(c.channel_id)} · **${A.fr(c.messages)}** msg · ${A.percent(c.messages, totals.messages)} · ${A.fr(c.members)} membre(s)`);
  const voiceLines = voice.map((c, i) => `**${i + 1}.** ${channelMention(c.channel_id)} · **${A.formatVoice(c.voice)}** · ${A.fr(c.members)} membre(s)`);
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.channel,
        title: 'Statistiques · Salons les plus actifs',
        description: [
          `Sur les **${period} derniers jours**. Les messages d'un fil comptent pour son salon.`,
          emptyNote(totals),
          '',
          collectionLine(client, guild),
        ],
        fields: [
          wide('💬', 'Salons textuels', textLines.join('\n') || '*Aucun message*'),
          wide(ICONS.voice, 'Salons vocaux', voiceLines.join('\n') || '*Aucun temps de vocal*'),
        ],
        footer: `Période : ${period} jours`,
      }),
    ],
    components: [navRow('salons', manager), ...buttonRows(periodButtons('go', 'salons', period))],
  };
}

function membersView(client, guild, period, now, manager, reader) {
  const from = A.addDays(A.dayKey(now), -(period - 1));
  const { totals, text, voice } = viewData(client, guild, reader, `membres:${period}:${A.dayKey(now)}`, () => {
    const repo = client.services.activity.read();
    return { totals: repo.totals(guild.id, from, reader.scope), text: repo.topMembers(guild.id, from, 10, reader.scope), voice: repo.topVoiceMembers(guild.id, from, 5, reader.scope) };
  });
  const textLines = text.map((m, i) => `**${i + 1}.** ${mention(m.user_id)} · **${A.fr(m.messages)}** msg${m.voice ? ` · ${ICONS.voice} ${A.formatVoice(m.voice)}` : ''}`);
  const voiceLines = voice.map((m, i) => `**${i + 1}.** ${mention(m.user_id)} · **${A.formatVoice(m.voice)}**${m.messages ? ` · ${A.fr(m.messages)} msg` : ''}`);
  return {
    embeds: [
      card({
        tone: 'gold',
        section: SECTION,
        icon: ICONS.members,
        title: 'Statistiques · Membres les plus actifs',
        description: [
          `Sur les **${period} derniers jours** : **${A.fr(totals.members)}** membre(s) actif(s).`,
          emptyNote(totals),
          '',
          collectionLine(client, guild),
        ],
        fields: [
          wide('💬', 'Messages', textLines.join('\n') || '*Aucun message*'),
          wide(ICONS.voice, 'Vocal', voiceLines.join('\n') || '*Aucun temps de vocal*'),
        ],
        footer: `Période : ${period} jours`,
      }),
    ],
    components: [navRow('membres', manager), ...buttonRows(periodButtons('go', 'membres', period))],
  };
}

function hoursView(client, guild, period, now, manager, reader) {
  const from = A.addDays(A.dayKey(now), -(period - 1));
  const values = Array.from({ length: 24 }, () => 0);
  // Heures de pointe : compteurs par heure, sans dimension salon (aucun salon n'y est nommé).
  const rows = viewData(client, guild, reader, `heures:${period}:${A.dayKey(now)}`, () => client.services.activity.read().hourly(guild.id, from));
  for (const r of rows) if (r.hour >= 0 && r.hour < 24) values[r.hour] = Number(r.messages) || 0;
  const total = values.reduce((a, b) => a + b, 0);
  const peak = values.reduce((b, v, h) => (v > values[b] ? h : b), 0);
  const quiet = values.reduce((b, v, h) => (v < values[b] ? h : b), 0);
  const h = (n) => `${String(n).padStart(2, '0')} h`;
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.time,
        title: 'Statistiques · Heures de pointe',
        description: [
          `Messages par heure (**UTC**) sur les **${period} derniers jours**.`,
          total ? `\`${A.sparkline(values)}\` de 00 h à 23 h` : `\n${ICONS.info} Aucun message enregistré sur cette période pour l'instant.`,
          total ? `\`\`\`\n${A.hourHistogram(values).join('\n')}\n\`\`\`` : null,
          collectionLine(client, guild),
        ],
        fields: total
          ? [
            field('🔥', 'Heure de pointe', `**${h(peak)}–${h((peak + 1) % 24)}**\n${A.fr(values[peak])} msg · ${A.percent(values[peak], total)}`),
            field('🌙', 'Heure la plus calme', `**${h(quiet)}–${h((quiet + 1) % 24)}**\n${A.fr(values[quiet])} msg`),
            field('📨', 'Messages', `**${A.fr(total)}**`),
          ]
          : [],
        footer: `Période : ${period} jours · heures UTC`,
      }),
    ],
    components: [navRow('heures', manager), ...buttonRows(periodButtons('go', 'heures', period))],
  };
}

function growthView(client, guild, period, now, manager, reader) {
  const activity = client.services.activity;
  const since = activity.since(guild.id);
  let days = A.lastDays(period, now);
  // Avant la collecte, les flux sont inconnus : la courbe commence au premier jour collecté.
  if (since) days = days.filter((d) => d >= A.dayKey(since));
  const rows = viewData(client, guild, reader, `croissance:${period}:${days[0] ?? ''}:${A.dayKey(now)}`, () => activity.read().flows(guild.id, days[0] ?? A.dayKey(now)));
  const map = new Map(rows.map((r) => [r.day, r]));
  const flows = days.map((d) => ({ joins: map.get(d)?.joins ?? 0, leaves: map.get(d)?.leaves ?? 0 }));
  const members = A.reconstructMembers(guild.memberCount, flows);
  const joins = flows.reduce((n, f) => n + f.joins, 0);
  const leaves = flows.reduce((n, f) => n + f.leaves, 0);
  const start = members.length ? members[0] - flows[0].joins + flows[0].leaves : guild.memberCount;
  const bestJoin = flows.reduce((b, f, i) => (f.joins > b.v ? { v: f.joins, i } : b), { v: 0, i: -1 });
  return {
    embeds: [
      card({
        tone: joins - leaves >= 0 ? 'success' : 'caution',
        section: SECTION,
        icon: '📈',
        title: 'Statistiques · Croissance',
        description: [
          `Membres jour par jour sur les **${days.length} dernier(s) jour(s)** collecté(s), reconstruits depuis les arrivées et départs.`,
          '',
          `**Membres** \`${A.sparkline(members)}\``,
          `**Arrivées** \`${A.sparkline(flows.map((f) => f.joins))}\``,
          `**Départs** \`${A.sparkline(flows.map((f) => f.leaves))}\``,
          '',
          subtext('Total actuel compté par Discord (bots compris) ; arrivées et départs des bots non suivis.'),
          collectionLine(client, guild),
        ],
        fields: [
          field('🏁', 'Début de période', `**${A.fr(Math.max(0, start))}**`),
          field(ICONS.members, 'Aujourd\'hui', `**${A.fr(guild.memberCount)}**`),
          field('⚖️', 'Solde', `**${A.signed(joins - leaves)}**`),
          field('📥', 'Arrivées', `**${A.fr(joins)}**`),
          field('📤', 'Départs', `**${A.fr(leaves)}**`),
          field(ICONS.star, 'Meilleur jour', bestJoin.i >= 0 ? `${A.formatDay(days[bestJoin.i])}\n**+${A.fr(bestJoin.v)}**` : '*Aucun*'),
        ],
        footer: `Période : ${period} jours`,
      }),
    ],
    components: [navRow('croissance', manager), ...buttonRows(periodButtons('go', 'croissance', period))],
  };
}

function settingsView(client, guild, notice) {
  const activity = client.services.activity;
  const stats = statsOf(client, guild.id);
  const on = activity.collecting(guild.id);
  const retention = activity.retention(guild.id);
  const since = activity.since(guild.id);
  return {
    embeds: [
      card({
        tone: on ? 'success' : 'neutral',
        section: SECTION,
        icon: ICONS.settings,
        title: 'Statistiques · Réglages',
        description: [
          notice ? `${notice}\n` : null,
          'Le bot compte les **messages** (par jour, heure, salon et membre), le **temps de vocal** et les **arrivées/départs**. Aucun contenu n\'est enregistré.',
          subtext('Bots, webhooks et salons ignorés des logs (/logs) ne sont pas comptés. Les compteurs sont écrits toutes les 30 secondes.'),
        ],
        fields: [
          field(ICONS.status, 'Collecte', on ? '🟢 Active' : '🔴 Désactivée'),
          field(ICONS.visible, 'Lecture', stats.public ? '👥 Tout le monde' : `${ICONS.lock} Gérer le serveur`),
          field(ICONS.duration, 'Conservation', `**${retention}** jours`),
          field(ICONS.date, 'Collecte depuis', since ? `${discordTimestamp(since, 'D')}\n${discordTimestamp(since, 'R')}` : '*Pas encore commencée*'),
        ],
        footer: 'Réactiver la collecte redémarre le décompte des membres inactifs',
      }),
    ],
    components: [
      navRow('reglages', true),
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:statistiques:retention')
          .setPlaceholder('Durée de conservation…')
          .addOptions(RETENTION_CHOICES.map((d) => ({ value: String(d), label: `Conserver ${d} jours`, emoji: '🗓️', default: d === retention }))),
      ),
      ...buttonRows(
        on
          ? actionButton({ command: 'statistiques', action: 'collect', args: ['off'], label: 'Couper la collecte', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'statistiques', action: 'collect', args: ['on'], label: 'Activer la collecte', emoji: '🟢', style: ButtonStyle.Success }),
        stats.public
          ? actionButton({ command: 'statistiques', action: 'access', args: ['off'], label: 'Réserver à l\'équipe', emoji: ICONS.lock })
          : actionButton({ command: 'statistiques', action: 'access', args: ['on'], label: 'Rendre publiques', emoji: '👥' }),
        actionButton({ command: 'statistiques', action: 'go', args: ['wipe', DEFAULT_PERIOD], label: 'Effacer les données', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      ),
    ],
  };
}

function wipeView() {
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Effacer toutes les statistiques ?',
        description: [
          'Messages par jour, heures, vocal, arrivées et départs du serveur seront **définitivement supprimés**.',
          subtext('Si la collecte est active, elle repart de zéro : les actions groupées de /activite seront bloquées le temps de recollecter.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'statistiques', action: 'wipe', label: 'Oui, tout effacer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'statistiques', action: 'go', args: ['reglages', DEFAULT_PERIOD], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

/**
 * Vue du serveur.
 * @param {{ view?: string, period?: number, manager?: boolean, now?: number, notice?: string }} [opts]
 */
function render(client, guild, { view = 'serveur', period = DEFAULT_PERIOD, manager = false, now = Date.now(), notice, reader = null } = {}) {
  const r = reader ?? makeReader(guild, manager);
  switch (view) {
    case 'salons':
      return channelsView(client, guild, period, now, manager, r);
    case 'membres':
      return membersView(client, guild, period, now, manager, r);
    case 'heures':
      return hoursView(client, guild, period, now, manager, r);
    case 'croissance':
      return growthView(client, guild, period, now, manager, r);
    case 'reglages':
      return settingsView(client, guild, notice);
    case 'wipe':
      return wipeView();
    default:
      return serverView(client, guild, period, now, manager, notice, r);
  }
}

/**
 * Vue d'un membre : messages par jour, salons favoris, vocal, rang.
 * @param {{ id: string, username?: string, toString(): string }} user
 * @param {import('discord.js').GuildMember|null} member
 */
function renderMember(client, guild, user, member, { period = DEFAULT_PERIOD, now = Date.now(), canSeeServer = false, reader = null, manager = false } = {}) {
  const r = reader ?? makeReader(guild, manager);
  const days = A.lastDays(period, now);
  const data = viewData(client, guild, r, `membre:${user.id}:${period}:${A.dayKey(now)}`, () => {
    const repo = client.services.activity.read();
    const daily = repo.memberDaily(guild.id, user.id, days[0], r.scope);
    const sum = daily.reduce((n, d) => n + (Number(d.messages) || 0), 0);
    return {
      daily,
      // Marge : les salons que ce lecteur ne voit pas sont retirés ensuite.
      channels: repo.memberChannels(guild.id, user.id, days[0], 10, r.scope),
      lastDay: repo.memberLastDay(guild.id, user.id, r.scope),
      rank: sum ? repo.rank(guild.id, days[0], sum, r.scope) : null,
    };
  });
  const messages = A.fillSeries(data.daily, days);
  const voice = A.fillSeries(data.daily, days, 'voice');
  const totalMessages = messages.reduce((a, b) => a + b, 0);
  const totalVoice = voice.reduce((a, b) => a + b, 0);
  const activeDays = days.filter((_, i) => messages[i] || voice[i]).length;
  const channels = data.channels.filter((c) => r.canSee(c.channel_id)).slice(0, 5);
  const lastDay = data.lastDay;
  const rank = totalMessages ? data.rank : null;
  const channelLines = channels.map((c, i) => `**${i + 1}.** ${channelMention(c.channel_id)} · ${[c.messages ? `**${A.fr(c.messages)}** msg` : null, c.voice ? `${ICONS.voice} ${A.formatVoice(c.voice)}` : null].filter(Boolean).join(' · ')}`);
  const name = member?.displayName ?? user.globalName ?? user.username ?? 'Membre';
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.user,
        title: `Statistiques · ${name}`,
        description: [
          `${user} sur les **${period} derniers jours**.`,
          '',
          `**Messages par jour** \`${A.sparkline(messages)}\``,
          totalVoice ? `**Vocal par jour** \`${A.sparkline(voice)}\`` : null,
          !totalMessages && !totalVoice ? `\n${ICONS.info} Aucune activité enregistrée sur cette période.` : null,
          '',
          collectionLine(client, guild),
        ],
        thumbnail: (member ?? user).displayAvatarURL?.({ size: 128 }) ?? null,
        fields: [
          field('📨', 'Messages', `**${A.fr(totalMessages)}**\n${A.perDay(totalMessages, period)} / jour`),
          field(ICONS.voice, 'Vocal', `**${A.formatVoice(totalVoice)}**`),
          field(ICONS.star, 'Rang (messages)', rank ? `**#${A.fr(rank)}**` : '—'),
          field(ICONS.date, 'Jours actifs', `**${activeDays}** / ${period}`),
          field(ICONS.time, 'Dernière activité', lastDay ? A.formatDay(lastDay) : '*Aucune*'),
          field('📥', 'Arrivée', member?.joinedTimestamp ? discordTimestamp(member.joinedTimestamp, 'D') : '*Hors du serveur*'),
          wide('💬', 'Salons favoris', channelLines.join('\n') || '*Aucun*'),
        ],
        footer: `Période : ${period} jours · ID : ${user.id}`,
      }),
    ],
    components: buttonRows(
      periodButtons('member', user.id, period),
      canSeeServer ? actionButton({ command: 'statistiques', action: 'go', args: ['serveur', period], label: 'Serveur', emoji: ICONS.server }) : null,
    ),
  };
}

/** Utilisateur consulté par un bouton (identifiant validé, récupéré au besoin). */
async function resolveUser(client, guild, userId) {
  if (!SNOWFLAKE.test(userId ?? '')) throw new UserError('Ce bouton est invalide.');
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const user = member?.user ?? (await client.users.fetch(userId).catch(() => null));
  if (!user) throw new UserError('Ce membre est introuvable.');
  return { user, member };
}

const target = (state) => {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
};

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'information',
  cooldown: 3_000,
  render,
  makeReader,
  publicChannels,
  renderMember,
  periodOfMessage,
  data: new SlashCommandBuilder()
    .setName('statistiques')
    .setDescription('Statistiques du serveur : messages, vocal, arrivées, heures de pointe, croissance.')
    .addSubcommand((s) =>
      s
        .setName('serveur')
        .setDescription('Tableau de bord des statistiques du serveur.')
        .addStringOption((o) => o.setName('vue').setDescription('Vue à ouvrir (par défaut : serveur)').addChoices(...VIEWS.map((v) => ({ name: v.label, value: v.value }))))
        .addIntegerOption((o) => o.setName('periode').setDescription('Période couverte, en jours (par défaut : 30)').addChoices(...PERIODS.map((p) => ({ name: `${p} jours`, value: p })))),
    )
    .addSubcommand((s) =>
      s
        .setName('membre')
        .setDescription('Activité d\'un membre : messages par jour, salons favoris, vocal.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre à consulter (par défaut : vous)'))
        .addIntegerOption((o) => o.setName('periode').setDescription('Période couverte, en jours (par défaut : 30)').addChoices(...PERIODS.map((p) => ({ name: `${p} jours`, value: p })))),
    )
    .addSubcommand((s) => s.setName('reglages').setDescription('Collecte, accès et durée de conservation des statistiques (Gérer le serveur).')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand(false) ?? 'serveur';
    const period = parsePeriod(interaction.options.getInteger('periode') ?? DEFAULT_PERIOD);
    if (sub === 'reglages') {
      requirePermission(interaction, 'ManageGuild');
      return interaction.reply({ ...render(client, interaction.guild, { view: 'reglages', manager: true }), ephemeral: true });
    }
    if (sub === 'membre') {
      const user = interaction.options.getUser('membre') ?? interaction.user;
      assertRead(interaction, client, user.id);
      if (user.bot) throw new UserError('Les bots ne sont pas comptés dans les statistiques.');
      const member = interaction.options.getMember('membre') ?? interaction.guild.members.cache.get(user.id) ?? null;
      const canSeeServer = isManager(interaction) || Boolean(statsOf(client, interaction.guildId).public);
      // Requêtes potentiellement longues sur un gros serveur : on acquitte d'abord.
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply(renderMember(client, interaction.guild, user, member, { period, canSeeServer, reader: readerOf(interaction) }));
    }
    assertRead(interaction, client);
    const view = interaction.options.getString('vue') ?? 'serveur';
    if (!VIEWS.some((v) => v.value === view)) throw new UserError('Vue inconnue.');
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply(render(client, interaction.guild, { view, period, manager: isManager(interaction), reader: readerOf(interaction) }));
  },

  buttons: {
    /** Menu de navigation (la période est celle du message). */
    async nav(interaction, client) {
      const view = interaction.values?.[0] ?? 'serveur';
      if (!VIEW_KEYS.has(view)) throw new UserError('Vue inconnue.');
      if (MANAGER_VIEWS.has(view)) requirePermission(interaction, 'ManageGuild');
      else assertRead(interaction, client);
      assertViewCooldown(interaction, client);
      // Calcul potentiellement long (gros serveur, cache expiré) : on acquitte d'abord.
      await interaction.deferUpdate();
      await interaction.editReply(render(client, interaction.guild, { view, period: periodOfMessage(interaction.message), manager: isManager(interaction), reader: readerOf(interaction) }));
    },
    /** cmd:statistiques:go:<vue>:<période>[:r] — « r » : actualiser (recalcul pour un gestionnaire). */
    async go(interaction, client, [view, period, flag]) {
      if (!VIEW_KEYS.has(view)) throw new UserError('Vue inconnue.');
      if (MANAGER_VIEWS.has(view)) requirePermission(interaction, 'ManageGuild');
      else assertRead(interaction, client);
      assertViewCooldown(interaction, client);
      await interaction.deferUpdate();
      await interaction.editReply(render(client, interaction.guild, { view, period: parsePeriod(period), manager: isManager(interaction), reader: readerOf(interaction, { refresh: flag === 'r' }) }));
    },
    /** cmd:statistiques:member:<userId>:<période>[:r] */
    async member(interaction, client, [userId, period, flag]) {
      if (!SNOWFLAKE.test(userId ?? '')) throw new UserError('Ce bouton est invalide.');
      assertRead(interaction, client, userId);
      assertViewCooldown(interaction, client);
      // Le membre peut devoir être récupéré (hors cache) : on acquitte d'abord.
      await interaction.deferUpdate();
      const { user, member } = await resolveUser(client, interaction.guild, userId);
      const canSeeServer = isManager(interaction) || Boolean(statsOf(client, interaction.guildId).public);
      await interaction.editReply(renderMember(client, interaction.guild, user, member, { period: parsePeriod(period), canSeeServer, reader: readerOf(interaction, { refresh: flag === 'r' }) }));
    },
    /** Durée de conservation (menu). */
    async retention(interaction, client) {
      requirePermission(interaction, 'ManageGuild');
      const days = Number(interaction.values?.[0]);
      if (!RETENTION_CHOICES.includes(days) || days < RETENTION.min || days > RETENTION.max) throw new UserError('Durée de conservation invalide.');
      client.services.config.update(interaction.guildId, { stats: { retentionDays: days } });
      await interaction.update(render(client, interaction.guild, {
        view: 'reglages',
        manager: true,
        notice: `${ICONS.success} Les statistiques seront conservées **${days} jours** (les plus anciennes sont supprimées chaque jour).`,
      }));
    },
    /** cmd:statistiques:collect:<on|off> */
    async collect(interaction, client, [state]) {
      requirePermission(interaction, 'ManageGuild');
      const enabled = target(state);
      client.services.activity.setCollecting(interaction.guildId, enabled);
      await interaction.update(render(client, interaction.guild, {
        view: 'reglages',
        manager: true,
        notice: enabled ? `${ICONS.success} Collecte **activée** : le décompte des membres inactifs repart d'aujourd'hui.` : `${ICONS.success} Collecte **désactivée** : les données existantes sont conservées jusqu'à leur expiration.`,
      }));
    },
    /** cmd:statistiques:access:<on|off> — lecture publique ou réservée. */
    async access(interaction, client, [state]) {
      requirePermission(interaction, 'ManageGuild');
      const on = target(state);
      client.services.config.update(interaction.guildId, { stats: { public: on } });
      await interaction.update(render(client, interaction.guild, {
        view: 'reglages',
        manager: true,
        notice: on ? `${ICONS.success} Statistiques **publiques** : tout le monde peut utiliser /statistiques.` : `${ICONS.success} Statistiques **réservées** à la permission « Gérer le serveur ».`,
      }));
    },
    /** cmd:statistiques:wipe — après confirmation. */
    async wipe(interaction, client) {
      requirePermission(interaction, 'ManageGuild');
      const n = client.services.activity.wipe(interaction.guildId);
      await interaction.update(render(client, interaction.guild, { view: 'reglages', manager: true, notice: `${ICONS.success} Statistiques effacées (${A.fr(n)} ligne(s)).` }));
    },
  },
};
