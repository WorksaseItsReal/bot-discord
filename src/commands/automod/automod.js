'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');
const { truncate, progressBar } = require('../../utils/embeds');
const { card, field, wide, ICONS, code, status, actionButton, buttonRows, ButtonStyle, subtext, bullets, userLine } = require('../../utils/ui');
const { parseDuration } = require('../../utils/time');
const { fitList } = require('../../services/LoggingService');
const { requirePermission, needPermission, settleComponents, historyButton } = require('../../services/ModerationService');
const { BUILTIN_ALLOWED_HOSTS, QUARANTINE_ROLES_FIELD } = require('../../services/AutoModService');
const { snowflake } = require('../../utils/buttonGuard');
const { variants } = require('../../utils/automod/normalize');
const { phishingScore } = require('../../utils/automod/phishing');
const { extractLinks, hostMatches } = require('../../utils/automod/links');
const { isValidWord, matchingWords } = require('../../utils/automod/words');
const { PRESETS } = require('../../utils/automod/presets');
const native = require('../../services/NativeAutoMod');
const { UserError } = require('../../core/errors');

/**
 * /automod : UN tableau de bord interactif (éphémère) pour TOUT configurer.
 * Navigation par menu, réglages par boutons, menus et formulaires ; chaque
 * interaction met à jour le même message. « Gérer le serveur » est revérifiée
 * à chaque clic.
 *
 * Vues : home · grp:<security|spam|content> · filter:<clé> · lists · escalation ·
 *        newmembers · notify · native · presets · stats:<jours>
 *
 * Boutons des logs AutoMod (même commande) : « Faux positif » (fp, puis fpfix / fpdm
 * dans la vue éphémère) et quarantaine d'un compte piraté (qlift, qban → qbanok / qcancel).
 */

// ---------------------------------------------------------------- métadonnées

const FILTER_LABELS = {
  antiSpam: 'Anti-spam',
  antiFlood: 'Anti-flood',
  antiLink: 'Anti-liens',
  antiInvite: 'Anti-invitations',
  antiMassMention: 'Mentions de masse',
  antiCaps: 'Majuscules',
  badWords: 'Mots interdits',
  antiRepeat: 'Répétitions',
  antiEmojiSpam: 'Spam d\'emojis',
  antiDuplicate: 'Doublons',
  antiPhishing: 'Anti-arnaques',
  antiCrossChannel: 'Spam multi-salons',
  antiWall: 'Pavés de texte',
  antiZalgo: 'Texte zalgo',
  antiHacked: 'Compte piraté',
};
const FILTERS = Object.keys(FILTER_LABELS);

/** Ce que fait chaque filtre (affiché dans sa vue détaillée). */
const FILTER_INFO = {
  antiPhishing: 'Repère les liens d\'arnaque : faux domaines Discord/Steam, punycode, liens raccourcis, appâts « Nitro gratuit ».',
  antiCrossChannel: 'Repère le même message posté dans plusieurs salons en peu de temps : signe typique d\'un compte piraté. Toutes les copies sont supprimées.',
  antiInvite: 'Bloque les invitations vers d\'autres serveurs, même masquées (« discord . gg / code »). Liste blanche disponible.',
  antiLink: 'Bloque les liens, avec ou sans « https:// ». Les GIF Discord/Tenor et la liste blanche restent autorisés.',
  antiSpam: 'Trop de messages en quelques secondes.',
  antiFlood: 'Rafale de messages sur une fenêtre plus longue.',
  antiDuplicate: 'Le même message envoyé deux fois de suite (30 s).',
  antiRepeat: 'Le même message répété 3 fois de suite.',
  antiMassMention: 'Trop de mentions dans un seul message (@everyone compris).',
  badWords: 'Mots interdits, résistant aux contournements (c0n, c.o.n, cooon, accents, lettres cyrilliques…). « mot* » bloque aussi les dérivés.',
  antiCaps: 'Messages majoritairement en MAJUSCULES.',
  antiEmojiSpam: 'Trop d\'emojis dans un message.',
  antiWall: 'Pavés de texte : trop de lignes ou trop de caractères.',
  antiZalgo: 'Texte « zalgo » illisible (diacritiques empilés).',
  antiHacked: 'Repère un compte piraté : mêmes fichiers ou même message dans plusieurs salons en peu de temps, ou lien d\'arnaque très probable. Quarantaine : timeout + suppression de ses messages récents partout.',
};

const GROUPS = {
  security: { label: 'Sécurité', emoji: '🛡️', description: 'Arnaques, comptes piratés, invitations, liens', filters: ['antiPhishing', 'antiHacked', 'antiCrossChannel', 'antiInvite', 'antiLink'] },
  spam: { label: 'Spam', emoji: '💬', description: 'Spam, flood, doublons, répétitions, mentions', filters: ['antiSpam', 'antiFlood', 'antiDuplicate', 'antiRepeat', 'antiMassMention'] },
  content: { label: 'Contenu', emoji: '✍️', description: 'Mots interdits, majuscules, emojis, pavés, zalgo', filters: ['badWords', 'antiCaps', 'antiEmojiSpam', 'antiWall', 'antiZalgo'] },
};
const groupOf = (filter) => Object.keys(GROUPS).find((g) => GROUPS[g].filters.includes(filter)) ?? 'security';

/** Seuil réglable par filtre : [clé de config, libellé, min, max]. */
const THRESHOLDS = {
  antiSpam: ['limit', 'messages', 2, 30],
  antiFlood: ['limit', 'messages', 2, 50],
  antiMassMention: ['limit', 'mentions', 2, 50],
  antiCaps: ['percent', '% de majuscules', 30, 100],
  antiEmojiSpam: ['limit', 'emojis', 2, 100],
  antiPhishing: ['threshold', 'points de suspicion', 1, 6],
  antiCrossChannel: ['channels', 'salons', 2, 10],
  antiWall: ['maxLines', 'lignes', 3, 100],
  antiHacked: ['channels', 'salons', 2, 10],
};
/** Fenêtre réglable (secondes) : [min, max]. */
const WINDOWS = { antiSpam: [2, 120], antiFlood: [5, 300], antiCrossChannel: [10, 600], antiHacked: [10, 600] };

const ACTION_LABELS = { delete: 'Suppression', warn: 'Avertissement', timeout: 'Timeout', kick: 'Expulsion', quarantine: 'Quarantaine' };
/** Sanctions proposées dans la vue d'un filtre (la quarantaine est propre à « Compte piraté »). */
const ACTION_OPTIONS = {
  delete: { emoji: '🗑️', description: 'Le message est retiré' },
  warn: { emoji: ICONS.warn, description: 'Retiré + avertissement (+1 strike)' },
  timeout: { emoji: ICONS.mute, description: 'Retiré + exclusion temporaire' },
  kick: { emoji: ICONS.kick, description: 'Retiré + expulsion du serveur' },
  quarantine: { emoji: ICONS.lock, description: 'Timeout + suppression de ses messages récents' },
};
const actionsFor = (key) => (key === 'antiHacked' ? ['quarantine', 'timeout', 'kick', 'delete'] : ['delete', 'warn', 'timeout', 'kick']);
/** Sanctions avec une durée de timeout. */
const TIMED = new Set(['timeout', 'quarantine']);
const NOTIFY_LABELS = { channel: 'Dans le salon (supprimé après 8 s)', dm: 'En message privé', none: 'Aucune' };
const MAX_IGNORED = 25;
/** Salons proposés dans les menus d'exemption (les fils suivent leur salon parent). */
const IGNORABLE_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice];

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble' },
  ...Object.entries(GROUPS).map(([key, g]) => ({ value: `grp:${key}`, label: `Filtres · ${g.label}`, emoji: g.emoji, description: g.description })),
  { value: 'lists', label: 'Listes', emoji: '📋', description: 'Mots interdits, domaines et invitations autorisés' },
  { value: 'escalation', label: 'Sanctions progressives', emoji: '📈', description: 'Sanction plus lourde en cas de récidive' },
  { value: 'newmembers', label: 'Nouveaux venus', emoji: '🐣', description: 'Restrictions des comptes récents' },
  { value: 'notify', label: 'Notifications & exemptions', emoji: '🔔', description: 'Prévenir le membre, salons et rôles ignorés' },
  { value: 'native', label: 'AutoMod de Discord', emoji: '🧱', description: 'Règles natives (actives même bot hors ligne)' },
  { value: 'presets', label: 'Préréglages', emoji: '🎚️', description: 'Faible, Équilibré ou Strict en un clic' },
  { value: 'stats:7', label: 'Statistiques', emoji: '📊', description: 'Infractions par filtre et par membre' },
];

// ---------------------------------------------------------------- helpers purs

/** « 🟢 **Anti-spam** · Timeout (5m) ». Pur. */
function filterLine(name, fc = {}) {
  const action = ACTION_LABELS[fc.action] ?? fc.action ?? ACTION_LABELS.delete;
  return `${fc.enabled ? '🟢' : '🔴'} **${FILTER_LABELS[name] ?? name}** · ${action}${TIMED.has(fc.action) && fc.duration ? ` (${fc.duration})` : ''}`;
}

function escalationText(esc) {
  if (!esc?.enabled) return '🔴 Désactivées';
  const steps = (esc.steps ?? []).map((s) => `${s.count}× → ${ACTION_LABELS[s.action] ?? s.action}${s.duration ? ` ${s.duration}` : ''}`);
  return `🟢 Sur ${esc.windowMinutes ?? 30} min\n${steps.join('\n')}`;
}

function newMembersText(nm) {
  if (!nm?.enabled) return '🔴 Désactivée';
  const blocked = [nm.blockLinks && 'liens', nm.blockInvites && 'invitations', nm.blockMedia && 'fichiers'].filter(Boolean);
  return `🟢 Compte < ${nm.accountAgeDays} j ou arrivé < ${nm.joinedMinutes} min\nBloque : ${blocked.join(', ') || 'rien'}`;
}

/**
 * « 3=timeout 10m, 5=timeout 1h, 8=kick » → paliers validés. Pur.
 * @returns {Array<{ count:number, action:string, duration:string|null }>}
 */
function parseSteps(text) {
  const steps = [];
  for (const raw of String(text ?? '').split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d{1,2})\s*[=:→>-]+\s*(timeout|kick|expulsion|exclusion)\s*(\S+)?$/i);
    if (!m) throw new UserError(`Palier invalide : « ${truncate(part, 40)} ». Format : \`3=timeout 10m\` ou \`8=kick\`.`);
    const count = Number(m[1]);
    const action = /^(kick|expulsion)$/i.test(m[2]) ? 'kick' : 'timeout';
    const duration = action === 'timeout' ? m[3] ?? '10m' : null;
    if (count < 2 || count > 50) throw new UserError('Chaque palier doit être entre 2 et 50 infractions.');
    if (action === 'timeout') {
      const ms = parseDuration(duration);
      if (!ms || ms > 28 * 86_400_000) throw new UserError(`Durée invalide « ${duration} » (ex : 10m, 1h, 1d ; 28 jours maximum).`);
    }
    steps.push({ count, action, duration });
  }
  if (!steps.length) throw new UserError('Indiquez au moins un palier.');
  if (steps.length > 5) throw new UserError('5 paliers maximum.');
  const counts = steps.map((s) => s.count);
  if (new Set(counts).size !== counts.length) throw new UserError('Deux paliers ne peuvent pas avoir le même nombre d\'infractions.');
  return steps.sort((a, b) => a.count - b.count);
}

const stepsToText = (steps = []) => steps.map((s) => `${s.count}=${s.action}${s.duration ? ` ${s.duration}` : ''}`).join(', ');

/** Découpe une saisie « a, b\nc » en éléments. Pur. */
const splitItems = (text) => String(text ?? '').split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);

/** Normalise un domaine saisi (« https://www.Site.com/x » → « site.com »). */
function cleanDomain(input) {
  const d = String(input ?? '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(d)) throw new UserError(`Domaine invalide : « ${truncate(input, 40)} ». Exemple : \`youtube.com\`.`);
  return d;
}

function cleanInvite(input) {
  const c = String(input ?? '').trim().replace(/^(https?:\/\/)?(www\.)?(discord\.gg|discord(app)?\.com\/invite)\//i, '').toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(c)) throw new UserError(`Code d'invitation invalide : « ${truncate(input, 40)} ».`);
  return c;
}

// ---------------------------------------------------------------- composants

const CMD = 'automod';
const backHome = () => actionButton({ command: 'automod', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:automod:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, required = false } = {}) => {
  // Discord limite les libellés de champ à 45 caractères.
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};

// ---------------------------------------------------------------- vues

function cfgOf(client, guildId) {
  return client.services.config.get(guildId).automod;
}

/** Accueil : état général, filtres groupés, réglages transverses. */
function homeView(client, guildId, notice) {
  const cfg = cfgOf(client, guildId);
  const active = FILTERS.filter((f) => cfg.filters?.[f]?.enabled).length;
  const lines = Object.values(GROUPS).flatMap((g) => ['', `**${g.emoji} ${g.label}**`, ...g.filters.map((k) => filterLine(k, cfg.filters?.[k]))]);
  return {
    embeds: [
      card({
        tone: cfg.enabled ? 'success' : 'neutral',
        section: 'automod',
        icon: ICONS.automod,
        title: 'AutoMod · Tableau de bord',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          cfg.enabled ? '🟢 Le filtrage automatique est **actif**.' : '🔴 Le filtrage automatique est **désactivé**.',
          `\`${progressBar(active / FILTERS.length, 14)}\` **${active}** / ${FILTERS.length} filtres`,
          ...lines,
        ],
        fields: [
          field('📈', 'Sanctions progressives', escalationText(cfg.escalation)),
          field('🐣', 'Nouveaux venus', newMembersText(cfg.newMembers)),
          field('🔔', 'Prévenir le membre', NOTIFY_LABELS[cfg.notify] ?? NOTIFY_LABELS.none),
          field(ICONS.channel, 'Salons ignorés', fitList((cfg.ignoredChannels ?? []).map((c) => `<#${c}>`), 1000) ?? '*Aucun*'),
          field(ICONS.role, 'Rôles ignorés', fitList((cfg.ignoredRoles ?? []).map((r) => `<@&${r}>`), 1000) ?? '*Aucun*'),
          field('✅', 'Listes', `${cfg.filters?.badWords?.words?.length ?? 0} mot(s) interdit(s)\n${cfg.filters?.antiLink?.allowedDomains?.length ?? 0} domaine(s) · ${cfg.filters?.antiInvite?.allowedCodes?.length ?? 0} invitation(s) autorisés`),
        ],
        footer: 'Choisissez une section dans le menu · « Gérer les messages » n\'est jamais filtré',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        cfg.enabled
          ? actionButton({ command: 'automod', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'automod', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'automod', action: 'test', label: 'Tester un message', emoji: '🧪', style: ButtonStyle.Primary }),
        actionButton({ command: 'automod', action: 'go', args: ['presets'], label: 'Préréglages', emoji: '🎚️' }),
        actionButton({ command: 'automod', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

/** Liste des filtres d'un groupe, avec un menu pour en régler un. */
function groupView(client, guildId, groupKey, notice) {
  const group = GROUPS[groupKey] ?? GROUPS.security;
  const cfg = cfgOf(client, guildId);
  const details = group.filters.map((k) => {
    const fc = cfg.filters?.[k] ?? {};
    const extras = [];
    const t = THRESHOLDS[k];
    if (t && fc[t[0]] != null) extras.push(`${fc[t[0]]} ${t[1]}`);
    if (WINDOWS[k] && fc.windowSeconds) extras.push(`sur ${fc.windowSeconds} s`);
    return `${filterLine(k, fc)}${extras.length ? ` · ${extras.join(' ')}` : ''}\n${subtext(FILTER_INFO[k])}`;
  });
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'automod',
        icon: group.emoji,
        title: `Filtres · ${group.label}`,
        description: [notice ? `${ICONS.success} ${notice}\n` : null, details.join('\n\n')],
        footer: 'Choisissez un filtre dans le menu pour le régler',
      }),
    ],
    components: [
      navRow(`grp:${groupKey}`),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cmd:automod:fpick:${groupKey}`)
          .setPlaceholder('Régler un filtre…')
          .addOptions(group.filters.map((k) => ({
            value: k,
            label: FILTER_LABELS[k],
            emoji: cfg.filters?.[k]?.enabled ? '🟢' : '🔴',
            description: truncate(FILTER_INFO[k], 100),
          }))),
      ),
      ...buttonRows(backHome()),
    ],
  };
}

/** Exemptions d'un filtre présélectionnées dans ses menus : existantes, d'un type accepté, 25 au plus. */
function filterExemptions(client, guildId, key) {
  const fc = cfgOf(client, guildId).filters?.[key] ?? {};
  const guild = client.guilds?.cache?.get(guildId);
  const chCache = guild?.channels?.cache;
  const roleCache = guild?.roles?.cache;
  return {
    channels: (fc.exemptChannels ?? []).filter((id) => !chCache || IGNORABLE_TYPES.includes(chCache.get(id)?.type)).slice(0, MAX_IGNORED),
    roles: (fc.exemptRoles ?? []).filter((id) => !roleCache || roleCache.has(id)).slice(0, MAX_IGNORED),
  };
}

/** Vue détaillée d'un filtre : activation, sanction, réglages, exemptions propres (≤ 4 rangées). */
function filterView(client, guildId, key, notice) {
  if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
  const cfg = cfgOf(client, guildId);
  const fc = cfg.filters?.[key] ?? {};
  const t = THRESHOLDS[key];
  const current = fc.action ?? (key === 'antiHacked' ? 'quarantine' : 'delete');
  const timed = TIMED.has(current);
  const hasSettings = Boolean(t || WINDOWS[key] || timed);
  const ex = filterExemptions(client, guildId, key);
  const fields = [
    field(ICONS.status, 'État', fc.enabled ? '🟢 Actif' : '🔴 Désactivé'),
    field(ICONS.shield, 'Sanction', ACTION_LABELS[current] ?? ACTION_LABELS.delete),
    field(ICONS.duration, 'Durée du timeout', timed ? fc.duration ?? (current === 'quarantine' ? '1d' : '5m') : '—'),
  ];
  if (t) fields.push(field(ICONS.count, 'Seuil', `${fc[t[0]] ?? '—'} ${t[1]}`));
  if (WINDOWS[key]) fields.push(field(ICONS.time, 'Fenêtre', `${fc.windowSeconds ?? '—'} s`));
  if (key === 'badWords') fields.push(field('🚫', 'Mots', `${fc.words?.length ?? 0} (section Listes)`));
  if (key === 'antiLink') fields.push(field('🌐', 'Domaines autorisés', `${fc.allowedDomains?.length ?? 0} (section Listes)`));
  if (key === 'antiInvite') fields.push(field('✉️', 'Invitations autorisées', `${fc.allowedCodes?.length ?? 0} (section Listes)`));
  if (key === 'antiHacked') {
    fields.push(
      field('🎣', 'Lien d\'arnaque', `score ≥ **${fc.scamScore ?? 5}**`),
      field(ICONS.delete, 'Messages supprimés', `${fc.purgeMinutes ?? 10} dernières min`),
      field(ICONS.role, 'Retirer les rôles', fc.removeRoles ? '✅ Oui (rendus à la levée)' : '❌ Non'),
    );
  }
  fields.push(
    field(ICONS.channel, 'Salons exemptés', fitList(ex.channels.map((c) => `<#${c}>`), 1000) ?? '*Aucun*'),
    field(ICONS.role, 'Rôles exemptés', fitList(ex.roles.map((r) => `<@&${r}>`), 1000) ?? '*Aucun*'),
  );
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`cmd:automod:fexch:${key}`)
    .setPlaceholder('Salons exemptés de ce filtre (aucun)')
    .setChannelTypes(...IGNORABLE_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_IGNORED);
  if (ex.channels.length) channelMenu.setDefaultChannels(...ex.channels);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId(`cmd:automod:fexrole:${key}`).setPlaceholder('Rôles exemptés de ce filtre (aucun)').setMinValues(0).setMaxValues(MAX_IGNORED);
  if (ex.roles.length) roleMenu.setDefaultRoles(...ex.roles);
  return {
    embeds: [
      card({
        tone: fc.enabled ? 'success' : 'neutral',
        section: 'automod',
        icon: GROUPS[groupOf(key)].emoji,
        title: FILTER_LABELS[key],
        description: [notice ? `${ICONS.success} ${notice}\n` : null, FILTER_INFO[key]],
        fields,
        footer: 'Exemptions du filtre en plus des exemptions globales · la sanction la plus sévère l\'emporte',
      }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cmd:automod:faction:${key}`)
          .setPlaceholder('Sanction…')
          .addOptions(actionsFor(key).map((a) => ({ value: a, label: ACTION_LABELS[a], ...ACTION_OPTIONS[a], default: current === a }))),
      ),
      new ActionRowBuilder().addComponents(channelMenu),
      new ActionRowBuilder().addComponents(roleMenu),
      ...buttonRows(
        fc.enabled
          ? actionButton({ command: 'automod', action: 'ftoggle', args: [key, 'off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'automod', action: 'ftoggle', args: [key, 'on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        hasSettings ? actionButton({ command: 'automod', action: 'fset', args: [key], label: 'Réglages', emoji: ICONS.settings, style: ButtonStyle.Primary }) : null,
        ['badWords', 'antiLink', 'antiInvite'].includes(key) ? actionButton({ command: 'automod', action: 'go', args: ['lists'], label: 'Listes', emoji: ICONS.list }) : null,
        key === 'antiHacked'
          ? actionButton({ command: 'automod', action: 'hkroles', args: [fc.removeRoles ? 'off' : 'on'], label: fc.removeRoles ? 'Garder les rôles' : 'Retirer les rôles', emoji: ICONS.role })
          : null,
        actionButton({ command: 'automod', action: 'go', args: [`grp.${groupOf(key)}`], label: 'Retour', emoji: ICONS.back }),
        backHome(),
      ),
    ],
  };
}

function listsView(client, guildId, notice) {
  const cfg = cfgOf(client, guildId);
  const words = cfg.filters?.badWords?.words ?? [];
  const domains = cfg.filters?.antiLink?.allowedDomains ?? [];
  const codes = cfg.filters?.antiInvite?.allowedCodes ?? [];
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'automod',
        icon: ICONS.list,
        title: 'Listes',
        description: notice ? `${notice}` : 'Modifiez une liste avec les boutons ci-dessous.',
        fields: [
          wide('🚫', `Mots interdits (${words.length}/1000)`, words.length ? truncate(words.map(code).join(' · '), 1024) : '*Aucun*'),
          wide('🌐', `Domaines autorisés (${domains.length})`, domains.length ? truncate(domains.map(code).join(' · '), 1024) : '*Aucun* — quand l\'anti-liens est actif, seuls les GIF Discord/Tenor passent.'),
          wide('✉️', `Invitations autorisées (${codes.length})`, codes.length ? truncate(codes.map((c) => code(`discord.gg/${c}`)).join(' · '), 1024) : '*Aucune* — l\'invitation personnalisée du serveur reste autorisée.'),
        ],
        footer: 'Astuce : « mot* » bloque aussi les mots qui commencent par « mot »',
      }),
    ],
    components: [
      navRow('lists'),
      ...buttonRows(
        actionButton({ command: 'automod', action: 'list', args: ['words'], label: 'Mots interdits', emoji: '🚫', style: ButtonStyle.Primary }),
        actionButton({ command: 'automod', action: 'list', args: ['domains'], label: 'Domaines', emoji: '🌐' }),
        actionButton({ command: 'automod', action: 'list', args: ['invites'], label: 'Invitations', emoji: '✉️' }),
        backHome(),
      ),
    ],
  };
}

function escalationView(client, guildId, notice) {
  const esc = cfgOf(client, guildId).escalation ?? {};
  return {
    embeds: [
      card({
        tone: esc.enabled ? 'success' : 'neutral',
        section: 'automod',
        icon: '📈',
        title: 'Sanctions progressives',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          'En cas de récidive, la sanction monte automatiquement. Le compteur survit aux redémarrages.',
        ],
        fields: [
          field(ICONS.status, 'État', esc.enabled ? '🟢 Actives' : '🔴 Désactivées'),
          field(ICONS.time, 'Fenêtre', `${esc.windowMinutes ?? 30} min`),
          wide('🪜', 'Paliers', bullets((esc.steps ?? []).map((s) => `**${s.count}** infractions → ${ACTION_LABELS[s.action] ?? s.action}${s.duration ? ` **${s.duration}**` : ''}`))),
        ],
      }),
    ],
    components: [
      navRow('escalation'),
      ...buttonRows(
        actionButton({ command: 'automod', action: 'esc', args: ['toggle', esc.enabled ? 'off' : 'on'], label: esc.enabled ? 'Désactiver' : 'Activer', emoji: esc.enabled ? '🔴' : '🟢', style: esc.enabled ? ButtonStyle.Danger : ButtonStyle.Success }),
        actionButton({ command: 'automod', action: 'esc', args: ['set'], label: 'Fenêtre et paliers', emoji: ICONS.settings, style: ButtonStyle.Primary }),
        backHome(),
      ),
    ],
  };
}

function newMembersView(client, guildId, notice) {
  const nm = cfgOf(client, guildId).newMembers ?? {};
  const flag = (on) => (on ? '✅' : '❌');
  return {
    embeds: [
      card({
        tone: nm.enabled ? 'success' : 'neutral',
        section: 'automod',
        icon: '🐣',
        title: 'Nouveaux venus',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          'Pendant leur période de probation, les comptes récents ou fraîchement arrivés ne peuvent pas poster certains contenus.',
        ],
        fields: [
          field(ICONS.status, 'État', nm.enabled ? '🟢 Active' : '🔴 Désactivée'),
          field(ICONS.date, 'Compte de moins de', `${nm.accountAgeDays ?? 7} jour(s)`),
          field('📥', 'Ou arrivé depuis moins de', `${nm.joinedMinutes ?? 30} min`),
          field(ICONS.link, 'Liens', flag(nm.blockLinks)),
          field('✉️', 'Invitations', flag(nm.blockInvites)),
          field('📎', 'Fichiers et stickers', flag(nm.blockMedia)),
        ],
        footer: 'Les GIF Discord/Tenor et la liste blanche restent autorisés',
      }),
    ],
    components: [
      navRow('newmembers'),
      ...buttonRows(
        actionButton({ command: 'automod', action: 'nm', args: ['enabled', nm.enabled ? 'off' : 'on'], label: nm.enabled ? 'Désactiver' : 'Activer', emoji: nm.enabled ? '🔴' : '🟢', style: nm.enabled ? ButtonStyle.Danger : ButtonStyle.Success }),
        actionButton({ command: 'automod', action: 'nm', args: ['blockLinks', nm.blockLinks ? 'off' : 'on'], label: `Liens ${flag(nm.blockLinks)}` }),
        actionButton({ command: 'automod', action: 'nm', args: ['blockInvites', nm.blockInvites ? 'off' : 'on'], label: `Invitations ${flag(nm.blockInvites)}` }),
        actionButton({ command: 'automod', action: 'nm', args: ['blockMedia', nm.blockMedia ? 'off' : 'on'], label: `Fichiers ${flag(nm.blockMedia)}` }),
        actionButton({ command: 'automod', action: 'nm', args: ['set'], label: 'Durées', emoji: ICONS.settings, style: ButtonStyle.Primary }),
      ),
      ...buttonRows(backHome()),
    ],
  };
}

/** Salons présélectionnés dans le menu : existants, d'un type accepté, 25 au plus. */
function notifyDefaults(client, guildId) {
  const cfg = cfgOf(client, guildId);
  const cache = client.guilds?.cache?.get(guildId)?.channels?.cache;
  const channels = (cfg.ignoredChannels ?? [])
    .filter((id) => !cache || IGNORABLE_TYPES.includes(cache.get(id)?.type))
    .slice(0, MAX_IGNORED);
  return { channels };
}

function notifyView(client, guildId, notice) {
  const cfg = cfgOf(client, guildId);
  const allowedTypes = IGNORABLE_TYPES;
  const { channels } = notifyDefaults(client, guildId);
  const roleCache = client.guilds?.cache?.get(guildId)?.roles?.cache;
  const roles = (cfg.ignoredRoles ?? []).filter((id) => !roleCache || roleCache.has(id)).slice(0, MAX_IGNORED);
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:automod:ignch')
    .setPlaceholder('Salons ignorés (aucun)')
    .setChannelTypes(...allowedTypes)
    .setMinValues(0)
    .setMaxValues(MAX_IGNORED);
  if (channels.length) channelMenu.setDefaultChannels(...channels);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('cmd:automod:ignrole').setPlaceholder('Rôles ignorés (aucun)').setMinValues(0).setMaxValues(MAX_IGNORED);
  if (roles.length) roleMenu.setDefaultRoles(...roles);
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'automod',
        icon: '🔔',
        title: 'Notifications & exemptions',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          'Choisissez comment prévenir le membre, puis les salons et rôles que l\'AutoMod doit ignorer. Les fils suivent leur salon parent.',
        ],
        fields: [
          field('🔔', 'Prévenir le membre', NOTIFY_LABELS[cfg.notify] ?? NOTIFY_LABELS.none),
          field(ICONS.channel, 'Salons ignorés', `${channels.length}`),
          field(ICONS.role, 'Rôles ignorés', `${roles.length}`),
        ],
        footer: `${MAX_IGNORED} salons et ${MAX_IGNORED} rôles maximum · « Gérer les messages » n'est jamais filtré`,
      }),
    ],
    components: [
      navRow('notify'),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:automod:notify')
          .setPlaceholder('Prévenir le membre…')
          .addOptions(Object.entries(NOTIFY_LABELS).map(([value, label]) => ({ value, label, default: (cfg.notify ?? 'none') === value }))),
      ),
      new ActionRowBuilder().addComponents(channelMenu),
      new ActionRowBuilder().addComponents(roleMenu),
    ],
  };
}

async function nativeView(client, guild, notice) {
  const rules = await native.ownRules(guild).catch(() => null);
  const desired = native.desiredRules(cfgOf(client, guild.id));
  return {
    embeds: [
      card({
        tone: rules?.length ? 'success' : 'neutral',
        section: 'automod',
        icon: '🧱',
        title: 'AutoMod natif de Discord',
        description: [
          notice ? `${notice}\n` : null,
          'Les règles natives bloquent les messages **avant leur envoi**, même quand le bot est hors ligne. Elles reprennent vos filtres actifs (et leurs exemptions) : mots interdits (+ contenu offensant), anti-spam, mentions de masse.',
        ],
        fields: [
          wide('📜', 'Règles en place', rules == null ? '⚠️ Lecture impossible : il me faut **Gérer le serveur**.' : rules.length ? rules.map((r) => `${r.enabled ? '🟢' : '🔴'} ${r.name}`).join('\n') : '*Aucune*'),
          wide('🎯', 'Après synchronisation', desired.length ? desired.map((r) => `› ${r.name}`).join('\n') : '*Aucune : activez les mots interdits, l\'anti-spam ou les mentions de masse.*'),
        ],
        footer: 'Discord exempte d\'office « Gérer le serveur » et les administrateurs',
      }),
    ],
    components: [
      navRow('native'),
      ...buttonRows(
        actionButton({ command: 'automod', action: 'native', args: ['sync'], label: 'Synchroniser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
        actionButton({ command: 'automod', action: 'native', args: ['remove'], label: 'Retirer les règles', emoji: ICONS.delete, style: ButtonStyle.Danger }),
        backHome(),
      ),
    ],
  };
}

function presetsView(notice) {
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'automod',
        icon: '🎚️',
        title: 'Préréglages',
        description: [notice ? `${ICONS.success} ${notice}\n` : null, 'Applique une configuration complète et active l\'AutoMod. **Vos listes** (mots, domaines, invitations), salons et rôles ignorés **sont conservés**.'],
        fields: Object.values(PRESETS).map((p) => wide(p.emoji, p.label, p.description)),
      }),
    ],
    components: [
      navRow('presets'),
      ...buttonRows(
        ...Object.entries(PRESETS).map(([key, p]) => actionButton({ command: 'automod', action: 'preset', args: [key], label: p.label, emoji: p.emoji, style: key === 'equilibre' ? ButtonStyle.Primary : ButtonStyle.Secondary })),
        backHome(),
      ),
    ],
  };
}

function statsView(client, guild, days) {
  const repo = client.repositories?.automodEvents;
  const s = repo ? repo.stats(guild.id, Date.now() - days * 86_400_000) : null;
  const max = s?.byFilter?.[0]?.n ?? 1;
  const label = (f) => FILTER_LABELS[f] ?? (f === 'newMembers' ? 'Nouveaux venus' : f);
  const embed = !s || !s.total
    ? card({ tone: 'info', section: 'automod', icon: ICONS.stats, title: `Statistiques · ${days} jour(s)`, description: s ? 'Aucune infraction sur cette période. ✨' : 'Statistiques indisponibles.' })
    : card({
      tone: 'info',
      section: 'automod',
      icon: ICONS.stats,
      title: `Statistiques · ${days} jour(s)`,
      description: s.byFilter.slice(0, 10).map((r) => `\`${progressBar(r.n / max, 10)}\` **${r.n}** · ${label(r.filter)}`),
      fields: [
        field(ICONS.count, 'Infractions', `**${s.total}**`),
        field(ICONS.members, 'Membres concernés', `**${s.users}**`),
        field(ICONS.shield, 'Sanctions', s.byAction.map((a) => `${ACTION_LABELS[a.action] ?? a.action} : **${a.n}**`).join('\n')),
        wide('🏴', 'Membres les plus filtrés', s.topUsers.map((u, i) => `${i + 1}. <@${u.user_id}> — **${u.n}**`).join('\n')),
      ],
    });
  return {
    embeds: [embed],
    components: [
      navRow(`stats:${days}`),
      ...buttonRows(
        ...[1, 7, 30].map((d) => actionButton({ command: 'automod', action: 'go', args: [`stats.${d}`], label: d === 1 ? '24 h' : `${d} jours`, style: d === days ? ButtonStyle.Primary : ButtonStyle.Secondary })),
        backHome(),
      ),
    ],
  };
}

/** Rend une vue à partir de son identifiant (« grp:spam », « filter:antiLink », « stats:7 »…). */
async function render(client, guild, view = 'home', notice) {
  // « grp:spam » (menu) ou « grp.spam » (bouton : « : » est réservé au routeur).
  const [name, arg] = String(view).split(/[:.]/);
  switch (name) {
    case 'grp':
      return groupView(client, guild.id, GROUPS[arg] ? arg : 'security', notice);
    case 'filter':
      return filterView(client, guild.id, arg, notice);
    case 'lists':
      return listsView(client, guild.id, notice);
    case 'escalation':
      return escalationView(client, guild.id, notice);
    case 'newmembers':
      return newMembersView(client, guild.id, notice);
    case 'notify':
      return notifyView(client, guild.id, notice);
    case 'native':
      return nativeView(client, guild, notice);
    case 'presets':
      return presetsView(notice);
    case 'stats':
      return statsView(client, guild, [1, 7, 30].includes(Number(arg)) ? Number(arg) : 7);
    default:
      return homeView(client, guild.id, notice);
  }
}

/** Valeur voulue par un bouton « on/off » ; anciens boutons sans valeur : inversion. */
function target(state, current) {
  if (state === 'on') return true;
  if (state === 'off') return false;
  return !current;
}

// ---------------------------------------------------------------- test à blanc

function analyse(client, guild, text) {
  const cfg = cfgOf(client, guild.id);
  // Tous les filtres de contenu sont testés, même désactivés, pour montrer ce qu'ils feraient.
  const allOn = Object.fromEntries(Object.entries(cfg.filters ?? {}).map(([k, v]) => [k, { ...v, enabled: true }]));
  const fake = { guild, author: { id: '0', createdTimestamp: 0 }, content: text, mentions: null, channel: null };
  const results = [];
  for (const key of FILTERS) {
    if (['antiSpam', 'antiFlood', 'antiDuplicate', 'antiRepeat', 'antiCrossChannel'].includes(key)) continue;
    // La liste blanche des liens sert aussi à l'anti-arnaques : transmise sans activer l'anti-liens.
    const filters = { antiLink: { ...cfg.filters?.antiLink, enabled: false }, [key]: allOn[key] };
    const hit = client.services.automod.inspect(fake, filters, { temporal: false });
    if (hit) results.push({ key, hit, enabled: Boolean(cfg.filters?.[key]?.enabled) });
  }
  const scan = phishingScore(text, { allowedDomains: cfg.filters?.antiLink?.allowedDomains });
  return { results, scan, normalized: variants(text).at(-1), cfg };
}

function analysisCard(client, guild, text) {
  const { results, scan, normalized, cfg } = analyse(client, guild, text);
  const blocked = results.filter((r) => r.enabled);
  return card({
    tone: blocked.length ? 'danger' : results.length ? 'warning' : 'success',
    section: 'automod',
    icon: '🧪',
    title: 'Test de l\'AutoMod',
    description: [
      blocked.length
        ? `${ICONS.error} Ce message serait **bloqué**${cfg.enabled ? '' : ' (une fois l\'AutoMod activé)'}.`
        : results.length
          ? `${ICONS.warning} Ce message passerait, mais des filtres **désactivés** le bloqueraient.`
          : `${ICONS.success} Ce message **passerait** tous les filtres.`,
      '',
      ...results.map((r) => `${r.enabled ? '🔴' : '⚪'} **${FILTER_LABELS[r.key]}** · ${r.hit.reason}${r.hit.detail ? ` — ${truncate(r.hit.detail, 120)}` : ''}`),
    ],
    fields: [
      wide('✉️', 'Message testé', `\`\`\`\n${truncate(text.replace(/`/g, 'ˋ'), 900)}\n\`\`\``),
      wide('🔤', 'Forme analysée (anti-contournement)', `\`\`\`\n${truncate(normalized.replace(/`/g, 'ˋ'), 900)}\n\`\`\``),
      scan.links.length ? field('🎣', 'Score d\'arnaque', `**${scan.score}** / seuil ${cfg.filters?.antiPhishing?.threshold ?? 3}`) : null,
      scan.reasons.length ? wide(ICONS.search, 'Indices', truncate(scan.reasons.join('\n'), 1024)) : null,
    ],
    footer: 'Test à blanc : aucune sanction ; le spam et les doublons ne sont pas évalués',
  });
}

// ---------------------------------------------------------------- formulaires

function testModal() {
  return new ModalBuilder()
    .setCustomId('cmd:automod:testsubmit')
    .setTitle('Tester l\'AutoMod')
    .addComponents(input('text', 'Message à tester', { style: TextInputStyle.Paragraph, max: 1500, required: true }));
}

function filterModal(cfg, key) {
  const fc = cfg.filters?.[key] ?? {};
  const t = THRESHOLDS[key];
  const rows = [input('duration', 'Durée du timeout (ex : 10m, 1h, 1d)', { value: fc.duration ?? '5m', max: 10 })];
  if (t) rows.push(input('threshold', `Seuil : ${t[2]} à ${t[3]} ${t[1]}`, { value: fc[t[0]], max: 3 }));
  if (WINDOWS[key]) rows.push(input('window', `Fenêtre : ${WINDOWS[key][0]} à ${WINDOWS[key][1]} secondes`, { value: fc.windowSeconds, max: 3 }));
  if (key === 'antiCrossChannel') rows.push(input('minLength', 'Longueur minimale du message (5 à 200)', { value: fc.minLength ?? 20, max: 3 }));
  if (key === 'antiWall') rows.push(input('maxLength', 'Caractères maximum (200 à 4000)', { value: fc.maxLength ?? 1500, max: 4 }));
  if (key === 'antiHacked') {
    rows.push(
      input('purgeMinutes', 'Messages à supprimer : minutes (1 à 60)', { value: fc.purgeMinutes ?? 10, max: 2 }),
      input('scamScore', 'Score d\'arnaque déclencheur (3 à 10)', { value: fc.scamScore ?? 5, max: 2 }),
    );
  }
  return new ModalBuilder().setCustomId(`cmd:automod:fsetsubmit:${key}`).setTitle(truncate(`Réglages · ${FILTER_LABELS[key]}`, 45)).addComponents(...rows);
}

const LIST_META = {
  words: { title: 'Mots interdits', example: 'con, arnaque*, insulte' },
  domains: { title: 'Domaines autorisés', example: 'youtube.com, twitch.tv' },
  invites: { title: 'Invitations autorisées', example: 'discord.gg/partenaire' },
};

function listModal(kind) {
  const meta = LIST_META[kind];
  return new ModalBuilder()
    .setCustomId(`cmd:automod:listsubmit:${kind}`)
    .setTitle(meta.title)
    .addComponents(
      input('add', 'À ajouter (virgules ou retours à la ligne)', { style: TextInputStyle.Paragraph, max: 2000, placeholder: meta.example }),
      input('remove', 'À retirer', { style: TextInputStyle.Paragraph, max: 2000 }),
    );
}

function escalationModal(esc = {}) {
  return new ModalBuilder()
    .setCustomId('cmd:automod:escsubmit')
    .setTitle('Sanctions progressives')
    .addComponents(
      input('window', 'Fenêtre de récidive (minutes, 5 à 1440)', { value: esc.windowMinutes ?? 30, max: 4, required: true }),
      input('steps', 'Paliers (ex : 3=timeout 10m, 8=kick)', {
        value: stepsToText(esc.steps),
        placeholder: '3=timeout 10m, 5=timeout 1h, 8=kick',
        style: TextInputStyle.Paragraph,
        max: 300,
        required: true,
      }),
    );
}

function newMembersModal(nm = {}) {
  return new ModalBuilder()
    .setCustomId('cmd:automod:nmsubmit')
    .setTitle('Nouveaux venus')
    .addComponents(
      input('days', 'Âge minimal du compte (jours, 0 à 90)', { value: nm.accountAgeDays ?? 7, max: 2, required: true }),
      input('minutes', 'Présence minimale (minutes, 0 à 10080)', { value: nm.joinedMinutes ?? 30, max: 5, required: true }),
    );
}

/** Entier borné saisi dans un formulaire (vide = valeur actuelle). */
function intField(interaction, id, min, max, label) {
  let raw;
  try {
    raw = interaction.fields.getTextInputValue(id)?.trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} : entrez un nombre entier entre ${min} et ${max}.`);
  return n;
}

// ---------------------------------------------------------------- logs : faux positif et quarantaine

/** Champ « Message » vide des logs AutoMod. */
const NO_CONTENT = '*Aucun contenu texte*';
/** Filtres dont un faux positif se corrige en autorisant un domaine. */
const LINK_FILTERS = new Set(['antiLink', 'antiPhishing', 'newMembers', 'antiHacked']);
const FIXES_FIELD = 'Correctifs proposés';
const FIX_KINDS = { domain: 'Autoriser le domaine', word: 'Retirer le mot interdit' };

const embedOf = (message) => message?.embeds?.[0] ?? null;
const embedFields = (message) => {
  const e = embedOf(message);
  return e?.fields ?? e?.data?.fields ?? [];
};
const fieldNamed = (message, name) => embedFields(message).find((f) => String(f?.name ?? '').endsWith(name));

/** Contenu du message filtré, relu dans le champ « Message » d'une carte écrite par le bot. Pur. */
function logMessageContent(message) {
  const value = fieldNamed(message, 'Message')?.value;
  return !value || value === NO_CONTENT || value === '—' ? null : String(value);
}

/** Membre concerné par une carte (pied de page « ID : … »), ou null. Pur. */
function footerUserId(message) {
  const e = embedOf(message);
  const text = e?.footer?.text ?? e?.data?.footer?.text ?? '';
  return /ID : (\d{17,20})/.exec(text)?.[1] ?? null;
}

/** Rôles retirés par une quarantaine, relus dans son log. Pur. */
function quarantineRoles(message) {
  const value = fieldNamed(message, QUARANTINE_ROLES_FIELD)?.value ?? '';
  return [...new Set([...String(value).matchAll(/<@&(\d{17,20})>/g)].map((m) => m[1]))];
}

/** Domaine valide pour la liste blanche, ou null (punycode, caractères exotiques…). */
function safeDomain(host) {
  try {
    return cleanDomain(host);
  } catch {
    return null;
  }
}

/**
 * Correctifs à proposer après un faux positif : domaines du message à autoriser
 * (filtres de liens) ou mots de la liste qui l'ont bloqué (mots interdits). Pur.
 * @returns {Array<{ kind: 'domain'|'word', value: string }>} 4 au plus
 */
function fixSuggestions(cfg, filter, content) {
  if (!content) return [];
  const out = [];
  if (LINK_FILTERS.has(filter)) {
    const allowed = [...BUILTIN_ALLOWED_HOSTS, ...(cfg.filters?.antiLink?.allowedDomains ?? [])];
    for (const l of extractLinks(content)) {
      const d = safeDomain(l.host);
      if (d && !hostMatches(d, allowed) && !out.some((x) => x.value === d)) out.push({ kind: 'domain', value: d });
    }
  }
  if (filter === 'badWords') for (const w of matchingWords(content, cfg.filters?.badWords?.words, 4)) out.push({ kind: 'word', value: w });
  return out.slice(0, 4);
}

/** Correctifs relus dans la vue « Faux positif » (écrite par le bot), dans l'ordre des boutons. Pur. */
function parseFixes(message) {
  const value = fieldNamed(message, FIXES_FIELD)?.value ?? '';
  const out = [];
  for (const line of String(value).split('\n')) {
    const m = /^`(\d)` · (.+?) `([^`]+)`$/.exec(line.trim());
    const kind = m && Object.keys(FIX_KINDS).find((k) => FIX_KINDS[k] === m[2]);
    if (kind) out[Number(m[1]) - 1] = { kind, value: m[3] };
  }
  return out;
}

const filterLabel = (f) => FILTER_LABELS[f] ?? (f === 'newMembers' ? 'Nouveaux venus' : f);

/**
 * Vue éphémère après un « Faux positif » : ce qui a été fait, correctifs en un clic
 * et renvoi du message à son auteur.
 */
function falsePositiveView({ userId, filter, action, content, done = [], fixes = [], canFix = false }) {
  const lines = fixes.map((fx, i) => `${code(i + 1)} · ${FIX_KINDS[fx.kind]} ${code(fx.value)}`);
  return {
    embeds: [
      card({
        tone: 'success',
        section: 'automod',
        icon: '🙅',
        title: 'Faux positif',
        description: done.map((d) => `› ${d}`),
        fields: [
          field(ICONS.user, 'Membre', `<@${userId}>`),
          field(ICONS.warning, 'Filtre', filterLabel(filter)),
          field(ICONS.shield, 'Sanction', ACTION_LABELS[action] ?? action),
          lines.length ? wide('🛠️', FIXES_FIELD, [...lines, canFix ? null : subtext('Réservé à « Gérer le serveur ».')].filter(Boolean).join('\n')) : null,
          wide(ICONS.channel, 'Message', content ?? NO_CONTENT),
        ],
        footer: `ID : ${userId}`,
      }),
    ],
    components: buttonRows(
      ...(canFix
        ? fixes.map((fx, i) => actionButton({
          command: 'automod',
          action: 'fpfix',
          args: [i + 1],
          label: fx.kind === 'domain' ? `Autoriser ${fx.value}` : `Retirer « ${fx.value} »`,
          emoji: fx.kind === 'domain' ? '🌐' : '🚫',
        }))
        : []),
      content ? actionButton({ command: 'automod', action: 'fpdm', args: [userId], label: 'Renvoyer en MP', emoji: ICONS.mail }) : null,
    ),
  };
}

/** Bouton « Faux positif » : « Gérer le serveur » ou « Gérer les messages » (revérifié à chaque clic). */
function guardModerator(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms?.has(PermissionFlagsBits.ManageGuild) && !perms?.has(PermissionFlagsBits.ManageMessages)) {
    throw new UserError('Il vous faut la permission **Gérer les messages** ou **Gérer le serveur** pour cette action.');
  }
}

const who = (interaction) => interaction.user?.tag ?? interaction.user?.username ?? interaction.user?.id;

/** Message rendu à son auteur après un faux positif. */
function restoredMessageCard(guild, content) {
  return card({
    tone: 'info',
    section: { emoji: '🏠', label: guild.name },
    icon: ICONS.automod,
    title: 'Votre message a été rétabli',
    description: `Un modérateur de **${guild.name}** a confirmé que l'AutoMod avait retiré votre message par erreur. Le voici, pour que vous puissiez le reposter :`,
    fields: [wide(ICONS.channel, 'Message', content)],
  });
}

/** Lève un timeout via ModerationService (permission et hiérarchie du cliqueur). @returns {Promise<string>} */
async function liftTimeout(interaction, client, userId, reason) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return 'Timeout non levé : il vous faut la permission **Exclure temporairement des membres**.';
  }
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) return 'Timeout non levé : le membre n\'est plus sur le serveur.';
  if (!member.isCommunicationDisabled?.()) return 'Le membre n\'est pas en timeout.';
  try {
    await client.services.moderation.removeTimeout(interaction.guild, member, interaction.member, reason);
    return 'Timeout **levé**.';
  } catch (err) {
    if (err?.isUserError) return `Timeout non levé : ${err.message}`;
    throw err;
  }
}

/** Rend les rôles retirés par une quarantaine (rôles existants, sous le cliqueur et le bot). @returns {Promise<string>} */
async function restoreRoles(interaction, userId, roleIds, reason) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return 'Rôles non rendus : il vous faut la permission **Gérer les rôles**.';
  const guild = interaction.guild;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return 'Rôles non rendus : le membre n\'est plus sur le serveur.';
  const isOwner = interaction.user.id === guild.ownerId;
  const top = interaction.member?.roles?.highest?.position ?? 0;
  const roles = roleIds
    .map((id) => guild.roles.cache.get(id))
    .filter((r) => r && !r.managed && r.editable !== false && !member.roles.cache.has(r.id) && (isOwner || r.position < top));
  if (!roles.length) return 'Aucun rôle à rendre.';
  const ok = await member.roles.add(roles.map((r) => r.id), reason).then(() => true, () => false);
  return ok ? `**${roles.length}** rôle(s) rendu(s).` : 'Rôles non rendus : vérifiez ma permission **Gérer les rôles** et ma position.';
}

// ---------------------------------------------------------------- commande

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');

module.exports = {
  category: 'automod',
  cooldown: 3_000,
  filterLine,
  analyse,
  parseSteps,
  render,
  logMessageContent,
  footerUserId,
  fixSuggestions,
  falsePositiveView,
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Ouvre le tableau de bord de l\'AutoMod : tout se configure depuis ici.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...(await render(client, interaction.guild, 'home')), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      const view = interaction.values?.[0] ?? 'home';
      // La vue native interroge l'API Discord : on accuse réception d'abord (délai de 3 s).
      if (view === 'native') await interaction.deferUpdate();
      const payload = await render(client, interaction.guild, view);
      await (interaction.deferred ? interaction.editReply(payload) : interaction.update(payload));
    },
    /** cmd:automod:go:<vue> — boutons Accueil / Retour / périodes de stats. */
    async go(interaction, client, [view]) {
      guard(interaction);
      if (String(view).startsWith('native')) await interaction.deferUpdate();
      const payload = await render(client, interaction.guild, view ?? 'home');
      await (interaction.deferred ? interaction.editReply(payload) : interaction.update(payload));
    },
    /** cmd:automod:toggle:<on|off> — interrupteur global. */
    async toggle(interaction, client, [state]) {
      guard(interaction);
      const enabled = state === 'on';
      client.services.config.update(interaction.guildId, { automod: { enabled } });
      await interaction.update(await render(client, interaction.guild, 'home', `AutoMod **${enabled ? 'activé' : 'désactivé'}**.`));
    },
    /** cmd:automod:fpick:<groupe> — menu « Régler un filtre ». */
    async fpick(interaction, client) {
      guard(interaction);
      const key = interaction.values?.[0];
      if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
      await interaction.update(filterView(client, interaction.guildId, key));
    },
    /** cmd:automod:ftoggle:<filtre>:<on|off> — la valeur AFFICHÉE sur le bouton (jamais une inversion à l'aveugle). */
    async ftoggle(interaction, client, [key, state]) {
      guard(interaction);
      if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
      const enabled = target(state, cfgOf(client, interaction.guildId).filters?.[key]?.enabled);
      client.services.config.update(interaction.guildId, { automod: { filters: { [key]: { enabled } } } });
      await interaction.update(filterView(client, interaction.guildId, key, `${FILTER_LABELS[key]} ${enabled ? 'activé' : 'désactivé'}.`));
    },
    /** cmd:automod:faction:<filtre> — menu de sanction. */
    async faction(interaction, client, [key]) {
      guard(interaction);
      const action = interaction.values?.[0];
      if (!FILTER_LABELS[key] || !actionsFor(key).includes(action)) throw new UserError('Sanction invalide.');
      const patch = { action };
      if (TIMED.has(action) && !cfgOf(client, interaction.guildId).filters?.[key]?.duration) patch.duration = action === 'quarantine' ? '1d' : '5m';
      client.services.config.update(interaction.guildId, { automod: { filters: { [key]: patch } } });
      await interaction.update(filterView(client, interaction.guildId, key, `Sanction : **${ACTION_LABELS[action]}**.`));
    },
    /** cmd:automod:fset:<filtre> — ouvre le formulaire de réglages. */
    async fset(interaction, client, [key]) {
      guard(interaction);
      if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
      await interaction.showModal(filterModal(cfgOf(client, interaction.guildId), key));
    },
    async fsetsubmit(interaction, client, [key]) {
      guard(interaction);
      if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
      const patch = {};
      const duration = interaction.fields.getTextInputValue('duration')?.trim();
      if (duration) {
        const ms = parseDuration(duration);
        if (!ms || ms > 28 * 86_400_000) throw new UserError('Durée invalide (ex : `10m`, `1h`, `1d` ; 28 jours maximum).');
        patch.duration = duration;
      }
      const t = THRESHOLDS[key];
      if (t) {
        const v = intField(interaction, 'threshold', t[2], t[3], 'Seuil');
        if (v !== undefined) patch[t[0]] = v;
      }
      if (WINDOWS[key]) {
        const v = intField(interaction, 'window', WINDOWS[key][0], WINDOWS[key][1], 'Fenêtre');
        if (v !== undefined) patch.windowSeconds = v;
      }
      if (key === 'antiCrossChannel') {
        const v = intField(interaction, 'minLength', 5, 200, 'Longueur minimale');
        if (v !== undefined) patch.minLength = v;
      }
      if (key === 'antiWall') {
        const v = intField(interaction, 'maxLength', 200, 4000, 'Caractères maximum');
        if (v !== undefined) patch.maxLength = v;
      }
      if (key === 'antiHacked') {
        const minutes = intField(interaction, 'purgeMinutes', 1, 60, 'Minutes de messages à supprimer');
        if (minutes !== undefined) patch.purgeMinutes = minutes;
        const score = intField(interaction, 'scamScore', 3, 10, 'Score d\'arnaque');
        if (score !== undefined) patch.scamScore = score;
      }
      client.services.config.update(interaction.guildId, { automod: { filters: { [key]: patch } } });
      await interaction.update(filterView(client, interaction.guildId, key, 'Réglages enregistrés.'));
    },
    /** cmd:automod:list:<words|domains|invites> — ouvre le formulaire de la liste. */
    async list(interaction, client, [kind]) {
      guard(interaction);
      if (!LIST_META[kind]) throw new UserError('Liste inconnue.');
      await interaction.showModal(listModal(kind));
    },
    async listsubmit(interaction, client, [kind]) {
      guard(interaction);
      if (!LIST_META[kind]) throw new UserError('Liste inconnue.');
      const cfg = cfgOf(client, interaction.guildId);
      const add = splitItems(interaction.fields.getTextInputValue('add'));
      const remove = splitItems(interaction.fields.getTextInputValue('remove'));
      const rejected = [];
      const clean = (v) => {
        try {
          if (kind === 'domains') return cleanDomain(v);
          if (kind === 'invites') return cleanInvite(v);
          const w = v.toLowerCase();
          if (w.length > 60 || !isValidWord(w)) throw new UserError('invalide');
          return w;
        } catch {
          rejected.push(v);
          return null;
        }
      };
      const current = kind === 'words' ? cfg.filters.badWords.words : kind === 'domains' ? cfg.filters.antiLink.allowedDomains : cfg.filters.antiInvite.allowedCodes;
      const set = new Set(current ?? []);
      let added = 0;
      let removed = 0;
      for (const v of add.map(clean).filter(Boolean)) {
        if (!set.has(v)) {
          set.add(v);
          added += 1;
        }
      }
      for (const v of remove.map(clean).filter(Boolean)) {
        if (set.delete(v)) removed += 1;
      }
      if (kind === 'words' && set.size > 1000) throw new UserError('La liste est limitée à 1000 mots.');
      const list = [...set];
      const patch = kind === 'words'
        ? { badWords: added ? { words: list, enabled: true } : { words: list } } // un ajout active le filtre
        : kind === 'domains' ? { antiLink: { allowedDomains: list } } : { antiInvite: { allowedCodes: list } };
      client.services.config.update(interaction.guildId, { automod: { filters: patch } });
      const notice = [
        `${ICONS.success} **${LIST_META[kind].title}** : ${added} ajout(s), ${removed} retrait(s).`,
        rejected.length ? `${ICONS.warning} Ignoré(s), format invalide : ${truncate(rejected.map(code).join(', '), 500)}` : null,
      ].filter(Boolean).join('\n');
      await interaction.update(listsView(client, interaction.guildId, notice));
    },
    /** cmd:automod:esc:<toggle|set> */
    async esc(interaction, client, [what, state]) {
      guard(interaction);
      const esc = cfgOf(client, interaction.guildId).escalation ?? {};
      if (what === 'set') return interaction.showModal(escalationModal(esc));
      const enabled = target(state, esc.enabled);
      client.services.config.update(interaction.guildId, { automod: { escalation: { enabled } } });
      await interaction.update(escalationView(client, interaction.guildId, `Sanctions progressives ${enabled ? 'activées' : 'désactivées'}.`));
    },
    async escsubmit(interaction, client) {
      guard(interaction);
      const windowMinutes = intField(interaction, 'window', 5, 1440, 'Fenêtre');
      const steps = parseSteps(interaction.fields.getTextInputValue('steps'));
      // Les paliers sont un tableau : ConfigService le remplace en entier (pas de fusion).
      client.services.config.update(interaction.guildId, { automod: { escalation: { ...(windowMinutes ? { windowMinutes } : {}), steps } } });
      await interaction.update(escalationView(client, interaction.guildId, 'Fenêtre et paliers enregistrés.'));
    },
    /** cmd:automod:nm:<enabled|blockLinks|blockInvites|blockMedia|set> */
    async nm(interaction, client, [what, state]) {
      guard(interaction);
      const nm = cfgOf(client, interaction.guildId).newMembers ?? {};
      if (what === 'set') return interaction.showModal(newMembersModal(nm));
      if (!['enabled', 'blockLinks', 'blockInvites', 'blockMedia'].includes(what)) throw new UserError('Réglage inconnu.');
      client.services.config.update(interaction.guildId, { automod: { newMembers: { [what]: target(state, nm[what]) } } });
      await interaction.update(newMembersView(client, interaction.guildId, 'Réglage mis à jour.'));
    },
    async nmsubmit(interaction, client) {
      guard(interaction);
      const accountAgeDays = intField(interaction, 'days', 0, 90, 'Âge du compte');
      const joinedMinutes = intField(interaction, 'minutes', 0, 10080, 'Présence minimale');
      client.services.config.update(interaction.guildId, {
        automod: { newMembers: { ...(accountAgeDays !== undefined ? { accountAgeDays } : {}), ...(joinedMinutes !== undefined ? { joinedMinutes } : {}) } },
      });
      await interaction.update(newMembersView(client, interaction.guildId, 'Durées enregistrées.'));
    },
    /** Menu « Prévenir le membre ». */
    async notify(interaction, client) {
      guard(interaction);
      const mode = interaction.values?.[0];
      if (!NOTIFY_LABELS[mode]) throw new UserError('Mode inconnu.');
      client.services.config.update(interaction.guildId, { automod: { notify: mode } });
      await interaction.update(notifyView(client, interaction.guildId, `Notification : **${NOTIFY_LABELS[mode]}**.`));
    },
    /** Sélecteur de salons ignorés (remplace la liste). */
    async ignch(interaction, client) {
      guard(interaction);
      const picked = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id));
      // Salons enregistrés mais absents du menu (fils, catégories, au-delà de 25) : conservés.
      // Les salons supprimés, eux, sont nettoyés.
      const shown = new Set(notifyDefaults(client, interaction.guildId).channels);
      const cache = interaction.guild?.channels?.cache;
      const hidden = (cfgOf(client, interaction.guildId).ignoredChannels ?? []).filter((id) => !shown.has(id) && cache?.has(id));
      const ids = [...new Set([...picked, ...hidden])].slice(0, 100);
      client.services.config.update(interaction.guildId, { automod: { ignoredChannels: ids } });
      await interaction.update(notifyView(client, interaction.guildId, `${ids.length} salon(s) ignoré(s).`));
    },
    /** Sélecteur de rôles ignorés (remplace la liste). */
    async ignrole(interaction, client) {
      guard(interaction);
      const ids = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id) && id !== interaction.guildId).slice(0, MAX_IGNORED);
      client.services.config.update(interaction.guildId, { automod: { ignoredRoles: ids } });
      await interaction.update(notifyView(client, interaction.guildId, `${ids.length} rôle(s) ignoré(s).`));
    },
    /** cmd:automod:native:<sync|remove> */
    async native(interaction, client, [what]) {
      guard(interaction);
      if (!['sync', 'remove'].includes(what)) throw new UserError('Action inconnue.');
      await interaction.deferUpdate();
      let notice;
      if (what === 'remove') {
        notice = `${ICONS.success} ${await native.remove(interaction.guild)} règle(s) native(s) retirée(s).`;
      } else {
        const cfg = client.services.config.get(interaction.guildId);
        const r = await native.sync(interaction.guild, cfg.automod, cfg.logChannels?.automod);
        notice = [
          ...r.created.map((n) => `🆕 ${n}`),
          ...r.updated.map((n) => `🔄 ${n}`),
          ...r.removed.map((n) => `🗑️ ${n} (filtre désactivé)`),
          ...r.failed.map((f) => `${ICONS.error} ${f.name} — ${f.reason}`),
        ].join('\n') || `${ICONS.info} Aucun filtre compatible actif.`;
      }
      await interaction.editReply(await nativeView(client, interaction.guild, notice));
    },
    /** cmd:automod:preset:<faible|equilibre|strict> */
    async preset(interaction, client, [key]) {
      guard(interaction);
      const preset = PRESETS[key];
      if (!preset) throw new UserError('Préréglage inconnu.');
      client.services.config.update(interaction.guildId, { automod: preset.patch });
      await interaction.update(await render(client, interaction.guild, 'home', `Préréglage ${preset.emoji} **${preset.label}** appliqué. Vos listes sont conservées.`));
    },
    /** cmd:automod:test — ouvre le formulaire de test. */
    async test(interaction) {
      guard(interaction);
      await interaction.showModal(testModal());
    },
    /** Résultat du test : nouveau message éphémère (le tableau de bord reste en place). */
    async testsubmit(interaction, client) {
      guard(interaction);
      const text = interaction.fields.getTextInputValue('text');
      await interaction.reply({ embeds: [analysisCard(client, interaction.guild, text)], ephemeral: true });
    },
    /** cmd:automod:fexch:<filtre> — salons exemptés de CE filtre (remplace la liste). */
    async fexch(interaction, client, [key]) {
      guard(interaction);
      if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
      const picked = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id));
      // Salons enregistrés mais absents du menu (fils, au-delà de 25) : conservés s'ils existent.
      const shown = new Set(filterExemptions(client, interaction.guildId, key).channels);
      const cache = interaction.guild?.channels?.cache;
      const hidden = (cfgOf(client, interaction.guildId).filters?.[key]?.exemptChannels ?? []).filter((id) => !shown.has(id) && cache?.has(id));
      const ids = [...new Set([...picked, ...hidden])].slice(0, 100);
      client.services.config.update(interaction.guildId, { automod: { filters: { [key]: { exemptChannels: ids } } } });
      await interaction.update(filterView(client, interaction.guildId, key, `${ids.length} salon(s) exempté(s) de ce filtre.`));
    },
    /** cmd:automod:fexrole:<filtre> — rôles exemptés de CE filtre (remplace la liste). */
    async fexrole(interaction, client, [key]) {
      guard(interaction);
      if (!FILTER_LABELS[key]) throw new UserError('Filtre inconnu.');
      const ids = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id) && id !== interaction.guildId).slice(0, MAX_IGNORED);
      client.services.config.update(interaction.guildId, { automod: { filters: { [key]: { exemptRoles: ids } } } });
      await interaction.update(filterView(client, interaction.guildId, key, `${ids.length} rôle(s) exempté(s) de ce filtre.`));
    },
    /** cmd:automod:hkroles:<on|off> — retirer les rôles pendant une quarantaine. */
    async hkroles(interaction, client, [state]) {
      guard(interaction);
      const removeRoles = target(state, cfgOf(client, interaction.guildId).filters?.antiHacked?.removeRoles);
      client.services.config.update(interaction.guildId, { automod: { filters: { antiHacked: { removeRoles } } } });
      await interaction.update(filterView(client, interaction.guildId, 'antiHacked', removeRoles ? 'Les rôles seront retirés pendant la quarantaine, puis rendus à la levée.' : 'Les rôles ne seront plus retirés.'));
    },

    /**
     * cmd:automod:fp:<idInfraction> — « Faux positif » sur un log AutoMod : retire l'infraction
     * du compteur de récidive, lève le timeout posé et ouvre une vue éphémère de correctifs.
     */
    async fp(interaction, client, [rawId]) {
      guardModerator(interaction);
      if (!/^\d{1,15}$/.test(rawId ?? '')) throw new UserError('Bouton invalide (infraction).');
      const repo = client.repositories?.automodEvents;
      const row = repo?.get(interaction.guildId, Number(rawId));
      if (!row) throw new UserError('Cette infraction est introuvable : déjà traitée ou expirée (30 jours).');
      // Le log et l'infraction doivent concerner le même membre (pied de page « ID : … »).
      if (footerUserId(interaction.message) !== row.user_id) throw new UserError('Ce bouton ne correspond pas à ce log.');
      const content = logMessageContent(interaction.message);
      await interaction.deferUpdate();
      repo.remove(interaction.guildId, row.id);
      client.services.automod?.forget?.(interaction.guildId, row.user_id);
      const done = ['Infraction retirée du compteur de récidive.'];
      if (row.action === 'timeout') done.push(await liftTimeout(interaction, client, row.user_id, `Faux positif AutoMod (signalé par ${who(interaction)})`));
      if (row.action === 'warn') done.push('L\'avertissement reste dans l\'historique des sanctions (📜).');
      if (row.action === 'kick') done.push('L\'expulsion ne peut pas être annulée : renvoyez une invitation au membre si besoin.');
      const fixes = fixSuggestions(cfgOf(client, interaction.guildId), row.filter, content);
      const canFix = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
      await interaction.editReply({ components: settleComponents(interaction.message, interaction.customId, `Faux positif · ${interaction.user.username}`) });
      await interaction.followUp({ ...falsePositiveView({ userId: row.user_id, filter: row.filter, action: row.action, content, done, fixes, canFix }), ephemeral: true });
    },
    /** cmd:automod:fpfix:<n> — correctif n°n, relu dans la vue (jamais dans le customId). */
    async fpfix(interaction, client, [n]) {
      guard(interaction);
      if (!/^[1-4]$/.test(n ?? '')) throw new UserError('Bouton invalide.');
      const fix = parseFixes(interaction.message)[Number(n) - 1];
      if (!fix) throw new UserError('Ce correctif n\'est plus disponible.');
      const cfg = cfgOf(client, interaction.guildId);
      let label;
      if (fix.kind === 'domain') {
        const domain = cleanDomain(fix.value);
        if (!extractLinks(logMessageContent(interaction.message) ?? '').some((l) => l.host === domain)) throw new UserError('Ce domaine ne figure pas dans le message.');
        const list = cfg.filters?.antiLink?.allowedDomains ?? [];
        if (list.includes(domain)) throw new UserError(`${code(domain)} est déjà autorisé.`);
        client.services.config.update(interaction.guildId, { automod: { filters: { antiLink: { allowedDomains: [...list, domain] } } } });
        label = `Autorisé : ${domain}`;
      } else {
        const words = cfg.filters?.badWords?.words ?? [];
        if (!words.includes(fix.value)) throw new UserError('Ce mot n\'est plus dans la liste.');
        client.services.config.update(interaction.guildId, { automod: { filters: { badWords: { words: words.filter((w) => w !== fix.value) } } } });
        label = `Retiré : ${fix.value}`;
      }
      await interaction.update({ components: settleComponents(interaction.message, interaction.customId, label) });
    },
    /** cmd:automod:fpdm:<userId> — renvoie le message filtré à son auteur (MP). */
    async fpdm(interaction, client, [rawUserId]) {
      guardModerator(interaction);
      const userId = snowflake(rawUserId, 'membre');
      if (footerUserId(interaction.message) !== userId) throw new UserError('Ce bouton ne correspond pas à cette vue.');
      const content = logMessageContent(interaction.message);
      if (!content) throw new UserError('Aucun contenu texte à renvoyer.');
      await interaction.deferUpdate();
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) throw new UserError('Utilisateur introuvable.');
      const sent = await user.send({ embeds: [restoredMessageCard(interaction.guild, content)] }).then(() => true, () => false);
      if (!sent) throw new UserError('Impossible d\'envoyer le message privé : ses MP sont sans doute fermés.');
      await interaction.editReply({ components: settleComponents(interaction.message, interaction.customId, 'Renvoyé en MP') });
    },

    /** cmd:automod:qlift:<userId> — lève la quarantaine : timeout retiré, rôles retirés rendus. */
    async qlift(interaction, client, [rawUserId]) {
      requirePermission(interaction, 'ModerateMembers');
      const userId = snowflake(rawUserId, 'membre');
      await interaction.deferUpdate();
      const reason = `Quarantaine AutoMod levée par ${who(interaction)}`;
      const done = [await liftTimeout(interaction, client, userId, reason)];
      // Rôles relus dans CE log (écrit par le bot), seulement s'il concerne bien ce membre.
      const roles = footerUserId(interaction.message) === userId ? quarantineRoles(interaction.message) : [];
      if (roles.length) done.push(await restoreRoles(interaction, userId, roles, reason));
      client.services.automod?.forget?.(interaction.guildId, userId);
      await interaction.editReply({ components: settleComponents(interaction.message, interaction.customId, `Levée par ${interaction.user.username}`) });
      await interaction.followUp({
        embeds: [card({ tone: 'success', section: 'automod', icon: ICONS.unlock, title: 'Quarantaine levée', description: done.map((d) => `› ${d}`), fields: [field(ICONS.user, 'Membre', `<@${userId}>`)] })],
        components: buttonRows(historyButton(userId)),
        ephemeral: true,
      });
    },
    /** cmd:automod:qban:<userId> — demande de confirmation (éphémère) avant de bannir. */
    async qban(interaction, client, [rawUserId]) {
      requirePermission(interaction, 'BanMembers');
      const userId = snowflake(rawUserId, 'membre');
      const logId = /^\d{17,20}$/.test(interaction.message?.id ?? '') ? interaction.message.id : null;
      await interaction.reply({
        embeds: [
          card({
            tone: 'warning',
            icon: ICONS.warning,
            title: 'Confirmer le bannissement',
            description: [`Bannir <@${userId}> définitivement ? Ses messages de la dernière heure seront aussi supprimés.`, subtext('Si son propriétaire récupère le compte, il pourra être débanni avec /unban.')],
          }),
        ],
        components: buttonRows(
          actionButton({ command: 'automod', action: 'qbanok', args: logId ? [userId, logId] : [userId], label: 'Bannir', emoji: ICONS.ban, style: ButtonStyle.Danger }),
          actionButton({ command: 'automod', action: 'qcancel', label: 'Annuler', emoji: ICONS.error }),
        ),
        ephemeral: true,
      });
    },
    /** cmd:automod:qbanok:<userId>[:<idDuLog>] — bannissement confirmé. */
    async qbanok(interaction, client, [rawUserId, rawLogId]) {
      requirePermission(interaction, 'BanMembers');
      const userId = snowflake(rawUserId, 'membre');
      await interaction.deferUpdate();
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) throw new UserError('Utilisateur introuvable.');
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      const res = await client.services.moderation.ban(interaction.guild, user, interaction.member, 'Compte piraté (quarantaine AutoMod)', { deleteMessageSeconds: 3600, targetMember: member ?? undefined });
      await interaction.editReply({ embeds: [status.ok(`${userLine(user)} est banni${res?.id ? ` · sanction #${res.id}` : ''}.`, 'Membre banni')], components: [] });
      // Fige le bouton « Bannir » du log d'origine (best-effort).
      if (/^\d{17,20}$/.test(rawLogId ?? '')) {
        const log = await interaction.channel?.messages?.fetch(rawLogId).catch(() => null);
        if (log && log.author?.id === client.user?.id) {
          await log.edit({ components: settleComponents(log, `cmd:automod:qban:${userId}`, `Banni par ${interaction.user.username}`) }).catch(() => {});
        }
      }
    },
    /** cmd:automod:qcancel — annule le bannissement. */
    async qcancel(interaction) {
      requirePermission(interaction, 'BanMembers');
      await interaction.update({ embeds: [status.warn('Bannissement annulé. Rien n\'a été modifié.')], components: [] });
    },
  },
};
