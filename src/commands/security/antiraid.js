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
  UserSelectMenuBuilder,
} = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, wide, kv, ICONS, subtext, bullets, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { fitList } = require('../../services/LoggingService');
const { assertAdmin } = require('../../services/ModerationService');
const { newAccountAction } = require('../../services/AntiRaidService');
const { UserError } = require('../../core/errors');

/**
 * /antiraid : UN tableau de bord interactif (éphémère) pour tout configurer.
 * Remplace les anciennes sous-commandes enable/disable/status/set : chaque
 * réglage de `/antiraid set` a son menu, son bouton ou son formulaire.
 * « Administrateur » est revérifiée à chaque clic.
 *
 * Vues : home · joins · accounts · destructive · alerts · whitelist · presets
 */

// ---------------------------------------------------------------- métadonnées

const ACTION_LABELS = { kick: `${ICONS.kick} Expulsion`, ban: `${ICONS.ban} Bannissement`, lockdown: '🚨 Lockdown' };
const EXECUTOR_LABELS = { strip: 'Retrait des rôles', ban: 'Bannissement', none: 'Aucune' };
const WAVE_ACTIONS = {
  kick: { label: 'Expulser les arrivants', emoji: ICONS.kick, description: 'Les membres arrivés pendant la vague sont expulsés' },
  ban: { label: 'Bannir les arrivants', emoji: ICONS.ban, description: 'Les membres arrivés pendant la vague sont bannis' },
  lockdown: { label: 'Lockdown', emoji: '🚨', description: 'Tous les salons écrits passent en lecture seule' },
};
const NEW_ACCOUNT_ACTIONS = {
  kick: { label: 'Expulsion', emoji: ICONS.kick, description: 'Le compte peut revenir plus tard' },
  ban: { label: 'Bannissement', emoji: ICONS.ban, description: 'Le compte ne peut plus revenir' },
};
const EXECUTOR_ACTIONS = {
  strip: { label: 'Retrait des rôles', emoji: '🎭', description: 'Retire tous les rôles que je peux gérer' },
  ban: { label: 'Bannissement', emoji: ICONS.ban, description: 'Bannit l\'auteur des suppressions' },
  none: { label: 'Aucune', emoji: '🔕', description: 'Alerte seulement, sans sanction' },
};

/** Bornes des réglages numériques : [min, max]. Mêmes possibilités que l'ancien `/antiraid set`. */
const BOUNDS = {
  joinThreshold: [2, 1000],
  joinWindowSeconds: [1, 3600],
  minAccountAgeDays: [0, 3650],
  channelDeleteThreshold: [0, 100],
  roleDeleteThreshold: [0, 100],
  banThreshold: [0, 100],
  kickThreshold: [0, 100],
  destructiveWindowSeconds: [1, 3600],
};

const MAX_WL = 25;

/** Préréglages : seuls les réglages de détection changent (salon d'alerte et whitelist conservés). */
const PRESETS = {
  faible: {
    label: 'Faible',
    emoji: '🟢',
    description: 'Peu de faux positifs : vagues de 20 arrivées en 10 s (expulsion), pas de filtre d\'âge ni d\'anti-bot, seuils de destruction larges.',
    patch: { enabled: true, joinThreshold: 20, joinWindowSeconds: 10, action: 'kick', minAccountAgeDays: 0, antiBot: false, newAccountAction: 'kick', channelDeleteThreshold: 5, roleDeleteThreshold: 5, banThreshold: 10, kickThreshold: 0, destructiveWindowSeconds: 10, punishExecutor: 'strip' },
  },
  equilibre: {
    label: 'Équilibré',
    emoji: '🟡',
    description: 'Recommandé : 10 arrivées en 10 s (expulsion), comptes de moins d\'1 jour expulsés, anti-bot, 3 suppressions en 10 s → rôles retirés.',
    patch: { enabled: true, joinThreshold: 10, joinWindowSeconds: 10, action: 'kick', minAccountAgeDays: 1, antiBot: true, newAccountAction: 'kick', channelDeleteThreshold: 3, roleDeleteThreshold: 3, banThreshold: 5, kickThreshold: 0, destructiveWindowSeconds: 10, punishExecutor: 'strip' },
  },
  strict: {
    label: 'Strict',
    emoji: '🔴',
    description: 'Serveur ciblé : 6 arrivées en 10 s → lockdown, comptes de moins de 7 jours bannis, anti-bot, 2 suppressions (ou 5 expulsions) en 15 s → bannissement.',
    patch: { enabled: true, joinThreshold: 6, joinWindowSeconds: 10, action: 'lockdown', minAccountAgeDays: 7, antiBot: true, newAccountAction: 'ban', channelDeleteThreshold: 2, roleDeleteThreshold: 2, banThreshold: 3, kickThreshold: 5, destructiveWindowSeconds: 15, punishExecutor: 'ban' },
  },
};

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'État, interrupteur et dernier déclenchement' },
  { value: 'joins', label: 'Vague d\'arrivées', emoji: '🌊', description: 'Seuil, fenêtre et action en cas de raid' },
  { value: 'accounts', label: 'Comptes récents & bots', emoji: '🐣', description: 'Âge minimal du compte, anti-bot' },
  { value: 'destructive', label: 'Destruction', emoji: '💣', description: 'Suppressions massives de salons, rôles, bans, expulsions' },
  { value: 'alerts', label: 'Alertes', emoji: '🔔', description: 'Salon où publier les alertes' },
  { value: 'whitelist', label: 'Whitelist', emoji: '🔐', description: 'Membres et rôles jamais sanctionnés' },
  { value: 'presets', label: 'Préréglages', emoji: '🎚️', description: 'Faible, Équilibré ou Strict en un clic' },
];

// ---------------------------------------------------------------- helpers

const guard = (interaction) => assertAdmin(interaction);
/** Clé propre d'un catalogue (« constructor », « toString »… refusés). */
const own = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);
const cfgOf = (client, guildId) => client.services.config.get(guildId);
const threshold = (n) => (n ? `**${n}**` : 'Désactivé');
const onOff = (v) => (v ? '🟢 Oui' : '🔴 Non');
const SECTION = 'security';

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:antiraid:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const backHome = () => actionButton({ command: 'antiraid', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

const input = (id, label, { value, placeholder, max = 5, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};

/** Entier borné saisi dans un formulaire (vide = inchangé). */
function intField(interaction, id, key, label) {
  let raw;
  try {
    raw = interaction.fields.getTextInputValue(id)?.trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const [min, max] = BOUNDS[key];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} : entrez un nombre entier entre ${min} et ${max}.`);
  return n;
}

/** Valeur voulue par un bouton « on/off » ; anciens boutons sans valeur : inversion. */
function target(state, current) {
  if (state === 'on') return true;
  if (state === 'off') return false;
  return !current;
}

/** Résumé des seuils de destruction. Pur. */
function destructiveText(c) {
  return kv([
    ['Salons supprimés', threshold(c.channelDeleteThreshold)],
    ['Rôles supprimés', threshold(c.roleDeleteThreshold)],
    ['Bannissements', threshold(c.banThreshold)],
    ['Expulsions', threshold(c.kickThreshold)],
    ['Sanction de l\'auteur', EXECUTOR_LABELS[c.punishExecutor] ?? c.punishExecutor],
  ]);
}

function lastTriggerText(client, guildId) {
  const last = client.services.antiraid?.lastTriggerOf?.(guildId);
  if (!last) return '*Aucun depuis le démarrage du bot*';
  return `**${truncate(last.title, 80)}** · ${discordTimestamp(last.at, 'R')}${last.description ? `\n${subtext(truncate(last.description.replace(/\n/g, ' '), 200))}` : ''}`;
}

// ---------------------------------------------------------------- vues

function homeView(client, guildId, notice) {
  const cfg = cfgOf(client, guildId);
  const c = cfg.antiraid;
  const wl = cfg.whitelist ?? { users: [], roles: [] };
  const wlCount = (wl.users?.length ?? 0) + (wl.roles?.length ?? 0);
  return {
    embeds: [
      card({
        tone: c.enabled ? 'success' : 'neutral',
        section: SECTION,
        icon: ICONS.shield,
        title: 'AntiRaid · Tableau de bord',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          c.enabled ? '🟢 La protection est **active**.' : '🔴 La protection est **désactivée**.',
          subtext('Choisissez une section dans le menu pour la régler.'),
        ],
        fields: [
          field('⚡', 'Action (vague)', ACTION_LABELS[c.action] ?? c.action),
          field(ICONS.user, 'Comptes récents / bots', ACTION_LABELS[newAccountAction(c)]),
          field(ICONS.bot, 'Anti-bot', onOff(c.antiBot)),
          field(ICONS.members, 'Vague d\'arrivées', `**${c.joinThreshold}** en **${c.joinWindowSeconds} s**`),
          field(ICONS.date, 'Âge min. du compte', c.minAccountAgeDays ? `**${c.minAccountAgeDays}** j` : 'Aucun'),
          field(ICONS.channel, 'Alertes', c.alertChannel ? `<#${c.alertChannel}>` : 'Logs sécurité'),
          field(ICONS.check, 'Whitelist', `**${wlCount}** entrée${wlCount > 1 ? 's' : ''}`),
          wide('💣', `Actions destructrices (en ${c.destructiveWindowSeconds} s)`, destructiveText(c)),
          wide('🚨', 'Dernier déclenchement', lastTriggerText(client, guildId)),
        ],
        footer: 'Le propriétaire du serveur et la whitelist ne sont jamais sanctionnés',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        c.enabled
          ? actionButton({ command: 'antiraid', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'antiraid', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'antiraid', action: 'simulate', label: 'Simuler', emoji: '🧪', style: ButtonStyle.Primary }),
        actionButton({ command: 'antiraid', action: 'go', args: ['presets'], label: 'Préréglages', emoji: '🎚️' }),
        actionButton({ command: 'antiraid', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function joinsView(client, guildId, notice) {
  const c = cfgOf(client, guildId).antiraid;
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🌊',
        title: 'Vague d\'arrivées',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          `Si **${c.joinThreshold}** membres rejoignent le serveur en moins de **${c.joinWindowSeconds} s**, l'action choisie est appliquée et une alerte est publiée.`,
          subtext('Une alerte (et un lockdown) au plus par minute ; en expulsion/bannissement, chaque nouvelle vague est sanctionnée.'),
        ],
        fields: [
          field(ICONS.members, 'Seuil', `**${c.joinThreshold}** arrivées`),
          field(ICONS.time, 'Fenêtre', `**${c.joinWindowSeconds}** s`),
          field('⚡', 'Action', ACTION_LABELS[c.action] ?? c.action),
        ],
        footer: `Seuil : ${BOUNDS.joinThreshold.join(' à ')} · Fenêtre : ${BOUNDS.joinWindowSeconds.join(' à ')} s`,
      }),
    ],
    components: [
      navRow('joins'),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:antiraid:action')
          .setPlaceholder('Action en cas de vague…')
          .addOptions(Object.entries(WAVE_ACTIONS).map(([value, a]) => ({ value, ...a, default: c.action === value }))),
      ),
      ...buttonRows(
        actionButton({ command: 'antiraid', action: 'set', args: ['joins'], label: 'Seuil et fenêtre', emoji: ICONS.settings, style: ButtonStyle.Primary }),
        backHome(),
      ),
    ],
  };
}

function accountsView(client, guildId, notice) {
  const c = cfgOf(client, guildId).antiraid;
  const current = newAccountAction(c);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🐣',
        title: 'Comptes récents & bots',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          'Les comptes trop récents et les bots ajoutés hors whitelist sont sanctionnés **dès leur arrivée**, indépendamment de l\'action de vague.',
        ],
        fields: [
          field(ICONS.date, 'Âge minimal', c.minAccountAgeDays ? `**${c.minAccountAgeDays}** jour(s)` : 'Aucun (désactivé)'),
          field(ICONS.bot, 'Anti-bot', onOff(c.antiBot)),
          field(ICONS.shield, 'Sanction', ACTION_LABELS[current]),
        ],
        footer: '0 jour = pas de filtre d\'âge',
      }),
    ],
    components: [
      navRow('accounts'),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:antiraid:newaccount')
          .setPlaceholder('Sanction des comptes récents et bots…')
          .addOptions(Object.entries(NEW_ACCOUNT_ACTIONS).map(([value, a]) => ({ value, ...a, default: current === value }))),
      ),
      ...buttonRows(
        c.antiBot
          ? actionButton({ command: 'antiraid', action: 'antibot', args: ['off'], label: 'Anti-bot : oui', emoji: ICONS.bot, style: ButtonStyle.Success })
          : actionButton({ command: 'antiraid', action: 'antibot', args: ['on'], label: 'Anti-bot : non', emoji: ICONS.bot }),
        actionButton({ command: 'antiraid', action: 'set', args: ['accounts'], label: 'Âge minimal', emoji: ICONS.settings, style: ButtonStyle.Primary }),
        backHome(),
      ),
    ],
  };
}

function destructiveView(client, guildId, notice) {
  const c = cfgOf(client, guildId).antiraid;
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '💣',
        title: 'Actions destructrices',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          `Un membre qui supprime trop de salons, de rôles, bannit ou expulse trop de membres en **${c.destructiveWindowSeconds} s** déclenche une alerte et la sanction choisie.`,
          subtext('0 = surveillance désactivée pour ce type d\'action. Détection via le journal d\'audit et les sanctions faites avec le bot. Bannir ou expulser un membre arrivé il y a moins de 10 min (raider) n\'est pas compté.'),
        ],
        fields: [
          field(ICONS.channel, 'Salons supprimés', threshold(c.channelDeleteThreshold)),
          field(ICONS.role, 'Rôles supprimés', threshold(c.roleDeleteThreshold)),
          field(ICONS.ban, 'Bannissements', threshold(c.banThreshold)),
          field(ICONS.kick, 'Expulsions', threshold(c.kickThreshold)),
          field(ICONS.time, 'Fenêtre', `**${c.destructiveWindowSeconds}** s`),
          field(ICONS.shield, 'Sanction de l\'auteur', EXECUTOR_LABELS[c.punishExecutor] ?? c.punishExecutor),
        ],
        footer: 'Le bot, le propriétaire et la whitelist sont exclus',
      }),
    ],
    components: [
      navRow('destructive'),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:antiraid:executor')
          .setPlaceholder('Sanction de l\'auteur…')
          .addOptions(Object.entries(EXECUTOR_ACTIONS).map(([value, a]) => ({ value, ...a, default: c.punishExecutor === value }))),
      ),
      ...buttonRows(
        actionButton({ command: 'antiraid', action: 'set', args: ['destructive'], label: 'Seuils et fenêtre', emoji: ICONS.settings, style: ButtonStyle.Primary }),
        backHome(),
      ),
    ],
  };
}

function alertsView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const id = cfg.antiraid.alertChannel;
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:antiraid:alertch')
    .setPlaceholder('Salon d\'alerte (vide : logs sécurité)')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(1);
  if (id && guild.channels?.cache?.has?.(id)) menu.setDefaultChannels(id);
  const security = cfg.logChannels?.security;
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🔔',
        title: 'Alertes',
        description: [
          notice ? `${notice}\n` : null,
          'Chaque déclenchement publie une alerte dans le salon d\'alerte **et** dans les logs sécurité (une seule fois si c\'est le même salon).',
          id && guild.channels?.cache && !guild.channels.cache.has(id) ? `\n${ICONS.warning} Le salon d'alerte a été supprimé : choisissez-en un autre.` : null,
        ],
        fields: [
          field(ICONS.channel, 'Salon d\'alerte', id ? `<#${id}>` : '*Aucun*'),
          field(ICONS.list, 'Logs sécurité', security ? `<#${security}>` : '*Non configurés* (/logs)'),
        ],
        footer: 'Videz le menu pour n\'utiliser que les logs sécurité',
      }),
    ],
    components: [
      navRow('alerts'),
      new ActionRowBuilder().addComponents(menu),
      ...buttonRows(
        id ? actionButton({ command: 'antiraid', action: 'alerttest', label: 'Tester l\'alerte', emoji: '🧪', style: ButtonStyle.Primary }) : null,
        backHome(),
      ),
    ],
  };
}

/** Entrées de whitelist présélectionnées : existantes en cache (si connu), 25 au plus. */
function whitelistDefaults(cfg, guild) {
  const wl = cfg.whitelist ?? {};
  const roleCache = guild.roles?.cache;
  const roles = (wl.roles ?? []).filter((r) => !roleCache || roleCache.has(r)).slice(0, MAX_WL);
  const users = (wl.users ?? []).slice(0, MAX_WL);
  return { users, roles };
}

function whitelistView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const wl = cfg.whitelist ?? {};
  const { users, roles } = whitelistDefaults(cfg, guild);
  const userMenu = new UserSelectMenuBuilder().setCustomId('cmd:antiraid:wlusers').setPlaceholder('Membres whitelistés (aucun)').setMinValues(0).setMaxValues(MAX_WL);
  if (users.length) userMenu.setDefaultUsers(...users);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('cmd:antiraid:wlroles').setPlaceholder('Rôles whitelistés (aucun)').setMinValues(0).setMaxValues(MAX_WL);
  if (roles.length) roleMenu.setDefaultRoles(...roles);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🔐',
        title: 'Whitelist de sécurité',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          'Ces membres et rôles échappent à **toutes** les sanctions automatiques de l\'AntiRaid (vague, comptes récents, bots, destruction).',
          subtext('Les menus remplacent la sélection actuelle. Aussi disponible : /whitelist.'),
        ],
        fields: [
          wide(ICONS.user, `Membres (${wl.users?.length ?? 0})`, fitList((wl.users ?? []).map((u) => `<@${u}>`)) ?? '*Aucun*'),
          wide(ICONS.role, `Rôles (${wl.roles?.length ?? 0})`, fitList((wl.roles ?? []).map((r) => `<@&${r}>`)) ?? '*Aucun*'),
        ],
        footer: `${MAX_WL} membres et ${MAX_WL} rôles par menu · les entrées au-delà sont conservées`,
      }),
    ],
    components: [
      navRow('whitelist'),
      new ActionRowBuilder().addComponents(userMenu),
      new ActionRowBuilder().addComponents(roleMenu),
      ...buttonRows(backHome()),
    ],
  };
}

function presetsView(notice) {
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🎚️',
        title: 'Préréglages',
        description: [
          notice ? `${ICONS.success} ${notice}\n` : null,
          'Applique une configuration complète et **active** l\'AntiRaid. Le salon d\'alerte et la whitelist **sont conservés**.',
        ],
        fields: Object.values(PRESETS).map((p) => wide(p.emoji, p.label, p.description)),
      }),
    ],
    components: [
      navRow('presets'),
      ...buttonRows(
        ...Object.entries(PRESETS).map(([key, p]) => actionButton({ command: 'antiraid', action: 'preset', args: [key], label: p.label, emoji: p.emoji, style: key === 'equilibre' ? ButtonStyle.Primary : ButtonStyle.Secondary })),
        backHome(),
      ),
    ],
  };
}

/** Rend une vue à partir de son identifiant. */
function render(client, guild, view = 'home', notice) {
  const [name] = String(view).split(/[:.]/);
  switch (name) {
    case 'joins':
      return joinsView(client, guild.id, notice);
    case 'accounts':
      return accountsView(client, guild.id, notice);
    case 'destructive':
      return destructiveView(client, guild.id, notice);
    case 'alerts':
      return alertsView(client, guild, notice);
    case 'whitelist':
      return whitelistView(client, guild, notice);
    case 'presets':
      return presetsView(notice);
    default:
      return homeView(client, guild.id, notice);
  }
}

/** Ancien nom (panneau d'état) : l'accueil du tableau de bord. */
function renderPanel(client, guildId, notice) {
  return homeView(client, guildId, notice);
}

// ---------------------------------------------------------------- simulation

/**
 * Ce que ferait l'AntiRaid avec la configuration actuelle, sans rien exécuter.
 * @param {object} c config `antiraid`
 * @param {{ has?: (flag: bigint) => boolean } | null} perms permissions du bot (null : inconnues)
 * @returns {{ lines: string[], warnings: string[] }}
 */
function simulate(c, perms, { alertChannelOk = true } = {}) {
  const can = (flag) => !perms?.has || perms.has(flag);
  const lines = [];
  const warnings = [];
  const sanction = (a) => (a === 'ban' ? 'banni' : 'expulsé');

  lines.push(`🌊 **${c.joinThreshold}** arrivées en **${c.joinWindowSeconds} s** → ${c.action === 'lockdown' ? 'lockdown du serveur' : `chaque arrivant ${c.action === 'ban' ? 'banni' : 'expulsé'}`} + alerte.`);
  lines.push(c.minAccountAgeDays
    ? `🐣 Un compte créé il y a moins de **${c.minAccountAgeDays}** jour(s) serait **${sanction(newAccountAction(c))}** à son arrivée.`
    : '🐣 Âge du compte non vérifié.');
  lines.push(c.antiBot ? `🤖 Un bot ajouté hors whitelist serait **${sanction(newAccountAction(c))}**.` : '🤖 Les bots ajoutés sont acceptés.');
  const destructive = [
    c.channelDeleteThreshold && `${c.channelDeleteThreshold} salons supprimés`,
    c.roleDeleteThreshold && `${c.roleDeleteThreshold} rôles supprimés`,
    c.banThreshold && `${c.banThreshold} bannissements`,
    c.kickThreshold && `${c.kickThreshold} expulsions`,
  ].filter(Boolean);
  lines.push(destructive.length
    ? `💣 ${destructive.join(' ou ')} en **${c.destructiveWindowSeconds} s** → ${c.punishExecutor === 'none' ? 'alerte seule' : `auteur : ${EXECUTOR_LABELS[c.punishExecutor]?.toLowerCase()}`}.`
    : '💣 Surveillance des actions destructrices désactivée.');

  const needsKick = c.action === 'kick' || ((c.minAccountAgeDays || c.antiBot) && newAccountAction(c) === 'kick');
  const needsBan = c.action === 'ban' || ((c.minAccountAgeDays || c.antiBot) && newAccountAction(c) === 'ban') || (destructive.length && c.punishExecutor === 'ban');
  if (needsKick && !can(PermissionFlagsBits.KickMembers)) warnings.push('Il me manque **Expulser des membres**.');
  if (needsBan && !can(PermissionFlagsBits.BanMembers)) warnings.push('Il me manque **Bannir des membres**.');
  if (c.action === 'lockdown' && !can(PermissionFlagsBits.ManageChannels)) warnings.push('Il me manque **Gérer les salons** (lockdown).');
  if (c.action === 'lockdown' && !can(PermissionFlagsBits.ManageRoles)) warnings.push('Il me manque **Gérer les rôles** (lockdown : permissions des salons).');
  if (destructive.length && c.punishExecutor === 'strip' && !can(PermissionFlagsBits.ManageRoles)) warnings.push('Il me manque **Gérer les rôles** (retrait des rôles).');
  if (destructive.length && !can(PermissionFlagsBits.ViewAuditLog)) warnings.push('Il me manque **Voir les logs du serveur** (détection des destructions).');
  if (!alertChannelOk) warnings.push('Le salon d\'alerte est introuvable.');
  if (!c.enabled) warnings.push('L\'AntiRaid est **désactivé** : rien de tout cela ne se produirait.');
  return { lines, warnings };
}

function simulationCard(client, guild) {
  const c = cfgOf(client, guild.id).antiraid;
  const perms = guild.members?.me?.permissions ?? null;
  const alertChannelOk = !c.alertChannel || !guild.channels?.cache || guild.channels.cache.has(c.alertChannel);
  const { lines, warnings } = simulate(c, perms, { alertChannelOk });
  return card({
    tone: warnings.length ? 'warning' : 'success',
    section: SECTION,
    icon: '🧪',
    title: 'Simulation de l\'AntiRaid',
    description: [
      warnings.length ? `${ICONS.warning} **${warnings.length}** point(s) à vérifier.` : `${ICONS.success} Tout est prêt : voici ce qui se passerait.`,
      '',
      ...lines,
    ],
    fields: [warnings.length ? wide(ICONS.warning, 'À vérifier', bullets(warnings)) : null],
    footer: 'Simulation : aucune sanction ni alerte réelle',
  });
}

// ---------------------------------------------------------------- formulaires

function settingsModal(kind, c) {
  if (kind === 'joins') {
    return new ModalBuilder()
      .setCustomId('cmd:antiraid:setsubmit:joins')
      .setTitle('Vague d\'arrivées')
      .addComponents(
        input('joinThreshold', `Arrivées déclenchant l'alerte (${BOUNDS.joinThreshold.join(' à ')})`, { value: c.joinThreshold, max: 4, required: true }),
        input('joinWindowSeconds', `Fenêtre en secondes (${BOUNDS.joinWindowSeconds.join(' à ')})`, { value: c.joinWindowSeconds, max: 4, required: true }),
      );
  }
  if (kind === 'accounts') {
    return new ModalBuilder()
      .setCustomId('cmd:antiraid:setsubmit:accounts')
      .setTitle('Comptes récents')
      .addComponents(input('minAccountAgeDays', `Âge minimal du compte (jours, 0 à ${BOUNDS.minAccountAgeDays[1]})`, { value: c.minAccountAgeDays ?? 0, max: 4, required: true }));
  }
  return new ModalBuilder()
    .setCustomId('cmd:antiraid:setsubmit:destructive')
    .setTitle('Actions destructrices')
    .addComponents(
      input('channelDeleteThreshold', 'Salons supprimés (0 = désactivé, max 100)', { value: c.channelDeleteThreshold, max: 3 }),
      input('roleDeleteThreshold', 'Rôles supprimés (0 = désactivé, max 100)', { value: c.roleDeleteThreshold, max: 3 }),
      input('banThreshold', 'Bannissements (0 = désactivé, max 100)', { value: c.banThreshold, max: 3 }),
      input('kickThreshold', 'Expulsions (0 = désactivé, max 100)', { value: c.kickThreshold ?? 0, max: 3 }),
      input('destructiveWindowSeconds', 'Fenêtre en secondes (1 à 3600)', { value: c.destructiveWindowSeconds, max: 4 }),
    );
}

const SETTING_FIELDS = {
  joins: [['joinThreshold', 'Seuil'], ['joinWindowSeconds', 'Fenêtre']],
  accounts: [['minAccountAgeDays', 'Âge minimal']],
  destructive: [['channelDeleteThreshold', 'Salons supprimés'], ['roleDeleteThreshold', 'Rôles supprimés'], ['banThreshold', 'Bannissements'], ['kickThreshold', 'Expulsions'], ['destructiveWindowSeconds', 'Fenêtre']],
};

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'security',
  cooldown: 3_000,
  render,
  renderPanel,
  simulate,
  PRESETS,
  BOUNDS,
  data: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Ouvre le tableau de bord de l\'AntiRaid : tout se configure depuis ici.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:antiraid:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** cmd:antiraid:toggle:<on|off> — interrupteur global. */
    async toggle(interaction, client, [state]) {
      guard(interaction);
      const enabled = target(state, cfgOf(client, interaction.guildId).antiraid?.enabled);
      client.services.config.update(interaction.guildId, { antiraid: { enabled } });
      await interaction.update(render(client, interaction.guild, 'home', `AntiRaid **${enabled ? 'activé' : 'désactivé'}**.`));
    },
    /** cmd:antiraid:antibot:<on|off> */
    async antibot(interaction, client, [state]) {
      guard(interaction);
      const antiBot = target(state, cfgOf(client, interaction.guildId).antiraid?.antiBot);
      client.services.config.update(interaction.guildId, { antiraid: { antiBot } });
      await interaction.update(render(client, interaction.guild, 'accounts', `Anti-bot **${antiBot ? 'activé' : 'désactivé'}**.`));
    },
    /** Menu : action en cas de vague. */
    async action(interaction, client) {
      guard(interaction);
      const action = interaction.values?.[0];
      if (!own(WAVE_ACTIONS, action)) throw new UserError('Action inconnue.');
      client.services.config.update(interaction.guildId, { antiraid: { action } });
      await interaction.update(render(client, interaction.guild, 'joins', `Action en cas de vague : **${WAVE_ACTIONS[action].label}**.`));
    },
    /** Menu : sanction des comptes récents et bots. */
    async newaccount(interaction, client) {
      guard(interaction);
      const value = interaction.values?.[0];
      if (!own(NEW_ACCOUNT_ACTIONS, value)) throw new UserError('Sanction inconnue.');
      client.services.config.update(interaction.guildId, { antiraid: { newAccountAction: value } });
      await interaction.update(render(client, interaction.guild, 'accounts', `Comptes récents et bots : **${NEW_ACCOUNT_ACTIONS[value].label}**.`));
    },
    /** Menu : sanction de l'auteur d'actions destructrices. */
    async executor(interaction, client) {
      guard(interaction);
      const punishExecutor = interaction.values?.[0];
      if (!own(EXECUTOR_ACTIONS, punishExecutor)) throw new UserError('Sanction inconnue.');
      client.services.config.update(interaction.guildId, { antiraid: { punishExecutor } });
      await interaction.update(render(client, interaction.guild, 'destructive', `Sanction de l'auteur : **${EXECUTOR_ACTIONS[punishExecutor].label}**.`));
    },
    /** cmd:antiraid:set:<joins|accounts|destructive> — ouvre le formulaire de réglages. */
    async set(interaction, client, [kind]) {
      guard(interaction);
      if (!own(SETTING_FIELDS, kind)) throw new UserError('Réglage inconnu.');
      await interaction.showModal(settingsModal(kind, cfgOf(client, interaction.guildId).antiraid));
    },
    /** cmd:antiraid:setsubmit:<joins|accounts|destructive> */
    async setsubmit(interaction, client, [kind]) {
      guard(interaction);
      const fields = own(SETTING_FIELDS, kind) ? SETTING_FIELDS[kind] : null;
      if (!fields) throw new UserError('Réglage inconnu.');
      const patch = {};
      for (const [key, label] of fields) {
        const v = intField(interaction, key, key, label);
        if (v !== undefined) patch[key] = v;
      }
      if (!Object.keys(patch).length) throw new UserError('Aucune valeur saisie : rien n\'a été modifié.');
      client.services.config.update(interaction.guildId, { antiraid: patch });
      const n = Object.keys(patch).length;
      await interaction.update(render(client, interaction.guild, kind, `${n} paramètre${n > 1 ? 's' : ''} mis à jour.`));
    },
    /** Sélecteur du salon d'alerte (vide : logs sécurité seulement). */
    async alertch(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!/^\d{17,20}$/.test(id)) throw new UserError('Salon invalide.');
        const ch = interaction.guild.channels?.cache?.get(id);
        if (ch && ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)) throw new UserError('Choisissez un salon textuel.');
      }
      client.services.config.update(interaction.guildId, { antiraid: { alertChannel: id } });
      await interaction.update(render(client, interaction.guild, 'alerts', id ? `${ICONS.success} Alertes → <#${id}>.` : `${ICONS.success} Salon d'alerte retiré : les alertes vont dans les logs sécurité.`));
    },
    /** Envoie une alerte de test dans le salon d'alerte. */
    async alerttest(interaction, client) {
      guard(interaction);
      const id = cfgOf(client, interaction.guildId).antiraid.alertChannel;
      if (!id) throw new UserError('Aucun salon d\'alerte configuré.');
      await interaction.deferUpdate();
      const channel = interaction.guild.channels?.cache?.get(id) ?? (await interaction.guild.channels?.fetch?.(id).catch(() => null));
      let ok = false;
      if (channel?.send) {
        ok = await channel
          .send({
            embeds: [card({ tone: 'info', section: SECTION, icon: '🧪', title: 'Alerte de test', description: 'Ce salon reçoit bien les alertes AntiRaid.', fields: [field(ICONS.user, 'Demandé par', `${interaction.user}`)] })],
          })
          .then(() => true, () => false);
      }
      await interaction.editReply(render(client, interaction.guild, 'alerts', ok ? `${ICONS.success} Alerte de test envoyée dans <#${id}>.` : `${ICONS.error} Impossible d'écrire dans <#${id}> : vérifiez mes permissions.`));
    },
    /** Sélecteur des membres whitelistés (remplace la sélection visible). */
    async wlusers(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      const picked = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id));
      const shown = new Set(whitelistDefaults(cfg, interaction.guild).users);
      const hidden = (cfg.whitelist?.users ?? []).filter((id) => !shown.has(id));
      const users = [...new Set([...picked, ...hidden])];
      client.services.config.update(interaction.guildId, { whitelist: { users } });
      await interaction.update(render(client, interaction.guild, 'whitelist', `${users.length} membre(s) whitelisté(s).`));
    },
    /** Sélecteur des rôles whitelistés (remplace la sélection visible ; rôles supprimés nettoyés). */
    async wlroles(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      const picked = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id) && id !== interaction.guildId);
      const shown = new Set(whitelistDefaults(cfg, interaction.guild).roles);
      const cache = interaction.guild.roles?.cache;
      const hidden = (cfg.whitelist?.roles ?? []).filter((id) => !shown.has(id) && (!cache || cache.has(id)));
      const roles = [...new Set([...picked, ...hidden])];
      client.services.config.update(interaction.guildId, { whitelist: { roles } });
      await interaction.update(render(client, interaction.guild, 'whitelist', `${roles.length} rôle(s) whitelisté(s).`));
    },
    /** cmd:antiraid:preset:<faible|equilibre|strict> */
    async preset(interaction, client, [key]) {
      guard(interaction);
      const preset = own(PRESETS, key) ? PRESETS[key] : null;
      if (!preset) throw new UserError('Préréglage inconnu.');
      client.services.config.update(interaction.guildId, { antiraid: preset.patch });
      await interaction.update(render(client, interaction.guild, 'home', `Préréglage ${preset.emoji} **${preset.label}** appliqué. Salon d'alerte et whitelist conservés.`));
    },
    /** Simulation sans effet : nouveau message éphémère (le tableau de bord reste en place). */
    async simulate(interaction, client) {
      guard(interaction);
      await interaction.reply({ embeds: [simulationCard(client, interaction.guild)], ephemeral: true });
    },
  },
};
