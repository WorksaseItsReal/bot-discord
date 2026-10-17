'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { UserError } = require('../core/errors');
const { permissionLabel } = require('./permissionNames');
const { defaultGuildConfig } = require('../config/defaults');

/**
 * Secur (anti-nuke) : source UNIQUE des modules, préréglages, bornes et niveaux de sécurité.
 * Pur (aucun appel réseau, aucune base) → testable. Utilisé par SecurService, /secur et ses
 * sections, l'AntiRaid historique (accès en attente) et les paquets SEC2 à SEC5.
 */

/**
 * Les 18 modules DÉCLARÉS. Un module n'est actif que s'il est aussi CHARGÉ dans le registre
 * (src/services/secur/modules/*.js) : un module déclaré mais non chargé est « non disponible ».
 * auditTypes : entrées du journal d'audit que le module peut classer (deux modules peuvent
 * partager un type seulement s'ils le déclarent tous les deux ici : roleAdd / roleRemove).
 * undoable : l'action peut être défaite par la file d'annulation.
 */
const SECUR_MODULES = Object.freeze({
  channelCreate: { label: 'Création de salons', emoji: '➕', domain: 'salons', auditTypes: [10], undoable: true },
  channelDelete: { label: 'Suppression de salons', emoji: '🗑️', domain: 'salons', auditTypes: [12], undoable: true },
  channelUpdate: { label: 'Modification de salons', emoji: '✏️', domain: 'salons', auditTypes: [11, 13, 14, 15], undoable: true },
  roleCreate: { label: 'Création de rôles', emoji: '🆕', domain: 'rôles', auditTypes: [30], undoable: true },
  roleDelete: { label: 'Suppression de rôles', emoji: '🧨', domain: 'rôles', auditTypes: [32], undoable: true },
  roleUpdate: { label: 'Modification de rôles', emoji: '🎨', domain: 'rôles', auditTypes: [31], undoable: true },
  roleAdd: { label: 'Rôles sensibles attribués', emoji: '⬆️', domain: 'membres', auditTypes: [25], undoable: true },
  roleRemove: { label: 'Rôles retirés en masse', emoji: '⬇️', domain: 'membres', auditTypes: [25], undoable: true },
  webhook: { label: 'Webhooks', emoji: '🪝', domain: 'salons', auditTypes: [50, 51, 52], undoable: true },
  serverUpdate: { label: 'Paramètres du serveur', emoji: '🏠', domain: 'serveur', auditTypes: [1], undoable: true },
  expressions: { label: 'Emojis et autocollants', emoji: '😀', domain: 'serveur', auditTypes: [60, 61, 62, 90, 91, 92], undoable: true },
  ban: { label: 'Bannissements', emoji: '⛔', domain: 'membres', auditTypes: [22], undoable: true },
  unban: { label: 'Débannissements', emoji: '🔓', domain: 'membres', auditTypes: [23], undoable: true },
  kick: { label: 'Expulsions', emoji: '👢', domain: 'membres', auditTypes: [20, 21], undoable: false },
  bot: { label: 'Ajout de bots', emoji: '🤖', domain: 'membres', auditTypes: [28], undoable: true },
  voiceKick: { label: 'Déconnexions vocales', emoji: '🔇', domain: 'membres', auditTypes: [27], undoable: false },
  everyone: { label: 'Mentions @everyone', emoji: '📢', domain: 'messages', auditTypes: [], undoable: true },
  messagePurge: { label: 'Purges de messages', emoji: '🧹', domain: 'messages', auditTypes: [73], undoable: false },
});
const MODULE_KEYS = Object.freeze(Object.keys(SECUR_MODULES));

/** Valeurs par défaut d'un module (hors clés propres listées dans defaults.js). */
const MODULE_DEFAULTS = Object.freeze({ mode: 'off', punish: 'derank', undo: true, limit: 1, windowSeconds: 10 });

const MODES = Object.freeze(['off', 'on', 'max']);
/** Sanctions, de la plus faible à la plus forte. */
const PUNISH_ORDER = Object.freeze(['none', 'derank', 'kick', 'ban']);
const BOT_EXECUTOR_POLICIES = Object.freeze(['recent', 'always', 'never']);

/** Bornes des réglages (valeurs incluses). */
const SECUR_BOUNDS = Object.freeze({
  limit: [1, 100],
  windowSeconds: [1, 3600],
  minMessages: [2, 100],
  owners: 25,
  trustedBots: 25,
});

/** Options booléennes « tolérantes » que le préréglage max coupe. */
const LENIENT_OPTIONS = Object.freeze(['ignoreBenign', 'dangerousOnly', 'ignoreFollowers']);
/** Limites du préréglage max (les autres modules gardent leur limite par défaut). */
const MAX_LIMITS = Object.freeze({ ban: 2, kick: 2, voiceKick: 3, roleRemove: 2, expressions: 2 });

/** Permissions qu'un exécutant dérangé ne doit plus avoir (outils de nuke). */
const DANGEROUS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ModerateMembers,
]);

/** Niveaux de sécurité, du plus faible au plus fort. */
const LEVELS = Object.freeze(['membre', 'whitelist', 'confiance', 'owner', 'proprietaire-bot', 'proprietaire', 'bot']);
const LEVEL_LABELS = Object.freeze({
  membre: 'Membre',
  whitelist: 'Whitelist',
  confiance: 'Bot de confiance',
  owner: 'Owner de sécurité',
  'proprietaire-bot': 'Propriétaire du bot',
  proprietaire: 'Propriétaire du serveur',
  bot: 'Ce bot',
});
const OWNER_LEVEL_MESSAGE = 'Réservé au propriétaire du serveur et aux owners de sécurité (/secur owner).';

/** Clés interdites comme clés de catalogue (pollution de prototype). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Propriété PROPRE d'un objet (jamais héritée, jamais __proto__ / constructor / prototype). Pur. */
function own(obj, key) {
  return typeof key === 'string' && !FORBIDDEN_KEYS.has(key) && obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Réglages d'un module : défauts communs, défauts propres au module (defaults.js), valeurs stockées. Pur. */
function moduleConfig(cfg, key) {
  const own_ = own(defaultGuildConfig.secur?.modules, key) ? defaultGuildConfig.secur.modules[key] : {};
  const stored = own(cfg?.secur?.modules, key) ? cfg.secur.modules[key] : null;
  return { ...MODULE_DEFAULTS, ...own_, ...(stored && typeof stored === 'object' ? stored : {}) };
}

/** Mode effectif d'un module (valeur inconnue → off). Pur. */
function moduleMode(cfg, key) {
  const mode = moduleConfig(cfg, key).mode;
  return MODES.includes(mode) ? mode : 'off';
}

/** Sanction d'un module (valeur inconnue → derank). Pur. */
function modulePunish(cfg, key) {
  const punish = moduleConfig(cfg, key).punish;
  return PUNISH_ORDER.includes(punish) ? punish : 'derank';
}

const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));

/**
 * Limite effective d'un module : SEUL calcul (panneau, moteur, pré-contrôle). `limit: null`
 * hérite : ban → antiraid.banThreshold, kick → antiraid.kickThreshold (3 si ce seuil vaut 0) ;
 * autre module → 1. Pur.
 */
function effectiveLimit(cfg, key) {
  const raw = moduleConfig(cfg, key).limit;
  if (Number.isInteger(raw)) return clamp(raw, SECUR_BOUNDS.limit);
  const inherited = key === 'ban' ? cfg?.antiraid?.banThreshold : key === 'kick' ? cfg?.antiraid?.kickThreshold : null;
  if (key === 'ban' || key === 'kick') return Number.isInteger(inherited) && inherited > 0 ? clamp(inherited, SECUR_BOUNDS.limit) : 3;
  return 1;
}

/** Fenêtre effective d'un module, en millisecondes. Pur. */
function effectiveWindowMs(cfg, key) {
  const raw = moduleConfig(cfg, key).windowSeconds;
  return clamp(Number.isInteger(raw) ? raw : MODULE_DEFAULTS.windowSeconds, SECUR_BOUNDS.windowSeconds) * 1000;
}

/**
 * Patch de `secur.modules` d'un préréglage. punish et undo ne sont JAMAIS touchés. Pur.
 *  - on : tout en 'on', limites et options par défaut ;
 *  - max : tout en 'max', limites resserrées (MAX_LIMITS), options tolérantes coupées ;
 *  - off : tout en 'off'.
 * @param {'on'|'max'|'off'} name
 * @param {object} defaults bloc secur.modules par défaut (src/config/defaults.js)
 */
function presetPatch(name, defaults) {
  if (!MODES.includes(name)) throw new UserError('Préréglage inconnu.');
  const out = {};
  for (const key of MODULE_KEYS) {
    const def = own(defaults, key) ? defaults[key] : MODULE_DEFAULTS;
    if (name === 'off') {
      out[key] = { mode: 'off' };
      continue;
    }
    const patch = { mode: name, limit: def.limit ?? null, windowSeconds: def.windowSeconds ?? MODULE_DEFAULTS.windowSeconds };
    for (const opt of LENIENT_OPTIONS) if (opt in def) patch[opt] = name === 'max' ? false : def[opt];
    if (name === 'max' && own(MAX_LIMITS, key)) patch.limit = MAX_LIMITS[key];
    out[key] = patch;
  }
  return out;
}

const SECUR_PRESETS = Object.freeze({
  on: { label: 'Protection standard', emoji: '🟢', description: 'Tous les modules en « on » : la whitelist reste exemptée.' },
  max: { label: 'Protection maximale', emoji: '🔴', description: 'Tous les modules en « max » : seuls les owners et bots de confiance sont exemptés.' },
  off: { label: 'Tout couper', emoji: '⚫', description: 'Tous les modules en « off » (l\'AntiRaid historique reste actif s\'il l\'est).' },
});

/** Rôle géré (Booster, rôle de bot) : n'immunise jamais. */
function isManagedRole(guild, roleId) {
  return Boolean(guild?.roles?.cache?.get?.(roleId)?.managed);
}

/**
 * Niveau de sécurité d'un utilisateur. Pur (cache seulement).
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @param {string[]} roleIds rôles du membre
 * @param {object} cfg configuration du serveur
 * @param {{ botOwnerIds?: string[], trustBotOwners?: boolean, pending?: { user?: boolean, roles?: Set<string> }|null,
 *   isBot?: boolean, botId?: string|null }} [opts] pending : accès de whitelist en attente (n'exemptent pas)
 * @returns {'bot'|'proprietaire'|'proprietaire-bot'|'owner'|'confiance'|'whitelist'|'membre'}
 */
function securityLevel(guild, userId, roleIds = [], cfg = {}, { botOwnerIds = [], trustBotOwners = false, pending = null, isBot = false, botId = null } = {}) {
  if (!userId) return 'membre';
  const me = botId ?? guild?.client?.user?.id ?? guild?.members?.me?.id ?? null;
  if (me && userId === me) return 'bot';
  if (guild?.ownerId && userId === guild.ownerId) return 'proprietaire';
  if (trustBotOwners && botOwnerIds.includes(userId)) return 'proprietaire-bot';
  const secur = cfg?.secur ?? {};
  if (!isBot && Array.isArray(secur.owners) && secur.owners.includes(userId)) return 'owner';
  if (isBot && Array.isArray(secur.trustedBots) && secur.trustedBots.includes(userId)) return 'confiance';
  const wl = cfg?.whitelist ?? {};
  if (Array.isArray(wl.users) && wl.users.includes(userId) && !pending?.user) return 'whitelist';
  const roles = Array.isArray(wl.roles) ? wl.roles : [];
  if (roleIds.some((r) => roles.includes(r) && !isManagedRole(guild, r) && !pending?.roles?.has?.(r))) return 'whitelist';
  return 'membre';
}

/** Rang d'un niveau (0 = membre). Pur. */
function levelRank(level) {
  const i = LEVELS.indexOf(level);
  return i < 0 ? 0 : i;
}

/**
 * Exemption d'un niveau selon le mode du module. Pur.
 *  - on : whitelist, bots de confiance et au-dessus ;
 *  - max : owners et au-dessus, plus les bots de confiance ;
 *  - off : module coupé, rien n'est compté.
 */
function isExempt(level, mode) {
  if (mode === 'off') return true;
  if (mode === 'max') return level === 'confiance' || levelRank(level) >= levelRank('owner');
  return levelRank(level) >= levelRank('whitelist');
}

/** Niveau owner (owner de sécurité, propriétaire du bot de confiance, propriétaire). Pur. */
function isOwnerLevel(level) {
  return ['owner', 'proprietaire-bot', 'proprietaire'].includes(level);
}

/** Peut gérer la liste des owners : le propriétaire, plus OWNER_IDS si la confiance est activée. Pur. */
function canManageOwners(guild, userId, { botOwnerIds = [], trustBotOwners = false } = {}) {
  if (!userId) return false;
  if (guild?.ownerId && userId === guild.ownerId) return true;
  return Boolean(trustBotOwners && botOwnerIds.includes(userId));
}

/** Niveau owner d'un utilisateur (pas besoin de ses rôles). Pur. */
function hasOwnerLevel(guild, userId, cfg, opts = {}) {
  return isOwnerLevel(securityLevel(guild, userId, [], cfg, { ...opts, isBot: false }));
}

/** Lève l'UserError « réservé au propriétaire et aux owners » sans niveau owner. */
function assertOwnerLevel(guild, userId, cfg, opts = {}) {
  if (!hasOwnerLevel(guild, userId, cfg, opts)) throw new UserError(OWNER_LEVEL_MESSAGE);
}

/** Libellés français des permissions DANGEROUS présentes dans un champ de bits. Pur. */
function dangerousNames(permissions) {
  if (!permissions?.has) return [];
  if (permissions.has(PermissionFlagsBits.Administrator)) return [permissionLabel('Administrator')];
  return new PermissionsBitField(DANGEROUS).toArray().filter((p) => permissions.has(PermissionFlagsBits[p])).map((p) => permissionLabel(p));
}

/**
 * Exposition : membres en cache ayant une permission DANGEROUS (ce bot exclu), bots en tête,
 * avec leur niveau et leur exemption en on / max. Pur (cache seulement : partiel sur les très
 * grands serveurs).
 * @returns {Array<{ id: string, bot: boolean, perms: string[], level: string, exemptOn: boolean, exemptMax: boolean }>}
 */
function exposure(guild, cfg, opts = {}) {
  const me = opts.botId ?? guild?.client?.user?.id ?? guild?.members?.me?.id;
  const out = [];
  for (const member of guild?.members?.cache?.values?.() ?? []) {
    if (member.id === me) continue;
    if (!member.permissions?.any?.(DANGEROUS)) continue;
    const isBot = Boolean(member.user?.bot);
    const level = securityLevel(guild, member.id, [...(member.roles?.cache?.keys?.() ?? [])], cfg, { ...opts, isBot, pending: opts.pendingOf?.(member.id) ?? null });
    out.push({ id: member.id, bot: isBot, perms: dangerousNames(member.permissions), level, exemptOn: isExempt(level, 'on'), exemptMax: isExempt(level, 'max') });
  }
  return out.sort((a, b) => Number(b.bot) - Number(a.bot) || levelRank(b.level) - levelRank(a.level) || a.id.localeCompare(b.id));
}

/**
 * Rôle sensible POUR SECUR (partagé par SEC4 et SEC5) : permission DANGEROUS (surcharges de salon
 * comprises), rôle de whitelist.roles, ou rôle de niveau ≥ 2 (services.permissions.levelOf, ADM1).
 * N'utilise JAMAIS hasForbiddenPermissions (qui inclura le niveau 1). Pur.
 * @param {import('discord.js').Role} role
 * @param {object} cfg
 * @param {{ levelOf?: (guildId: string, roleId: string) => number }} [opts]
 */
function isSensitiveRole(role, cfg, { levelOf } = {}) {
  if (!role) return false;
  if (role.permissions?.any?.(DANGEROUS)) return true;
  const guild = role.guild;
  for (const channel of guild?.channels?.cache?.values?.() ?? []) {
    if (channel.permissionOverwrites?.cache?.get?.(role.id)?.allow?.any?.(DANGEROUS)) return true;
  }
  if (Array.isArray(cfg?.whitelist?.roles) && cfg.whitelist.roles.includes(role.id)) return true;
  const level = typeof levelOf === 'function' ? Number(levelOf(guild?.id, role.id)) || 0 : 0;
  return level >= 2;
}

module.exports = {
  SECUR_MODULES,
  MODULE_KEYS,
  MODULE_DEFAULTS,
  MODES,
  PUNISH_ORDER,
  BOT_EXECUTOR_POLICIES,
  SECUR_BOUNDS,
  SECUR_PRESETS,
  MAX_LIMITS,
  LENIENT_OPTIONS,
  DANGEROUS,
  LEVELS,
  LEVEL_LABELS,
  OWNER_LEVEL_MESSAGE,
  own,
  moduleConfig,
  moduleMode,
  modulePunish,
  effectiveLimit,
  effectiveWindowMs,
  presetPatch,
  securityLevel,
  levelRank,
  isExempt,
  isOwnerLevel,
  canManageOwners,
  hasOwnerLevel,
  assertOwnerLevel,
  dangerousNames,
  exposure,
  isSensitiveRole,
};
