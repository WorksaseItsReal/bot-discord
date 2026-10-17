'use strict';

const { PermissionFlagsBits, PermissionsBitField, escapeMarkdown } = require('discord.js');
const { own } = require('../utils/secur');
const { LEVELS, isAssignable, isDelegable } = require('../utils/access');
const { card, field, ICONS } = require('../utils/ui');
const { permissionLabel } = require('../utils/permissionNames');
const { createLogger } = require('../core/logger');

const logger = createLogger('permissions');

/** Rôles par niveau, au plus. */
const MAX_LEVEL_ROLES = 10;
/** Nom d'un niveau, au plus (caractères). */
const MAX_LEVEL_NAME = 32;
/** Cache de lecture des surcharges « Intégrations » des commandes. */
const OVERRIDES_TTL_MS = 5 * 60_000;
/** Relecture forcée des surcharges : au plus une fois par période. */
const OVERRIDES_FORCE_MS = 30_000;
/** Serveurs gardés en cache des surcharges, au plus. */
const OVERRIDES_MAX_GUILDS = 500;
/** Type de surcharge Discord : rôle. */
const OVERRIDE_ROLE = 1;

const isSnowflake = (v) => typeof v === 'string' && /^\d{17,20}$/.test(v);

/** Libellé par défaut d'un niveau. Pur. */
function defaultLevelName(n) {
  return `Niveau ${n}`;
}

/**
 * Réglages normalisés (valeurs abîmées ignorées, pollution de prototype refusée). Pur.
 * @returns {{ levels: Record<1|2|3, { name: string|null, roles: string[] }>, commands: Record<string, 1|2|3>, strict: boolean }}
 */
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const levels = {};
  for (const n of LEVELS) {
    const l = own(src.levels, `l${n}`) && src.levels[`l${n}`] && typeof src.levels[`l${n}`] === 'object' ? src.levels[`l${n}`] : {};
    const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, MAX_LEVEL_NAME) : null;
    const roles = [...new Set((Array.isArray(l.roles) ? l.roles : []).filter(isSnowflake))].slice(0, MAX_LEVEL_ROLES);
    levels[n] = { name, roles };
  }
  const commands = {};
  if (src.commands && typeof src.commands === 'object' && !Array.isArray(src.commands)) {
    for (const key of Object.keys(src.commands)) {
      const v = src.commands[key];
      if (own(src.commands, key) && LEVELS.includes(v) && /^[-_\p{Ll}\p{N}]{1,32}$/u.test(key)) commands[key] = v;
    }
  }
  return { levels, commands, strict: src.strict === true };
}

/** Gel récursif (réglages normalisés partagés). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Identifiants des rôles d'un membre (GuildMember, membre brut de l'API). Pur. */
function roleIdsOf(member) {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  if (member.roles?.cache?.keys) return [...member.roles.cache.keys()];
  return Array.isArray(member._roles) ? member._roles : [];
}

/** Permissions d'un membre en PermissionsBitField (objet discord.js ou chaîne brute). Pur. */
function permsOf(value) {
  if (!value) return null;
  if (typeof value.has === 'function') return value;
  try {
    return new PermissionsBitField(BigInt(value));
  } catch {
    return null;
  }
}

/**
 * Niveaux de permissions (/permissions) : rangs, rôles de niveau, commandes attribuées, lecture
 * des surcharges « Intégrations » (un jeton de bot ne peut pas les écrire). Tout est dans
 * guild_config (purgé avec la config) ; aucun minuteur.
 *
 * Rangs (rankOf) : 5 propriétaire du serveur (plus OWNER_IDS si SECUR_TRUST_BOT_OWNERS=on) ;
 * 4 owner de sécurité (secur.owners) ; 3, 2, 1 niveau le plus haut parmi les rôles ; 0 membre.
 * Administrateur vaut 3 pour les comparaisons, jamais 4.
 */
class PermissionService {
  /**
   * @param {{ client: import('discord.js').Client, config: import('./ConfigService').ConfigService, logging?: import('./LoggingService').LoggingService }} deps
   */
  constructor({ client, config, logging = null }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    /** @type {Map<string, { at: number, entries: Map<string, object[]>|null, names: Map<string, string>, appId: string|null, error: string|null }>} */
    this.overrides = new Map();
    /** @type {WeakMap<object, ReturnType<typeof normalizeSettings>>} réglages normalisés, par objet de configuration */
    this.normalized = new WeakMap();
    // Méthodes passées seules à d'autres modules (isSensitiveRole({ levelOf })…) : liées.
    this.levelOf = this.levelOf.bind(this);
    this.isLevelRole = this.isLevelRole.bind(this);
    this.rankOf = this.rankOf.bind(this);
  }

  /**
   * Réglages normalisés d'un serveur (figés, partagés : ne jamais les modifier). Mémorisés par
   * objet de configuration : ConfigService.update produit un nouvel objet, donc un nouveau calcul.
   */
  settings(guildId) {
    const raw = this.config.get(guildId)?.permissions;
    if (!raw || typeof raw !== 'object') return normalizeSettings(raw);
    let settings = this.normalized.get(raw);
    if (!settings) {
      settings = deepFreeze(normalizeSettings(raw));
      this.normalized.set(raw, settings);
    }
    return settings;
  }

  /** Nom affiché d'un niveau. */
  levelName(guildId, n) {
    return this.settings(guildId).levels[n]?.name ?? defaultLevelName(n);
  }

  /** Niveau (0..3) d'un rôle : le plus haut niveau qui le contient (@everyone : jamais). */
  levelOf(guildId, roleId) {
    if (!guildId || !roleId || roleId === guildId) return 0;
    const { levels } = this.settings(guildId);
    for (const n of [...LEVELS].reverse()) if (levels[n].roles.includes(roleId)) return n;
    return 0;
  }

  /** Rôle de niveau (1, 2 ou 3) ? */
  isLevelRole(guildId, roleId) {
    return this.levelOf(guildId, roleId) > 0;
  }

  /** Niveau (0..3) le plus haut parmi des rôles (@everyone : jamais). */
  memberLevel(guildId, roleIds = []) {
    if (!guildId) return 0;
    const { levels } = this.settings(guildId);
    const ids = new Set(roleIds);
    ids.delete(guildId);
    for (const n of [...LEVELS].reverse()) if (levels[n].roles.some((id) => ids.has(id))) return n;
    return 0;
  }

  /** Niveau (1..3) auquel une commande est attribuée, 0 sinon. */
  assignedLevel(guildId, name) {
    if (!guildId || !name) return 0;
    const { commands } = this.settings(guildId);
    return own(commands, name) ? commands[name] : 0;
  }

  /** Commandes attribuées EXISTANTES et attribuables : [{ name, level, command, delegable }]. */
  assignments(guildId) {
    const out = [];
    for (const [name, level] of Object.entries(this.settings(guildId).commands)) {
      const command = this.client?.commands?.get?.(name);
      if (!isAssignable(name, command)) continue;
      out.push({ name, level, command, delegable: isDelegable(name, command) });
    }
    return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  }

  /** Rôle protégé des attributions automatiques : rôle de niveau ou rôle de whitelist. */
  isProtectedRole(guildId, roleId) {
    if (!guildId || !roleId) return false;
    if (this.isLevelRole(guildId, roleId)) return true;
    const roles = this.config.get(guildId)?.whitelist?.roles;
    return Array.isArray(roles) && roles.includes(roleId);
  }

  /**
   * Rang (0..5) d'un membre, relu à chaque appel.
   * @param {import('discord.js').GuildMember|object} member
   * @param {{ guild?: import('discord.js').Guild, permissions?: import('discord.js').PermissionsBitField|string|null }} [opts]
   *   permissions : permissions de l'interaction (memberPermissions), sinon celles du membre
   */
  rankOf(member, { guild = member?.guild, permissions = null } = {}) {
    const id = member?.id ?? member?.user?.id;
    if (!id || !guild?.id) return 0;
    if (guild.ownerId && guild.ownerId === id) return 5;
    const bot = this.client?.config ?? {};
    if (bot.securTrustBotOwners && Array.isArray(bot.ownerIds) && bot.ownerIds.includes(id)) return 5;
    const cfg = this.config.get(guild.id);
    if (!member?.user?.bot && Array.isArray(cfg?.secur?.owners) && cfg.secur.owners.includes(id)) return 4;
    const level = this.memberLevel(guild.id, roleIdsOf(member));
    const perms = permsOf(permissions) ?? permsOf(member?.permissions);
    return Math.max(level, perms?.has?.(PermissionFlagsBits.Administrator) ? 3 : 0);
  }

  /** Source lisible du rang d'un membre (vérifications). */
  rankSource(member, opts = {}) {
    const guild = opts.guild ?? member?.guild;
    const id = member?.id ?? member?.user?.id;
    const rank = this.rankOf(member, opts);
    if (rank === 5) return guild?.ownerId === id ? 'propriétaire du serveur' : 'propriétaire du bot (SECUR_TRUST_BOT_OWNERS)';
    if (rank === 4) return 'owner de sécurité (/secur owner)';
    const level = this.memberLevel(guild?.id, roleIdsOf(member));
    if (level && level === rank) {
      const role = roleIdsOf(member).find((r) => this.levelOf(guild.id, r) === level);
      return `${escapeMarkdown(this.levelName(guild.id, level))} (<@&${role}>)`;
    }
    if (rank === 3) return 'Administrateur (vaut le niveau 3)';
    return 'membre';
  }

  /**
   * Autre attribution automatique qui utilise déjà ce rôle (libellé), ou null : arrivée,
   * vérification, niveaux, vocal, boost, anniversaire, mute, inactif, rôle soutien, menus de
   * rôles, boutique, candidatures.
   */
  autoRoleUse(guildId, roleId) {
    const cfg = this.config.get(guildId);
    // Chargement paresseux : SupportRoleService → AutomationService → rolemenu.js.
    const { otherAutoRoleUse } = require('./SupportRoleService');
    const fromConfig = otherAutoRoleUse(cfg, roleId);
    if (fromConfig) return fromConfig;
    if (cfg?.support?.roleId === roleId) return 'le rôle soutien (/automatisations)';
    const repos = this.client?.repositories ?? {};
    try {
      if ((repos.economy?.listItems?.(guildId) ?? []).some((item) => item?.role_id === roleId)) return 'un article de la boutique (/economie)';
    } catch (err) {
      logger.debug(`Boutique illisible (${guildId}) :`, err?.message);
    }
    try {
      if ((repos.applications?.listForms?.(guildId) ?? []).some((form) => (form?.role_ids ?? []).includes(roleId))) return 'un formulaire de candidature (/candidatures)';
    } catch (err) {
      logger.debug(`Candidatures illisibles (${guildId}) :`, err?.message);
    }
    try {
      const db = this.client?.database?.db;
      const rows = db?.prepare?.('SELECT data FROM role_menus WHERE guild_id = ?').all(guildId) ?? [];
      for (const row of rows) {
        const data = JSON.parse(row.data ?? '{}');
        if ((data?.roles ?? []).some((r) => r?.roleId === roleId)) return 'un menu de rôles (/rolemenu)';
      }
    } catch (err) {
      logger.debug(`Menus de rôles illisibles (${guildId}) :`, err?.message);
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Surcharges « Intégrations » (lecture seule)                          */
  /* ------------------------------------------------------------------ */

  /**
   * Surcharges des commandes (Paramètres du serveur → Intégrations), en cache 5 min. Un jeton de
   * bot ne peut pas les écrire : on les lit pour signaler les commandes déléguées invisibles.
   * Ne lève jamais : { entries, names, appId, error, at }.
   */
  async integrationOverrides(guild, { force = false } = {}) {
    const now = Date.now();
    const cached = this.overrides.get(guild.id);
    if (cached && (now - cached.at < (force ? OVERRIDES_FORCE_MS : OVERRIDES_TTL_MS))) return cached;
    const result = { at: now, entries: null, names: new Map(), appId: this.client?.application?.id ?? null, error: null };
    try {
      const fetched = await guild.commands.permissions.fetch({});
      result.entries = new Map([...(fetched?.entries?.() ?? [])].map(([id, list]) => [id, Array.isArray(list) ? list : []]));
      const add = (collection) => {
        for (const cmd of collection?.values?.() ?? []) if (cmd?.id && cmd?.name) result.names.set(cmd.id, cmd.name);
      };
      add(this.client?.application?.commands?.cache);
      if (!result.names.size) add(await this.client?.application?.commands?.fetch?.().catch(() => null));
      add(guild.commands?.cache);
      if (!result.names.size) add(await guild.commands?.fetch?.().catch(() => null));
    } catch (err) {
      result.error = err?.message ? String(err.message).slice(0, 200) : 'erreur inconnue';
      logger.debug(`Surcharges des commandes illisibles (${guild.id}) :`, result.error);
    }
    if (this.overrides.size >= OVERRIDES_MAX_GUILDS && !this.overrides.has(guild.id)) this.overrides.delete(this.overrides.keys().next().value);
    this.overrides.set(guild.id, result);
    return result;
  }

  /**
   * Visibilité d'une commande déléguée pour les rôles d'un niveau, d'après les surcharges lues :
   * 'visible' (un rôle du niveau, ou @everyone, autorisé), 'hidden' (Discord la masque aux membres
   * sans la permission déclarée), 'unknown' (commande non enregistrée, ou lecture impossible). Pur.
   */
  static visibility(status, guild, name, roleIds) {
    if (!status || status.error || !status.entries) return 'unknown';
    const id = [...status.names].find(([, n]) => n === name)?.[0] ?? null;
    if (!id) return 'unknown';
    const list = status.entries.get(id) ?? (status.appId ? status.entries.get(status.appId) : null) ?? [];
    const allowed = new Set([...roleIds, guild.id]);
    return list.some((p) => p?.type === OVERRIDE_ROLE && p.permission === true && allowed.has(p.id)) ? 'visible' : 'hidden';
  }

  /** Oublie le cache d'un serveur quitté. */
  forgetGuild(guildId) {
    this.overrides.delete(guildId);
  }

  /* ------------------------------------------------------------------ */
  /* Logs                                                                */
  /* ------------------------------------------------------------------ */

  /** Log « permissions » (avant → après), APRÈS la réponse. Ne lève jamais. */
  async logChange(guild, user, lines) {
    if (!lines?.length) return false;
    const embed = card({
      tone: 'warning',
      section: 'security',
      icon: '🔑',
      title: 'Permissions par niveaux modifiées',
      description: lines.slice(0, 15).map((l) => `• ${l}`).join('\n'),
      fields: [field(ICONS.moderator, 'Par', `<@${user.id}>`)],
    });
    return this.logging?.send?.(guild.id, 'security', embed, undefined, { event: 'permissions' }).catch(() => false) ?? false;
  }

  /** Log « permissionUse » : commande exécutée par délégation, APRÈS la réponse. Ne lève jamais. */
  async logUse(interaction, grant) {
    try {
      const sub = interaction.options?.getSubcommand?.(false);
      const missing = new PermissionsBitField(grant.flags).toArray();
      const custom = this.settings(interaction.guildId).levels[grant.level]?.name;
      const embed = card({
        tone: 'info',
        section: 'security',
        icon: '🔑',
        title: 'Commande exécutée par délégation',
        description: `${interaction.user} a utilisé **/${grant.key}${sub ? ` ${sub}` : ''}** grâce au **niveau ${grant.level}**${custom ? ` (${escapeMarkdown(custom)})` : ''}, sans la permission ${missing.map((p) => `**${permissionLabel(p)}**`).join(', ')}.`,
        fields: [
          field(ICONS.user, 'Membre', `<@${interaction.user.id}>`),
          field(ICONS.channel, 'Salon', interaction.channelId ? `<#${interaction.channelId}>` : '—'),
          field('🔑', 'Niveau', `${grant.level} (rang ${grant.rank})`),
        ],
      });
      return await this.logging?.send?.(interaction.guildId, 'security', embed, undefined, { event: 'permissionUse' });
    } catch (err) {
      logger.debug('Log de délégation impossible :', err?.message);
      return false;
    }
  }
}

module.exports = {
  PermissionService,
  normalizeSettings,
  roleIdsOf,
  defaultLevelName,
  MAX_LEVEL_ROLES,
  MAX_LEVEL_NAME,
  OVERRIDES_TTL_MS,
};
