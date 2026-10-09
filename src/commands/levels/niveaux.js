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
const { card, field, wide, ICONS, code, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate, progressBar } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { fitList } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { LevelService, progressOf, levelFromXp, totalXpForLevel, DEFAULT_ANNOUNCE, ANNOUNCE_MODES, MAX_LEFT_DAYS } = require('../../services/LevelService');
const { MAX_XP } = require('../../database/repositories/LevelRepository');
const { hasForbiddenPermissions } = require('../roles/rolemenu');
const { UserError } = require('../../core/errors');

/**
 * /niveaux : tableau de bord unique des niveaux (éphémère, « Gérer le serveur »).
 * Vues : home · announce · rewards · exclusions · multipliers · xp · member:<id> ·
 *        confirmReset · confirmMember:<id> · confirmPurge:<jours>
 */

const MAX_LIST = 25;
const MAX_REWARD_LEVEL = 500;
const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const IGNORABLE_TYPES = [...TEXT_TYPES, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory];
const XP_OPS = { give: 'Donner', remove: 'Retirer', set: 'Définir' };

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const cfgOf = (client, guildId) => client.services.config.get(guildId).levels;
const fmt = (n) => Number(n ?? 0).toLocaleString('fr-FR');
const SECTION = 'levels';

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble et réglages de l\'XP' },
  { value: 'announce', label: 'Annonces', emoji: '📣', description: 'Où et comment annoncer un passage de niveau' },
  { value: 'rewards', label: 'Récompenses', emoji: '🎁', description: 'Rôles attribués à certains niveaux' },
  { value: 'exclusions', label: 'Exclusions', emoji: '🚫', description: 'Salons et rôles qui ne gagnent pas d\'XP' },
  { value: 'multipliers', label: 'Multiplicateurs', emoji: '✖️', description: 'Bonus d\'XP par rôle' },
  { value: 'xp', label: 'Gérer l\'XP', emoji: '🧮', description: 'Donner, retirer, importer, réinitialiser' },
];

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:niveaux:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const homeButton = () => actionButton({ command: 'niveaux', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });
const row = (component) => new ActionRowBuilder().addComponents(component);

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return row(t);
};

/** Valeur saisie dans un formulaire (vide → undefined). */
function textField(interaction, id) {
  try {
    const v = interaction.fields.getTextInputValue(id)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Entier borné saisi dans un formulaire (vide = valeur actuelle). */
function intField(interaction, id, min, max, label) {
  const raw = textField(interaction, id);
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/\s/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} : entrez un nombre entier entre ${fmt(min)} et ${fmt(max)}.`);
  return n;
}

/** Multiplicateur saisi (« 1,5 » ou « 1.5 »), 0 = retirer. Pur. */
function parseMultiplier(raw) {
  const n = Number(String(raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 5 || (n > 0 && n < 0.1)) throw new UserError('Multiplicateur : entrez un nombre entre 0,1 et 5 (ex : 1,5), ou 0 pour le retirer.');
  return Math.round(n * 100) / 100;
}

/**
 * Lignes d'import « ID XP » (séparateur espace, « = », « : », « ; » ou virgule). Pur.
 * @returns {{ entries: Array<{ userId: string, xp: number }>, rejected: string[] }}
 */
function parseImport(text) {
  const entries = new Map();
  const rejected = [];
  for (const raw of String(text ?? '').split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^<?@?!?(\d{17,20})>?\s*[=:;,\s]\s*(\d{1,10})$/);
    if (!m || Number(m[2]) > MAX_XP) {
      rejected.push(line);
      continue;
    }
    entries.set(m[1], Number(m[2]));
  }
  if (entries.size > 500) throw new UserError('500 membres maximum par import.');
  return { entries: [...entries].map(([userId, xp]) => ({ userId, xp })), rejected };
}

/** Le rôle peut-il servir de récompense ? (hiérarchie du bot ET de l'auteur, permissions sensibles) */
function assertRewardRole(interaction, roleId) {
  const guild = interaction.guild;
  const role = guild?.roles?.cache?.get(roleId);
  if (!role) throw new UserError('Rôle introuvable.');
  if (role.id === guild.id) throw new UserError('@everyone ne peut pas être une récompense.');
  if (role.managed) throw new UserError(`Le rôle ${role.name} est géré par une intégration et ne peut pas être attribué.`);
  if (hasForbiddenPermissions(role)) throw new UserError(`Le rôle ${role.name} donne des permissions de modération ou d'administration : il ne peut pas être une récompense.`);
  const me = guild.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) throw new UserError('Il me faut la permission **Gérer les rôles** pour attribuer des récompenses.');
  if (role.position >= me.roles.highest.position) throw new UserError(`Le rôle ${role.name} est au-dessus (ou au niveau) de mon rôle le plus haut : je ne pourrai pas l'attribuer.`);
  if (interaction.user.id !== guild.ownerId && role.position >= (interaction.member?.roles?.highest?.position ?? 0)) {
    throw new UserError(`Le rôle ${role.name} est au-dessus (ou au niveau) de votre rôle le plus haut.`);
  }
  return role;
}

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const total = client.repositories.levels.count(guild.id);
  const mode = cfg.announce?.mode ?? 'same';
  return {
    embeds: [
      card({
        tone: cfg.enabled ? 'success' : 'neutral',
        section: SECTION,
        icon: '📈',
        title: 'Niveaux · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          cfg.enabled ? '🟢 Le système de niveaux est **actif**.' : '🔴 Le système de niveaux est **désactivé**.',
          `${ICONS.members} **${fmt(total)}** membre(s) classé(s).`,
          '',
          subtext('Chaque message rapporte de l\'XP (une fois par délai). Les bots, les messages trop courts et ceux supprimés par l\'AutoMod ne comptent pas.'),
        ],
        fields: [
          field('✉️', 'XP par message', `${cfg.xpMin}–${cfg.xpMax}`),
          field(ICONS.duration, 'Délai entre deux gains', `${cfg.cooldownSeconds} s`),
          field('✂️', 'Longueur minimale', `${cfg.minLength} caractère(s)`),
          field(ICONS.voice, 'XP vocale', cfg.voice?.enabled ? `🟢 ${cfg.voice.xpPerMinute} XP / min` : '🔴 Désactivée'),
          field('📣', 'Annonces', `${ANNOUNCE_MODES[mode] ?? mode}${mode === 'channel' ? `\n${cfg.announce?.channelId ? `<#${cfg.announce.channelId}>` : '⚠️ *Aucun salon*'}` : ''}`),
          field(ICONS.gift, 'Récompenses', `${cfg.rewards?.length ?? 0} rôle(s)\n${cfg.stackRewards !== false ? 'Cumulatives' : 'Plus haute seulement'}`),
          field(ICONS.channel, 'Salons exclus', `${cfg.ignoredChannels?.length ?? 0}`),
          field(ICONS.role, 'Rôles exclus', `${cfg.ignoredRoles?.length ?? 0}`),
          field('✖️', 'Multiplicateurs', `${cfg.multipliers?.length ?? 0}`),
        ],
        footer: 'Choisissez une section dans le menu',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        cfg.enabled
          ? actionButton({ command: 'niveaux', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'niveaux', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'niveaux', action: 'settings', label: 'Réglages de l\'XP', emoji: ICONS.settings, style: ButtonStyle.Primary }),
        cfg.voice?.enabled
          ? actionButton({ command: 'niveaux', action: 'voice', args: ['off'], label: 'XP vocale ✅', emoji: ICONS.voice })
          : actionButton({ command: 'niveaux', action: 'voice', args: ['on'], label: 'XP vocale ❌', emoji: ICONS.voice }),
        actionButton({ command: 'niveaux', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function announceView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const mode = cfg.announce?.mode ?? 'same';
  const channelId = cfg.announce?.channelId;
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:niveaux:achannel')
    .setPlaceholder('Salon dédié aux annonces…')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (channelId && guild.channels?.cache?.has(channelId)) menu.setDefaultChannels(channelId);
  return {
    embeds: [
      card({
        tone: mode === 'off' ? 'neutral' : 'info',
        section: SECTION,
        icon: '📣',
        title: 'Annonces de passage de niveau',
        description: [
          notice ? `${notice}\n` : null,
          'Choisissez où annoncer les passages de niveau, puis personnalisez le message.',
          subtext('Variables : {membre} (mention), {niveau}, {pseudo}, {serveur}. Seul le membre concerné est notifié.'),
          mode === 'channel' && !channelId ? `\n${ICONS.warning} Choisissez un **salon dédié** ci-dessous, sinon rien ne sera annoncé.` : null,
        ],
        fields: [
          field(ICONS.status, 'Mode', ANNOUNCE_MODES[mode] ?? mode),
          field(ICONS.channel, 'Salon dédié', channelId ? `<#${channelId}>` : '*Aucun*'),
          wide('📝', 'Message', `\`\`\`\n${truncate(String(cfg.announce?.message || DEFAULT_ANNOUNCE).replace(/`/g, 'ˋ'), 900)}\n\`\`\``),
        ],
        footer: 'En mode « même salon », l\'XP vocale est annoncée dans le salon vocal',
      }),
    ],
    components: [
      navRow('announce'),
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:niveaux:amode')
          .setPlaceholder('Où annoncer ?')
          .addOptions(Object.entries(ANNOUNCE_MODES).map(([value, label]) => ({ value, label, default: value === mode }))),
      ),
      row(menu),
      ...buttonRows(
        actionButton({ command: 'niveaux', action: 'amessage', label: 'Modifier le message', emoji: '📝', style: ButtonStyle.Primary }),
        actionButton({ command: 'niveaux', action: 'apreview', label: 'Aperçu', emoji: '👁️' }),
        homeButton(),
      ),
    ],
  };
}

function rewardsView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const rewards = [...(cfg.rewards ?? [])].sort((a, b) => a.level - b.level);
  const canManage = guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles);
  const lines = rewards.map((r) => {
    const ok = LevelService.assignable(guild, r.roleId);
    return `${ok ? '🎁' : ICONS.warning} Niveau **${r.level}** → <@&${r.roleId}>${ok ? '' : ' · *je ne peux pas l\'attribuer*'}`;
  });
  const components = [
    navRow('rewards'),
    row(new RoleSelectMenuBuilder().setCustomId('cmd:niveaux:rewardrole').setPlaceholder('Ajouter une récompense : choisissez un rôle…').setMinValues(1).setMaxValues(1)),
  ];
  if (rewards.length) {
    const roleName = (id) => guild.roles?.cache?.get(id)?.name ?? 'Rôle supprimé';
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:niveaux:rewardremove')
        .setPlaceholder('Retirer une récompense…')
        .setMinValues(1)
        .setMaxValues(rewards.length)
        .addOptions(rewards.map((r) => ({ value: `${r.level}.${r.roleId}`, label: truncate(`Niveau ${r.level} · ${roleName(r.roleId)}`, 100), emoji: '🗑️' }))),
    ));
  }
  const stack = cfg.stackRewards !== false;
  components.push(...buttonRows(
    stack
      ? actionButton({ command: 'niveaux', action: 'stack', args: ['off'], label: 'Mode : cumulatives', emoji: '📚' })
      : actionButton({ command: 'niveaux', action: 'stack', args: ['on'], label: 'Mode : plus haute seulement', emoji: '🔝' }),
    homeButton(),
  ));
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.gift,
        title: 'Récompenses de niveau',
        description: [
          notice ? `${notice}\n` : null,
          'Choisissez un rôle dans le menu, puis indiquez le niveau qui le débloque.',
          canManage ? null : `\n${ICONS.warning} Il me manque la permission **Gérer les rôles** : aucune récompense ne peut être attribuée.`,
          '',
          lines.length ? lines.join('\n') : '*Aucune récompense pour l\'instant.*',
        ],
        fields: [
          field(ICONS.count, 'Récompenses', `${rewards.length} / ${MAX_LIST}`),
          field('📚', 'Mode', stack ? 'Cumulatives : le membre garde tous les rôles atteints' : 'Plus haute seulement : les paliers inférieurs sont retirés'),
        ],
        footer: 'Les rôles d\'administration ou de modération sont refusés',
      }),
    ],
    components,
  };
}

function exclusionsView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const cache = guild.channels?.cache;
  const roleCache = guild.roles?.cache;
  const channels = (cfg.ignoredChannels ?? []).filter((id) => !cache || IGNORABLE_TYPES.includes(cache.get(id)?.type)).slice(0, MAX_LIST);
  const roles = (cfg.ignoredRoles ?? []).filter((id) => !roleCache || roleCache.has(id)).slice(0, MAX_LIST);
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:niveaux:ignch')
    .setPlaceholder('Salons sans XP (aucun)')
    .setChannelTypes(...IGNORABLE_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_LIST);
  if (channels.length) channelMenu.setDefaultChannels(...channels);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('cmd:niveaux:ignrole').setPlaceholder('Rôles sans XP (aucun)').setMinValues(0).setMaxValues(MAX_LIST);
  if (roles.length) roleMenu.setDefaultRoles(...roles);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🚫',
        title: 'Exclusions',
        description: [
          notice ? `${notice}\n` : null,
          'Les messages (et le vocal) dans ces salons ne rapportent pas d\'XP. Exclure une **catégorie** exclut tous ses salons ; les fils suivent leur salon parent.',
        ],
        fields: [
          field(ICONS.channel, 'Salons exclus', fitList(channels.map((id) => `<#${id}>`), 1000) ?? '*Aucun*'),
          field(ICONS.role, 'Rôles exclus', fitList(roles.map((id) => `<@&${id}>`), 1000) ?? '*Aucun*'),
        ],
        footer: `${MAX_LIST} salons et ${MAX_LIST} rôles maximum`,
      }),
    ],
    components: [navRow('exclusions'), row(channelMenu), row(roleMenu), ...buttonRows(homeButton())],
  };
}

function multipliersView(client, guild, notice) {
  const cfg = cfgOf(client, guild.id);
  const list = [...(cfg.multipliers ?? [])].sort((a, b) => b.multiplier - a.multiplier);
  const components = [
    navRow('multipliers'),
    row(new RoleSelectMenuBuilder().setCustomId('cmd:niveaux:multrole').setPlaceholder('Ajouter ou modifier : choisissez un rôle…').setMinValues(1).setMaxValues(1)),
  ];
  if (list.length) {
    const roleName = (id) => guild.roles?.cache?.get(id)?.name ?? 'Rôle supprimé';
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:niveaux:multremove')
        .setPlaceholder('Retirer un multiplicateur…')
        .setMinValues(1)
        .setMaxValues(list.length)
        .addOptions(list.map((m) => ({ value: m.roleId, label: truncate(`${roleName(m.roleId)} · ×${String(m.multiplier).replace('.', ',')}`, 100), emoji: '🗑️' }))),
    ));
  }
  components.push(...buttonRows(homeButton()));
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '✖️',
        title: 'Multiplicateurs d\'XP',
        description: [
          notice ? `${notice}\n` : null,
          'Un rôle peut multiplier l\'XP gagnée (ex : ×1,5 pour les boosters). Si un membre a plusieurs rôles concernés, **le plus élevé** s\'applique.',
          '',
          list.length ? list.map((m) => `✖️ <@&${m.roleId}> · **×${String(m.multiplier).replace('.', ',')}**`).join('\n') : '*Aucun multiplicateur.*',
        ],
        fields: [field(ICONS.count, 'Multiplicateurs', `${list.length} / ${MAX_LIST}`)],
        footer: 'De ×0,1 à ×5',
      }),
    ],
    components,
  };
}

function userMenu(selected) {
  const menu = new UserSelectMenuBuilder().setCustomId('cmd:niveaux:xpuser').setPlaceholder('Choisir un membre…').setMinValues(1).setMaxValues(1);
  if (selected) menu.setDefaultUsers(selected);
  return row(menu);
}

function xpView(client, guild, notice) {
  const total = client.repositories.levels.count(guild.id);
  const left = client.repositories.levels.countLeft(guild.id);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🧮',
        title: 'Gérer l\'XP',
        description: [
          notice ? `${notice}\n` : null,
          'Choisissez un membre pour lui **donner**, **retirer** ou **définir** de l\'XP, ou importez une liste « ID XP » (par exemple depuis un autre bot).',
          subtext('Les changements faits ici ne déclenchent pas d\'annonce ; les rôles de récompense sont mis à jour.'),
          subtext('Les membres partis quittent le classement mais gardent leur XP (rendue s\'ils reviennent) ; « Membres partis » supprime celle des départs anciens.'),
        ],
        fields: [field(ICONS.members, 'Membres classés', fmt(total)), field('📤', 'Membres partis', fmt(left))],
      }),
    ],
    components: [
      navRow('xp'),
      userMenu(null),
      ...buttonRows(
        actionButton({ command: 'niveaux', action: 'import', label: 'Importer', emoji: '📥', style: ButtonStyle.Primary }),
        actionButton({ command: 'niveaux', action: 'purgeleft', label: 'Membres partis', emoji: '📤', disabled: !left }),
        actionButton({ command: 'niveaux', action: 'go', args: ['confirmReset'], label: 'Tout réinitialiser', emoji: ICONS.delete, style: ButtonStyle.Danger, disabled: !total && !left }),
        homeButton(),
      ),
    ],
  };
}

function memberView(client, guild, userId, notice) {
  if (!SNOWFLAKE.test(userId ?? '')) throw new UserError('Membre invalide.');
  const repo = client.repositories.levels;
  const data = repo.get(guild.id, userId);
  const p = progressOf(data?.xp ?? 0);
  const rank = repo.rank(guild.id, userId);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.user,
        title: 'Gérer l\'XP d\'un membre',
        description: [
          notice ? `${notice}\n` : null,
          `<@${userId}> · **Niveau ${p.level}** · ${rank ? `#${rank}` : data?.left_at != null ? 'parti du serveur' : 'non classé'}`,
          data?.left_at != null ? subtext(`📤 A quitté le serveur ${discordTimestamp(data.left_at, 'R')} : absent du classement, XP conservée.`) : null,
          `\`${progressBar(p.ratio, 16)}\` ${fmt(p.current)} / ${fmt(p.needed)} XP`,
        ],
        fields: [
          field(ICONS.star, 'XP totale', `**${fmt(data?.xp)}**`),
          field(ICONS.channel, 'Messages', fmt(data?.messages)),
          field(ICONS.voice, 'Minutes vocales', fmt(data?.voice_minutes)),
        ],
        footer: `Identifiant ${userId}`,
      }),
    ],
    components: [
      navRow('xp'),
      userMenu(userId),
      ...buttonRows(
        actionButton({ command: 'niveaux', action: 'xp', args: ['give', userId], label: 'Donner', emoji: '➕', style: ButtonStyle.Success }),
        actionButton({ command: 'niveaux', action: 'xp', args: ['remove', userId], label: 'Retirer', emoji: '➖' }),
        actionButton({ command: 'niveaux', action: 'xp', args: ['set', userId], label: 'Définir', emoji: '🎯', style: ButtonStyle.Primary }),
        actionButton({ command: 'niveaux', action: 'go', args: [`confirmMember.${userId}`], label: 'Réinitialiser', emoji: ICONS.delete, style: ButtonStyle.Danger, disabled: !data }),
        actionButton({ command: 'niveaux', action: 'go', args: ['xp'], label: 'Retour', emoji: ICONS.back }),
      ),
    ],
  };
}

function confirmResetView(client, guild) {
  const total = client.repositories.levels.countAll(guild.id);
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Tout réinitialiser ?',
        description: [
          `L'XP, les niveaux et les compteurs des **${fmt(total)}** membre(s) (partis compris) seront **définitivement effacés**.`,
          '',
          subtext('Les rôles de récompense déjà attribués sont conservés. La configuration n\'est pas touchée.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'niveaux', action: 'reset', args: ['guild'], label: 'Oui, tout effacer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'niveaux', action: 'go', args: ['xp'], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

function confirmMemberView(client, guild, userId) {
  if (!SNOWFLAKE.test(userId ?? '')) throw new UserError('Membre invalide.');
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Réinitialiser ce membre ?',
        description: [
          `L'XP, le niveau et les compteurs de <@${userId}> seront **effacés**.`,
          '',
          subtext('Ses rôles de récompense lui seront retirés s\'il est encore sur le serveur.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'niveaux', action: 'reset', args: ['member', userId], label: 'Oui, réinitialiser', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'niveaux', action: 'go', args: [`member.${userId}`], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

/** Nombre de jours d'une purge (bouton ou formulaire). Pur. */
function parseDays(raw) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEFT_DAYS) throw new UserError(`Durée : entrez un nombre entier de jours entre 0 et ${fmt(MAX_LEFT_DAYS)}.`);
  return n;
}

function confirmPurgeView(client, guild, rawDays) {
  const days = parseDays(rawDays);
  const n = client.services.levels.countLeft(guild.id, days);
  const since = days ? `depuis plus de **${days}** jour(s)` : 'quelle que soit la date de leur départ';
  return {
    embeds: [
      card({
        tone: n ? 'danger' : 'info',
        section: SECTION,
        icon: n ? ICONS.warning : ICONS.info,
        title: 'Supprimer l\'XP des membres partis ?',
        description: n
          ? [
            `L'XP, le niveau et les compteurs de **${fmt(n)}** membre(s) parti(s) ${since} seront **définitivement effacés**.`,
            '',
            subtext('S\'ils reviennent, ils repartiront de zéro. Les membres présents ne sont pas concernés.'),
          ]
          : [`Aucun membre parti ${since} n'a d'XP enregistrée.`],
      }),
    ],
    components: buttonRows(
      n ? actionButton({ command: 'niveaux', action: 'purge', args: [days], label: 'Oui, supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }) : null,
      actionButton({ command: 'niveaux', action: 'go', args: ['xp'], label: n ? 'Annuler' : 'Retour', emoji: ICONS.back }),
    ),
  };
}

/** Rend une vue (« member:<id> » depuis un menu, « member.<id> » depuis un bouton). */
function render(client, guild, view = 'home', notice) {
  const [name, arg] = String(view).split(/[:.]/);
  switch (name) {
    case 'announce':
      return announceView(client, guild, notice);
    case 'rewards':
      return rewardsView(client, guild, notice);
    case 'exclusions':
      return exclusionsView(client, guild, notice);
    case 'multipliers':
      return multipliersView(client, guild, notice);
    case 'xp':
      return xpView(client, guild, notice);
    case 'member':
      return memberView(client, guild, arg, notice);
    case 'confirmReset':
      return confirmResetView(client, guild);
    case 'confirmMember':
      return confirmMemberView(client, guild, arg);
    case 'confirmPurge':
      return confirmPurgeView(client, guild, arg);
    default:
      return homeView(client, guild, notice);
  }
}

// ---------------------------------------------------------------- formulaires

function settingsModal(cfg) {
  return new ModalBuilder()
    .setCustomId('cmd:niveaux:settingssubmit')
    .setTitle('Réglages de l\'XP')
    .addComponents(
      input('xpMin', 'XP minimum par message (1 à 1000)', { value: cfg.xpMin, max: 4, required: true }),
      input('xpMax', 'XP maximum par message (1 à 1000)', { value: cfg.xpMax, max: 4, required: true }),
      input('cooldown', 'Délai entre deux gains (secondes, 0 à 3600)', { value: cfg.cooldownSeconds, max: 4, required: true }),
      input('minLength', 'Longueur minimale du message (1 à 200)', { value: cfg.minLength, max: 3, required: true }),
      input('voiceXp', 'XP vocale par minute (1 à 200)', { value: cfg.voice?.xpPerMinute, max: 3, required: true }),
    );
}

function messageModal(cfg) {
  return new ModalBuilder()
    .setCustomId('cmd:niveaux:amessagesubmit')
    .setTitle('Message d\'annonce')
    .addComponents(
      input('message', 'Message ({membre}, {niveau}, {pseudo}…)', {
        value: cfg.announce?.message || DEFAULT_ANNOUNCE,
        placeholder: DEFAULT_ANNOUNCE,
        style: TextInputStyle.Paragraph,
        max: 500,
      }),
    );
}

function rewardModal(role, current) {
  return new ModalBuilder()
    .setCustomId(`cmd:niveaux:rewardsubmit:${role.id}`)
    .setTitle(truncate(`Récompense · ${role.name}`, 45))
    .addComponents(input('level', `Niveau qui débloque ce rôle (1 à ${MAX_REWARD_LEVEL})`, { value: current, max: 3, required: true, placeholder: '10' }));
}

function multiplierModal(role, current) {
  return new ModalBuilder()
    .setCustomId(`cmd:niveaux:multsubmit:${role.id}`)
    .setTitle(truncate(`Multiplicateur · ${role.name}`, 45))
    .addComponents(input('multiplier', 'Multiplicateur (0,1 à 5 ; 0 pour retirer)', { value: current != null ? String(current).replace('.', ',') : '', max: 4, required: true, placeholder: '1,5' }));
}

function xpModal(op, userId) {
  return new ModalBuilder()
    .setCustomId(`cmd:niveaux:xpsubmit:${op}:${userId}`)
    .setTitle(`${XP_OPS[op]} de l'XP`)
    .addComponents(input('amount', op === 'set' ? 'Nouvelle XP totale' : 'Quantité d\'XP', { max: 10, required: true, placeholder: '500' }));
}

function purgeModal() {
  return new ModalBuilder()
    .setCustomId('cmd:niveaux:purgeleftsubmit')
    .setTitle('XP des membres partis')
    .addComponents(input('days', 'Partis depuis plus de (jours, 0 = tous)', { value: 30, max: 4, required: true, placeholder: '30' }));
}

function importModal() {
  return new ModalBuilder()
    .setCustomId('cmd:niveaux:importsubmit')
    .setTitle('Importer de l\'XP')
    .addComponents(
      input('lines', 'Une ligne par membre : ID XP', {
        style: TextInputStyle.Paragraph,
        max: 4000,
        required: true,
        placeholder: '123456789012345678 1500\n234567890123456789 820',
      }),
    );
}

/** Valeur voulue par un bouton « on/off ». */
const target = (state) => {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
};

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'levels',
  cooldown: 3_000,
  render,
  parseImport,
  parseMultiplier,
  parseDays,
  data: new SlashCommandBuilder()
    .setName('niveaux')
    .setDescription('Ouvre le tableau de bord des niveaux : XP, annonces, récompenses, exclusions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
    /** cmd:niveaux:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** cmd:niveaux:toggle:<on|off> — interrupteur global. */
    async toggle(interaction, client, [state]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { levels: { enabled } });
      await interaction.update(homeView(client, interaction.guild, `${ICONS.success} Niveaux **${enabled ? 'activés' : 'désactivés'}**.`));
    },
    /** cmd:niveaux:voice:<on|off> — XP vocale. */
    async voice(interaction, client, [state]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { levels: { voice: { enabled } } });
      await interaction.update(homeView(client, interaction.guild, `${ICONS.success} XP vocale **${enabled ? 'activée' : 'désactivée'}**.`));
    },
    /** Formulaire des réglages de l'XP. */
    async settings(interaction, client) {
      guard(interaction);
      await interaction.showModal(settingsModal(cfgOf(client, interaction.guildId)));
    },
    async settingssubmit(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      const xpMin = intField(interaction, 'xpMin', 1, 1000, 'XP minimum') ?? cfg.xpMin;
      const xpMax = intField(interaction, 'xpMax', 1, 1000, 'XP maximum') ?? cfg.xpMax;
      if (xpMin > xpMax) throw new UserError('L\'XP minimum doit être inférieure ou égale à l\'XP maximum.');
      const cooldownSeconds = intField(interaction, 'cooldown', 0, 3600, 'Délai') ?? cfg.cooldownSeconds;
      const minLength = intField(interaction, 'minLength', 1, 200, 'Longueur minimale') ?? cfg.minLength;
      const xpPerMinute = intField(interaction, 'voiceXp', 1, 200, 'XP vocale') ?? cfg.voice?.xpPerMinute;
      client.services.config.update(interaction.guildId, { levels: { xpMin, xpMax, cooldownSeconds, minLength, voice: { xpPerMinute } } });
      await interaction.update(homeView(client, interaction.guild, `${ICONS.success} Réglages enregistrés.`));
    },
    /** Menu « Où annoncer ? ». */
    async amode(interaction, client) {
      guard(interaction);
      const mode = interaction.values?.[0];
      if (!ANNOUNCE_MODES[mode]) throw new UserError('Mode inconnu.');
      client.services.config.update(interaction.guildId, { levels: { announce: { mode } } });
      await interaction.update(announceView(client, interaction.guild, `${ICONS.success} Annonces : **${ANNOUNCE_MODES[mode]}**.`));
    },
    /** Sélecteur du salon dédié. */
    async achannel(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      let notice = `${ICONS.success} Salon dédié retiré.`;
      if (id) {
        if (!SNOWFLAKE.test(id)) throw new UserError('Salon invalide.');
        const ch = interaction.guild.channels.cache.get(id);
        if (!ch || !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel du serveur.');
        const me = interaction.guild.members?.me;
        const perms = me && ch.permissionsFor?.(me);
        const canSend = !perms || perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
        notice = canSend
          ? `${ICONS.success} Annonces dans <#${id}>.`
          : `${ICONS.warning} Salon enregistré, mais je ne peux pas y écrire : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`;
      }
      const patch = { channelId: id };
      if (id) patch.mode = 'channel';
      client.services.config.update(interaction.guildId, { levels: { announce: patch } });
      await interaction.update(announceView(client, interaction.guild, notice));
    },
    /** Formulaire du message d'annonce. */
    async amessage(interaction, client) {
      guard(interaction);
      await interaction.showModal(messageModal(cfgOf(client, interaction.guildId)));
    },
    async amessagesubmit(interaction, client) {
      guard(interaction);
      const text = textField(interaction, 'message');
      if (text && text.length > 500) throw new UserError('Le message est limité à 500 caractères.');
      const message = !text || text === DEFAULT_ANNOUNCE ? null : text;
      client.services.config.update(interaction.guildId, { levels: { announce: { message } } });
      await interaction.update(announceView(client, interaction.guild, `${ICONS.success} Message ${message ? 'enregistré' : 'par défaut rétabli'}.`));
    },
    /** Aperçu de l'annonce (nouveau message éphémère, le tableau de bord reste en place). */
    async apreview(interaction, client) {
      guard(interaction);
      const cfg = cfgOf(client, interaction.guildId);
      const member = interaction.member ?? { toString: () => `${interaction.user}`, id: interaction.user.id, guild: interaction.guild };
      const embed = client.services.levels.levelUpCard(member, 5, cfg, { xp: totalXpForLevel(5) });
      await interaction.reply({ embeds: [embed], ephemeral: true });
    },
    /** Sélecteur de rôle → formulaire du niveau de la récompense. */
    async rewardrole(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!SNOWFLAKE.test(id ?? '')) throw new UserError('Rôle invalide.');
      const role = assertRewardRole(interaction, id);
      const cfg = cfgOf(client, interaction.guildId);
      const current = (cfg.rewards ?? []).find((r) => r.roleId === id)?.level;
      if (current == null && (cfg.rewards?.length ?? 0) >= MAX_LIST) throw new UserError(`${MAX_LIST} récompenses maximum : retirez-en une d'abord.`);
      await interaction.showModal(rewardModal(role, current));
    },
    /** cmd:niveaux:rewardsubmit:<roleId> */
    async rewardsubmit(interaction, client, [roleId]) {
      guard(interaction);
      if (!SNOWFLAKE.test(roleId ?? '')) throw new UserError('Rôle invalide.');
      assertRewardRole(interaction, roleId);
      const level = intField(interaction, 'level', 1, MAX_REWARD_LEVEL, 'Niveau');
      if (level === undefined) throw new UserError('Indiquez un niveau.');
      const others = (cfgOf(client, interaction.guildId).rewards ?? []).filter((r) => r.roleId !== roleId);
      if (others.length >= MAX_LIST) throw new UserError(`${MAX_LIST} récompenses maximum : retirez-en une d'abord.`);
      const rewards = [...others, { level, roleId }].sort((a, b) => a.level - b.level);
      client.services.config.update(interaction.guildId, { levels: { rewards } });
      await interaction.update(rewardsView(client, interaction.guild, `${ICONS.success} <@&${roleId}> sera attribué au **niveau ${level}**.`));
    },
    /** Menu « Retirer une récompense » (valeurs « niveau.roleId »). */
    async rewardremove(interaction, client) {
      guard(interaction);
      const picked = new Set(interaction.values ?? []);
      const rewards = cfgOf(client, interaction.guildId).rewards ?? [];
      const kept = rewards.filter((r) => !picked.has(`${r.level}.${r.roleId}`));
      client.services.config.update(interaction.guildId, { levels: { rewards: kept } });
      await interaction.update(rewardsView(client, interaction.guild, `${ICONS.success} ${rewards.length - kept.length} récompense(s) retirée(s). Les rôles déjà attribués sont conservés.`));
    },
    /** cmd:niveaux:stack:<on|off> — récompenses cumulatives ou plus haute seulement. */
    async stack(interaction, client, [state]) {
      guard(interaction);
      const stackRewards = target(state);
      client.services.config.update(interaction.guildId, { levels: { stackRewards } });
      await interaction.update(rewardsView(client, interaction.guild, `${ICONS.success} Récompenses **${stackRewards ? 'cumulatives' : 'plus haute seulement'}** (appliqué au prochain passage de niveau).`));
    },
    /** Salons exclus (remplace la liste). */
    async ignch(interaction, client) {
      guard(interaction);
      const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id)).slice(0, MAX_LIST);
      client.services.config.update(interaction.guildId, { levels: { ignoredChannels: ids } });
      await interaction.update(exclusionsView(client, interaction.guild, `${ICONS.success} ${ids.length} salon(s) exclu(s).`));
    },
    /** Rôles exclus (remplace la liste). */
    async ignrole(interaction, client) {
      guard(interaction);
      const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id) && id !== interaction.guildId).slice(0, MAX_LIST);
      client.services.config.update(interaction.guildId, { levels: { ignoredRoles: ids } });
      await interaction.update(exclusionsView(client, interaction.guild, `${ICONS.success} ${ids.length} rôle(s) exclu(s).`));
    },
    /** Sélecteur de rôle → formulaire du multiplicateur. */
    async multrole(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!SNOWFLAKE.test(id ?? '') || id === interaction.guildId) throw new UserError('Choisissez un rôle (pas @everyone : réglez plutôt l\'XP par message).');
      const role = interaction.guild.roles.cache.get(id);
      if (!role) throw new UserError('Rôle introuvable.');
      const cfg = cfgOf(client, interaction.guildId);
      const current = (cfg.multipliers ?? []).find((m) => m.roleId === id)?.multiplier;
      if (current == null && (cfg.multipliers?.length ?? 0) >= MAX_LIST) throw new UserError(`${MAX_LIST} multiplicateurs maximum : retirez-en un d'abord.`);
      await interaction.showModal(multiplierModal(role, current));
    },
    /** cmd:niveaux:multsubmit:<roleId> */
    async multsubmit(interaction, client, [roleId]) {
      guard(interaction);
      if (!SNOWFLAKE.test(roleId ?? '') || roleId === interaction.guildId) throw new UserError('Rôle invalide.');
      const multiplier = parseMultiplier(textField(interaction, 'multiplier'));
      const others = (cfgOf(client, interaction.guildId).multipliers ?? []).filter((m) => m.roleId !== roleId);
      if (multiplier > 0 && others.length >= MAX_LIST) throw new UserError(`${MAX_LIST} multiplicateurs maximum.`);
      const multipliers = multiplier > 0 ? [...others, { roleId, multiplier }] : others;
      client.services.config.update(interaction.guildId, { levels: { multipliers } });
      const notice = multiplier > 0
        ? `${ICONS.success} <@&${roleId}> : XP **×${String(multiplier).replace('.', ',')}**.`
        : `${ICONS.success} Multiplicateur de <@&${roleId}> retiré.`;
      await interaction.update(multipliersView(client, interaction.guild, notice));
    },
    /** Menu « Retirer un multiplicateur ». */
    async multremove(interaction, client) {
      guard(interaction);
      const picked = new Set(interaction.values ?? []);
      const list = cfgOf(client, interaction.guildId).multipliers ?? [];
      const kept = list.filter((m) => !picked.has(m.roleId));
      client.services.config.update(interaction.guildId, { levels: { multipliers: kept } });
      await interaction.update(multipliersView(client, interaction.guild, `${ICONS.success} ${list.length - kept.length} multiplicateur(s) retiré(s).`));
    },
    /** Sélecteur de membre (vue « Gérer l'XP »). */
    async xpuser(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!SNOWFLAKE.test(id ?? '')) throw new UserError('Membre invalide.');
      const user = interaction.users?.get?.(id) ?? interaction.guild.members?.cache?.get(id)?.user;
      if (user?.bot) throw new UserError('Les bots ne gagnent pas d\'XP.');
      await interaction.update(memberView(client, interaction.guild, id));
    },
    /** cmd:niveaux:xp:<give|remove|set>:<userId> — ouvre le formulaire. */
    async xp(interaction, client, [op, userId]) {
      guard(interaction);
      if (!XP_OPS[op] || !SNOWFLAKE.test(userId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.showModal(xpModal(op, userId));
    },
    /** cmd:niveaux:xpsubmit:<op>:<userId> */
    async xpsubmit(interaction, client, [op, userId]) {
      guard(interaction);
      if (!XP_OPS[op] || !SNOWFLAKE.test(userId ?? '')) throw new UserError('Formulaire invalide.');
      const amount = intField(interaction, 'amount', op === 'set' ? 0 : 1, MAX_XP, 'Quantité');
      if (amount === undefined) throw new UserError('Indiquez une quantité d\'XP.');
      await interaction.deferUpdate();
      const { before, after } = await client.services.levels.adminXp(interaction.guild, userId, op, amount);
      const notice = `${ICONS.success} XP de <@${userId}> : ${fmt(before.xp)} → **${fmt(after.xp)}** (niveau ${before.level} → **${after.level}**).`;
      await interaction.editReply(memberView(client, interaction.guild, userId, notice));
    },
    /** Formulaire d'import. */
    async import(interaction) {
      guard(interaction);
      await interaction.showModal(importModal());
    },
    async importsubmit(interaction, client) {
      guard(interaction);
      const { entries, rejected } = parseImport(textField(interaction, 'lines'));
      if (!entries.length) throw new UserError('Aucune ligne valide. Format : `ID XP`, une ligne par membre.');
      const n = client.repositories.levels.importMany(interaction.guildId, entries, levelFromXp);
      const notice = [
        `${ICONS.success} XP importée pour **${n}** membre(s).`,
        rejected.length ? `${ICONS.warning} Ignorée(s) : ${truncate(rejected.slice(0, 10).map(code).join(', '), 500)}` : null,
        subtext('Les rôles de récompense seront attribués au prochain passage de niveau.'),
      ].filter(Boolean).join('\n');
      await interaction.update(xpView(client, interaction.guild, notice));
    },
    /** Formulaire « Supprimer l'XP des membres partis depuis plus de N jours ». */
    async purgeleft(interaction) {
      guard(interaction);
      await interaction.showModal(purgeModal());
    },
    async purgeleftsubmit(interaction, client) {
      guard(interaction);
      const days = parseDays(textField(interaction, 'days') ?? '');
      await interaction.update(confirmPurgeView(client, interaction.guild, days));
    },
    /** cmd:niveaux:purge:<jours> — après confirmation. */
    async purge(interaction, client, [rawDays]) {
      guard(interaction);
      const days = parseDays(rawDays);
      const n = client.services.levels.purgeLeft(interaction.guildId, days);
      await interaction.update(xpView(client, interaction.guild, `${ICONS.success} XP de **${fmt(n)}** membre(s) parti(s) supprimée.`));
    },
    /** cmd:niveaux:reset:guild · cmd:niveaux:reset:member:<id> — après confirmation. */
    async reset(interaction, client, [scope, userId]) {
      guard(interaction);
      if (scope === 'guild') {
        const n = client.services.levels.resetGuild(interaction.guildId);
        await interaction.update(xpView(client, interaction.guild, `${ICONS.success} ${fmt(n)} membre(s) réinitialisé(s).`));
        return;
      }
      if (scope !== 'member' || !SNOWFLAKE.test(userId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.deferUpdate();
      await client.services.levels.resetMember(interaction.guild, userId);
      await interaction.editReply(memberView(client, interaction.guild, userId, `${ICONS.success} <@${userId}> a été réinitialisé.`));
    },
  },
};
