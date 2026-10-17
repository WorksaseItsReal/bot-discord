'use strict';

const { PermissionFlagsBits, AuditLogEvent, SnowflakeUtil, escapeMarkdown, ButtonBuilder } = require('discord.js');
const { SlidingWindow } = require('../utils/rate');
const { card, field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle, fitEmbeds } = require('../utils/ui');
const { createLogger } = require('../core/logger');
const { SecurNotifier } = require('./secur/notify');

const logger = createLogger('antiraid');
const DAY_MS = 24 * 60 * 60 * 1000;
/** Délai minimal entre deux alertes « vague d'arrivées » (et lockdowns auto) par serveur. */
const JOIN_ALERT_COOLDOWN_MS = 60_000;
/** Fréquence de purge des fenêtres d'actions destructrices vides (mémoire bornée). */
const WINDOW_PRUNE_INTERVAL_MS = 60_000;
/**
 * Alertes « nouveau membre sanctionné » publiées par minute et par serveur ; au-delà (raid), et
 * pendant une vague, elles sont regroupées dans une carte récapitulative par minute.
 */
const MEMBER_ALERTS_PER_MINUTE = 3;
/** Période des cartes récapitulatives pendant un raid. */
const DIGEST_INTERVAL_MS = 60_000;

/** Plafond de membres sanctionnés par déclenchement de vague (garde-fou contre un faux positif massif). */
const MAX_WAVE_PUNISH = 50;
/** Sanctions possibles pour les nouveaux comptes / bots non autorisés (indépendantes de l'action de vague). */
const NEW_ACCOUNT_ACTIONS = new Set(['kick', 'ban']);

/**
 * Sanction appliquée aux comptes trop récents / bots : `antiraid.newAccountAction`.
 * Non réglée : reprend l'ancienne règle (« ban » si l'action anti-raid est le ban, sinon kick). Pur.
 */
function newAccountAction(cfg) {
  if (NEW_ACCOUNT_ACTIONS.has(cfg?.newAccountAction)) return cfg.newAccountAction;
  return cfg?.action === 'ban' ? 'ban' : 'kick';
}

/**
 * Un ban dont la cible a rejoint le serveur il y a moins de 10 minutes (ou pendant
 * une vague détectée depuis) n'est pas compté comme destructeur : un modérateur qui
 * bannit des raiders ne doit pas être sanctionné par l'AntiRaid.
 */
const RECENT_JOIN_MS = 10 * 60_000;
/** Plafond d'arrivants récents mémorisés par serveur (mémoire bornée pendant un raid). */
const MAX_RECENT_JOINERS = 5_000;
/**
 * Salons créés récemment (journal d'audit) : supprimer un salon que l'on a soi-même créé (ticket,
 * vocal temporaire d'un bot tiers) n'est pas destructeur. Mémoire bornée par serveur et par durée.
 */
const CREATED_CHANNEL_TTL_MS = 7 * DAY_MS;
const MAX_CREATED_CHANNELS = 2_000;
/**
 * Mémoire perdue (redémarrage, salon créé pendant une coupure) : le créateur est relu dans le
 * journal d'audit (ChannelCreate), au plus une lecture par auteur et par minute.
 */
const CREATOR_AUDIT_COOLDOWN_MS = 60_000;
/**
 * Rôles GÉRÉS supprimés (bot expulsé, intégration retirée) : l'entrée d'audit 32 est signée de
 * l'auteur de l'expulsion, mais c'est Discord qui supprime le rôle. GUILD_ROLE_DELETE arrive en
 * général avant l'entrée d'audit (rôle déjà sorti du cache) : il est mémorisé 60 s.
 */
const MANAGED_ROLE_TTL_MS = 60_000;
/** Permissions qu'un exécutant « dépouillé » ne doit plus avoir (sinon la sanction a échoué). */
const DANGEROUS_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageGuild,
  // Autres outils de nuke : expulsions, exclusions, webhooks (spam), émojis/autocollants, purge, pings de masse.
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
]);

const DESTRUCTIVE_LABELS = { channelDelete: 'Suppressions de salons', roleDelete: 'Suppressions de rôles', ban: 'Bannissements', kick: 'Expulsions' };
/** Bot auteur arrivé depuis moins de 7 jours : expulsé au lieu du retrait des rôles (secur.botExecutor). */
const RECENT_BOT_MS = 7 * DAY_MS;
const BOT_EXECUTOR_POLICIES = new Set(['recent', 'always', 'never']);
/** Hook de vague (services.raidResponse.onWave, SEC3) : attendu 2 s au plus. */
const ON_WAVE_TIMEOUT_MS = 2_000;
/** Sanctions de membres : expulser ou bannir un arrivant récent (raider) n'est pas compté. */
const MEMBER_SANCTIONS = new Set(['ban', 'kick']);
const EXECUTOR_LABELS = { strip: 'Rôles retirés', ban: 'Banni', kick: 'Expulsé', none: 'Aucune' };

/** Bouton « Expulser ce bot » d'une alerte (src/components/secur.js, permission « Expulser »). */
function kickBotButton(botId) {
  return new ButtonBuilder().setCustomId(`secur:kickbot:${botId}`).setLabel('Expulser ce bot').setEmoji(ICONS.kick).setStyle(ButtonStyle.Danger);
}

/** Bouton « Réessayer le lockdown » joint aux alertes dont le lockdown automatique a échoué. */
function retryLockdownButton() {
  return actionButton({ command: 'lockdown', action: 'enable', label: 'Réessayer le lockdown', emoji: '🚨', style: ButtonStyle.Danger });
}

/** Texte du champ « Lockdown » d'une alerte de vague d'arrivées. Pur. */
function lockdownText(lock) {
  if (lock == null) return 'Non configuré';
  if (lock.error) return `${ICONS.warning} **Lockdown non appliqué** : ${String(lock.error).slice(0, 200)}`;
  if (!lock.count) return `${ICONS.warning} **Lockdown non appliqué** : aucun salon verrouillable (permissions ?)`;
  return `🔒 ${lock.count} salon${lock.count > 1 ? 's' : ''} verrouillé${lock.count > 1 ? 's' : ''}`;
}

/** Bouton « Lever le lockdown » joint aux alertes qui ont déclenché un lockdown automatique. */
function liftLockdownButton() {
  return actionButton({ command: 'lockdown', action: 'disable', label: 'Lever le lockdown', emoji: ICONS.unlock, style: ButtonStyle.Success });
}

/**
 * Sécurité anti-raid : détection de vagues d'arrivées, comptes trop récents,
 * bots, et actions destructrices massives (suppression de salons/rôles, bans).
 * Utilise la whitelist avant toute sanction.
 */
class AntiRaidService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ client, config, logging }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    /**
     * Fenêtre d'arrivées par serveur, avec les identifiants des arrivants : une
     * vague en mode kick/ban sanctionne les membres arrivés dans la fenêtre.
     * @type {Map<string, { windowMs: number, entries: { id: string, at: number }[] }>}
     */
    this.joinWindows = new Map();
    /** @type {Map<string, SlidingWindow>} */
    this.destructiveWindows = new Map();
    /** @type {Map<string, number>} dernier déclenchement d'alerte de vague par serveur */
    this.joinAlertAt = new Map();
    /**
     * Dernier déclenchement par serveur (mémoire, depuis le démarrage) : affiché
     * par le tableau de bord /antiraid.
     * @type {Map<string, { at: number, title: string, description?: string }>}
     */
    this.lastTrigger = new Map();
    this.lastWindowPrune = Date.now();
    /**
     * Arrivants récents par serveur (id → instant d'arrivée, ou de la vague qui les a
     * signalés) : exemption des bans de raiders dans la détection destructrice.
     * @type {Map<string, Map<string, number>>}
     */
    this.recentJoiners = new Map();
    /** @type {Map<string, SlidingWindow>} alertes « nouveau membre » publiées par serveur (minute glissante) */
    this.memberAlertWindows = new Map();
    /**
     * Regroupement des alertes pendant un raid, par serveur : sanctions individuelles et de vague
     * non annoncées, publiées dans une carte récapitulative par minute.
     * @type {Map<string, { guild: object, until: number, timer: NodeJS.Timeout|null, banned: number, kicked: number, failed: number, wave: number, lastError: string|null }>}
     */
    this.digests = new Map();
    /** @type {Map<string, Map<string, { by: string, at: number }>>} salons créés (id → auteur) par serveur */
    this.createdChannels = new Map();
    /** @type {Map<string, number>} lectures de l'audit ChannelCreate `${guild}:${auteur}` → instant */
    this.creatorAuditAt = new Map();
    /** @type {Map<string, number>} rôles gérés supprimés `${guild}:${rôle}` → instant */
    this.managedRoles = new Map();
  }

  /** Rôle géré supprimé (événement roleDelete) : sa suppression n'est pas une action destructrice. */
  rememberManagedRole(guildId, roleId, now = Date.now()) {
    if (!guildId || !roleId) return;
    const key = `${guildId}:${roleId}`;
    this.managedRoles.delete(key);
    this.managedRoles.set(key, now);
    for (const [k, at] of this.managedRoles) {
      if (this.managedRoles.size <= 1_000 && now - at < MANAGED_ROLE_TTL_MS) break;
      this.managedRoles.delete(k);
    }
  }

  /** Rôle géré (cache, entrée d'audit, ou suppression mémorisée) : jamais compté. */
  #managedRole(guild, roleId, managedChange = false, now = Date.now()) {
    if (managedChange) return true;
    if (!roleId) return false;
    const role = guild.roles?.cache?.get?.(roleId);
    if (role?.managed || role?.tags?.botId || role?.tags?.integrationId) return true;
    const at = this.managedRoles.get(`${guild.id}:${roleId}`);
    return Boolean(at && now - at < MANAGED_ROLE_TTL_MS);
  }

  /** Bot de confiance (secur.trustedBots, niveau owner pour les modifier) : exempté comme sous Secur. */
  #trustedBot(guildId, userId, isBot) {
    if (!isBot || !userId) return false;
    const bots = this.config.get(guildId).secur?.trustedBots;
    return Array.isArray(bots) && bots.includes(userId);
  }

  /** Salon créé (entrée ChannelCreate du journal d'audit) : son auteur pourra le supprimer sans être compté. */
  rememberChannelCreator(guildId, channelId, executorId, now = Date.now()) {
    if (!guildId || !channelId || !executorId) return;
    if (!this.config.get(guildId).antiraid?.enabled) return;
    let m = this.createdChannels.get(guildId);
    if (!m) {
      m = new Map();
      this.createdChannels.set(guildId, m);
    }
    m.delete(channelId);
    m.set(channelId, { by: executorId, at: now });
    for (const [id, e] of m) {
      if (m.size <= MAX_CREATED_CHANNELS && now - e.at < CREATED_CHANNEL_TTL_MS) break;
      m.delete(id);
    }
  }

  /** true (et oublié) si ce salon a été créé récemment par cet auteur. */
  #ownChannel(guildId, channelId, executorId, now = Date.now()) {
    const m = this.createdChannels.get(guildId);
    const e = channelId ? m?.get(channelId) : null;
    if (!e) return false;
    m.delete(channelId);
    if (!m.size) this.createdChannels.delete(guildId);
    return e.by === executorId && now - e.at < CREATED_CHANNEL_TTL_MS;
  }

  /**
   * Mémoire vide (redémarrage, salon créé pendant une coupure) : créateur relu dans le journal
   * d'audit ChannelCreate. Seulement pour un salon de moins de 7 jours (d'après son identifiant) ;
   * une lecture par auteur et par minute, dont toutes les créations sont mémorisées.
   */
  async #createdViaAudit(guild, channelId, executorId, now = Date.now()) {
    if (!channelId || !executorId) return false;
    let born;
    try {
      born = SnowflakeUtil.timestampFrom(String(channelId));
    } catch {
      return false;
    }
    if (!(now - born < CREATED_CHANNEL_TTL_MS)) return false;
    if (!guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog)) return false;
    const key = `${guild.id}:${executorId}`;
    if (now - (this.creatorAuditAt.get(key) ?? 0) < CREATOR_AUDIT_COOLDOWN_MS) return false;
    this.creatorAuditAt.delete(key);
    this.creatorAuditAt.set(key, now);
    while (this.creatorAuditAt.size > 1_000) this.creatorAuditAt.delete(this.creatorAuditAt.keys().next().value);
    const logs = await guild.fetchAuditLogs?.({ type: AuditLogEvent.ChannelCreate, user: executorId, limit: 100 }).catch(() => null);
    let found = false;
    for (const e of logs?.entries?.values?.() ?? []) {
      const target = e.targetId ?? e.target?.id;
      const by = e.executorId ?? e.executor?.id;
      if (!target || by !== executorId) continue;
      if (target === channelId) found = true;
      else if (guild.channels?.cache?.has?.(target)) this.rememberChannelCreator(guild.id, target, by, Number.isFinite(e.createdTimestamp) ? Math.min(e.createdTimestamp, now) : now);
    }
    return found;
  }

  /** Arrêt du bot : minuteurs des cartes récapitulatives annulés. */
  stop() {
    for (const d of this.digests.values()) if (d.timer) clearTimeout(d.timer);
    this.digests.clear();
  }

  /** Regroupement en cours pour ce serveur (créé au besoin, pour une minute). */
  #digest(guild, now = Date.now()) {
    let d = this.digests.get(guild.id);
    if (!d) {
      d = { guild, until: now + DIGEST_INTERVAL_MS, timer: null, banned: 0, kicked: 0, failed: 0, wave: 0, lastError: null };
      this.digests.set(guild.id, d);
      this.#scheduleDigest(guild.id, d, DIGEST_INTERVAL_MS);
    }
    d.guild = guild;
    return d;
  }

  /** Ouvre (ou prolonge d'une minute) le regroupement : après une alerte de vague ou d'échec. */
  #quietFor(guild, now = Date.now()) {
    const d = this.#digest(guild, now);
    d.until = Math.max(d.until, now + DIGEST_INTERVAL_MS);
    return d;
  }

  #scheduleDigest(guildId, d, ms) {
    if (d.timer) clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      d.timer = null;
      this.flushDigest(guildId).catch((e) => logger.debug('flushDigest', e?.message));
    }, Math.max(1_000, ms));
    d.timer.unref?.();
  }

  /** Sanctions non annoncées prises au regroupement (compteurs remis à zéro). */
  #takeDigest(guildId) {
    const d = this.digests.get(guildId);
    if (!d) return null;
    const counts = { banned: d.banned, kicked: d.kicked, failed: d.failed, wave: d.wave, lastError: d.lastError };
    d.banned = 0;
    d.kicked = 0;
    d.failed = 0;
    d.wave = 0;
    d.lastError = null;
    return counts.banned + counts.kicked + counts.failed + counts.wave ? counts : null;
  }

  /**
   * Carte récapitulative du regroupement en cours (appelée chaque minute par le minuteur).
   * Rien de neuf : le regroupement prend fin à son échéance.
   * @returns {Promise<boolean>} true si une carte a été publiée
   */
  async flushDigest(guildId, now = Date.now()) {
    const d = this.digests.get(guildId);
    if (!d) return false;
    const counts = this.#takeDigest(guildId);
    if (!counts) {
      if (now < d.until) this.#scheduleDigest(guildId, d, d.until - now);
      else {
        if (d.timer) clearTimeout(d.timer);
        this.digests.delete(guildId);
      }
      return false;
    }
    // Raid toujours en cours : une minute de regroupement de plus.
    d.until = now + DIGEST_INTERVAL_MS;
    this.#scheduleDigest(guildId, d, DIGEST_INTERVAL_MS);
    await this.alert(d.guild, {
      tone: counts.failed ? 'danger' : 'caution',
      icon: ICONS.shield,
      title: 'Raid en cours : récapitulatif',
      description: 'Sanctions automatiques appliquées depuis la dernière alerte (regroupées pour ne pas inonder le salon).',
      fields: digestFields(counts),
      trigger: false,
      fallback: counts.failed > 0,
    });
    return true;
  }

  /** Mémorise un arrivant (ordre d'insertion = du plus ancien au plus récent). */
  #rememberJoin(guildId, userId, at = Date.now()) {
    let m = this.recentJoiners.get(guildId);
    if (!m) {
      m = new Map();
      this.recentJoiners.set(guildId, m);
    }
    m.delete(userId);
    m.set(userId, at);
    // Purge des plus anciens (expirés ou au-delà du plafond).
    for (const [id, t] of m) {
      if (m.size <= MAX_RECENT_JOINERS && at - t < RECENT_JOIN_MS) break;
      m.delete(id);
    }
  }

  /**
   * true si l'utilisateur est un arrivant récent : arrivée connue (`joinedAt`) ou
   * mémorisée depuis moins de 10 minutes (arrivée ou vague d'arrivées).
   */
  isRecentJoiner(guildId, userId, joinedAt = null, now = Date.now()) {
    if (joinedAt && now - joinedAt < RECENT_JOIN_MS) return true;
    const at = userId ? this.recentJoiners.get(guildId)?.get(userId) : null;
    return Boolean(at && now - at < RECENT_JOIN_MS);
  }

  /**
   * Départ d'un membre (guildMemberRemove) : s'il était arrivé il y a moins de 10 min,
   * son arrivée est mémorisée. L'entrée d'audit d'un kick arrive souvent APRÈS le départ
   * (membre sorti du cache) : l'exemption des raiders expulsés reste ainsi fiable, même
   * pour un arrivant que le bot n'a pas vu entrer (redémarrage).
   */
  rememberDeparture(member, now = Date.now()) {
    const guildId = member?.guild?.id;
    const joinedAt = member?.joinedTimestamp;
    if (!guildId || !member.id || !joinedAt || now - joinedAt >= RECENT_JOIN_MS) return false;
    if (!this.config.get(guildId).antiraid?.enabled) return false;
    if (this.recentJoiners.get(guildId)?.has(member.id)) return false;
    this.#rememberJoin(guildId, member.id, joinedAt);
    return true;
  }

  /** Oublie les fenêtres d'actions destructrices devenues vides et les arrivants / salons expirés. */
  pruneWindows(now = Date.now()) {
    this.lastWindowPrune = now;
    for (const [key, w] of this.destructiveWindows) {
      if (w.count(now) === 0) this.destructiveWindows.delete(key);
    }
    for (const [key, w] of this.memberAlertWindows) {
      if (w.count(now) === 0) this.memberAlertWindows.delete(key);
    }
    for (const [guildId, m] of this.recentJoiners) {
      for (const [id, at] of m) {
        if (now - at < RECENT_JOIN_MS) break; // ordre d'insertion : du plus ancien au plus récent
        m.delete(id);
      }
      if (!m.size) this.recentJoiners.delete(guildId);
    }
    for (const [guildId, w] of this.joinWindows) {
      if (!w.entries.some((e) => e.seen > now - w.windowMs)) this.joinWindows.delete(guildId);
    }
    for (const [key, at] of this.managedRoles) if (now - at >= MANAGED_ROLE_TTL_MS) this.managedRoles.delete(key);
    for (const [key, at] of this.creatorAuditAt) if (now - at >= CREATOR_AUDIT_COOLDOWN_MS) this.creatorAuditAt.delete(key);
    for (const [guildId, m] of this.createdChannels) {
      for (const [id, e] of m) if (now - e.at >= CREATED_CHANNEL_TTL_MS) m.delete(id);
      if (!m.size) this.createdChannels.delete(guildId);
    }
  }

  /** Serveur quitté (guildDelete) : tout l'état mémoire de ce serveur est oublié. */
  forgetGuild(guildId) {
    if (!guildId) return;
    for (const map of [this.joinWindows, this.joinAlertAt, this.lastTrigger, this.recentJoiners, this.memberAlertWindows, this.createdChannels]) map.delete(guildId);
    const d = this.digests.get(guildId);
    if (d?.timer) clearTimeout(d.timer);
    this.digests.delete(guildId);
    for (const map of [this.destructiveWindows, this.managedRoles, this.creatorAuditAt]) for (const key of map.keys()) if (key.startsWith(`${guildId}:`)) map.delete(key);
  }

  /** Marque un ban lancé par le bot (pas de log en double dans guildBanAdd). */
  #markBan(guildId, userId) {
    this.client.services?.moderation?.markBotAction?.('ban', guildId, userId);
  }

  /**
   * Utilisateur ou rôle whitelisté. Un rôle géré (Booster, rôle de bot) n'immunise jamais :
   * il s'obtient sans contrôle du serveur (refusé par /whitelist et le tableau de bord).
   * `excludePending` (actions destructrices, pré-contrôle) : un accès de whitelist donné par un
   * non-owner et pas encore approuvé (Secur, 24 h au plus) n'exempte pas. Les vagues d'arrivées
   * gardent l'exemption immédiate.
   */
  isWhitelisted(guildId, userId, roleIds = [], { excludePending = false } = {}) {
    const wl = this.config.get(guildId).whitelist || { users: [], roles: [] };
    const roles = this.client.guilds?.cache?.get?.(guildId)?.roles?.cache;
    const byUser = Boolean(wl.users?.includes(userId));
    const byRoles = roleIds.filter((r) => wl.roles?.includes(r) && !roles?.get?.(r)?.managed);
    if (!byUser && !byRoles.length) return false;
    const pending = excludePending ? this.client.services?.secur?.pendingExemptions?.(guildId, userId) : null;
    if (!pending) return true;
    return (byUser && !pending.user) || byRoles.some((r) => !pending.roles.has(r));
  }

  /**
   * Enregistre une arrivée et renvoie les arrivants de la même rafale (le plus ancien d'abord,
   * l'arrivée courante en dernier). La rafale est comptée sur `at`, l'heure d'arrivée fixée par
   * Discord (joined_at) : des arrivées étalées puis livrées d'un bloc (rejeu après RESUME, rafale
   * retardée par Discord) ne forment pas une vague. Les entrées sont comparées entre elles, jamais
   * à l'horloge de l'hôte ; la mémoire, elle, est purgée sur l'instant de réception (`seen`).
   */
  #recordJoin(guildId, memberId, ms, at = Date.now(), now = Date.now()) {
    let w = this.joinWindows.get(guildId);
    if (!w || w.windowMs !== ms) {
      w = { windowMs: ms, entries: [] };
      this.joinWindows.set(guildId, w);
    }
    w.entries = w.entries.filter((e) => e.seen > now - ms && e.id !== memberId);
    w.entries.push({ id: memberId, at, seen: now });
    return w.entries.filter((e) => Math.abs(e.at - at) < ms);
  }

  /** Hook de vague (services.raidResponse.onWave) : son `{ text }` devient le champ « Invitations ». */
  async #onWave(guild, count) {
    const raidResponse = this.client.services?.raidResponse;
    if (typeof raidResponse?.onWave !== 'function') return null;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(raidResponse.onWave(guild, { count })).catch((e) => {
          logger.debug('onWave', e?.message);
          return null;
        }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), ON_WAVE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  #window(map, key, ms) {
    let w = map.get(key);
    if (!w || w.windowMs !== ms) {
      w = new SlidingWindow(ms);
      map.set(key, w);
    }
    return w;
  }

  /**
   * @param {import('discord.js').GuildMember} member
   * @returns {Promise<{ punished: boolean }|undefined>} punished : le membre arrivant a été expulsé/banni
   */
  async handleJoin(member) {
    const cfg = this.config.get(member.guild.id).antiraid;
    if (!cfg?.enabled) return;
    if (Date.now() - this.lastWindowPrune > WINDOW_PRUNE_INTERVAL_MS) this.pruneWindows();
    this.#rememberJoin(member.guild.id, member.id);
    if (this.isWhitelisted(member.guild.id, member.id, [...(member.roles?.cache?.keys() ?? [])])) return;
    if (this.#trustedBot(member.guild.id, member.id, member.user?.bot)) return;

    // Vague d'arrivées : TOUT arrivant hors whitelist est compté, avant les filtres individuels.
    // Un raid de comptes récents ou de bots déclenche ainsi la vague (lockdown), que leur
    // sanction individuelle réussisse ou échoue (permission perdue, hiérarchie, 429).
    const guild = member.guild;
    const joinedAt = Number.isFinite(member.joinedTimestamp) ? member.joinedTimestamp : Date.now();
    const entries = this.#recordJoin(guild.id, member.id, cfg.joinWindowSeconds * 1000, joinedAt);
    const entry = entries[entries.length - 1];
    const count = entries.length;
    const waveEntries = count >= cfg.joinThreshold ? entries : null;
    if (waveEntries) {
      // Réinitialise la fenêtre : une vague = un déclenchement.
      this.joinWindows.delete(guild.id);
      // Arrivants de la vague : leur bannissement par un modérateur reste exempté 10 min après la détection.
      const waveAt = Date.now();
      for (const e of waveEntries) this.#rememberJoin(guild.id, e.id, waveAt);
    }

    // Anti-bot (bot ajouté hors whitelist) et âge de compte minimal. Module Secur `bot` actif :
    // l'ajout du bot est traité par le module (audit BotAdd, auteur de l'invitation compris).
    const secur = this.client.services?.secur;
    let reason = null;
    if (cfg.antiBot && member.user.bot && !secur?.covers?.(guild.id, 'bot')) reason = 'AntiRaid: bot non autorisé';
    else if (cfg.minAccountAgeDays > 0) {
      const ageDays = (Date.now() - member.user.createdTimestamp) / DAY_MS;
      if (ageDays < cfg.minAccountAgeDays) reason = `AntiRaid: compte trop récent (${ageDays.toFixed(1)}j)`;
    }
    let punished = false;
    if (reason) {
      const res = await this.#punishNewMember(member, reason, cfg);
      punished = res.ok;
      if (res.ok && member.user.bot) secur?.noteBotRemoved?.(guild, member.id);
      if (res.ok) entry.done = true; // déjà sanctionné : la vague ne le sanctionne pas une 2e fois
      await this.#reportNewMember(member, reason, res, { inWave: Boolean(waveEntries) });
    }
    if (!waveEntries) return { punished };

    // En mode kick/ban, les arrivants de la vague sont sanctionnés à chaque
    // déclenchement (le raid continue pendant le cooldown) ; seules l'alerte et
    // le lockdown sont limités à un par cooldown.
    const joinerIds = waveEntries.filter((e) => !e.done).map((e) => e.id);
    // Riposte de vague (services.raidResponse, SEC3) : attendue 2 s au plus, avant les sanctions.
    const response = await this.#onWave(guild, count);
    const wave = cfg.action === 'kick' || cfg.action === 'ban' ? await this.#punishWave(guild, joinerIds, cfg.action) : null;
    const now = Date.now();
    const cooling = now - (this.joinAlertAt.get(guild.id) || 0) < JOIN_ALERT_COOLDOWN_MS;
    if (!cooling) {
      this.joinAlertAt.set(guild.id, now);
      const lock = cfg.action === 'lockdown' ? await this.#tryLockdown(guild) : null;
      const locked = lock?.count ?? null;
      // Sanctions individuelles regroupées jusqu'ici, puis regroupement pour la minute qui suit.
      const counts = this.#takeDigest(guild.id);
      this.#quietFor(guild);
      await this.alert(guild, {
        tone: 'danger',
        icon: '🚨',
        title: 'Vague d\'arrivées détectée',
        description: `**${count}** membres ont rejoint le serveur en moins de **${cfg.joinWindowSeconds} s**.`,
        fields: [
          field(ICONS.members, 'Arrivées', `**${count}**`),
          field(ICONS.warning, 'Seuil', `${cfg.joinThreshold} en ${cfg.joinWindowSeconds} s`),
          wave
            ? field(cfg.action === 'ban' ? ICONS.ban : ICONS.kick, cfg.action === 'ban' ? 'Bannis' : 'Expulsés', waveSummary(wave))
            : field(ICONS.lock, 'Lockdown', lockdownText(lock)),
          response?.text ? wide(ICONS.link, 'Invitations', String(response.text).slice(0, 1_000)) : null,
          ...(counts ? digestFields(counts) : []),
        ],
        buttons: lock && !lock.count ? [retryLockdownButton()] : locked ? [liftLockdownButton()] : [],
        ping: true, // raid ping (secur.raidPingRoleId) dans le salon d'alerte, une fois par minute au plus
        fallback: true,
      });
    } else if (wave?.punished.length) {
      this.#digest(guild).wave += wave.punished.length;
      logger.info(`Vague continue sur ${guild.id} : ${wave.punished.length} arrivant(s) sanctionné(s) (${cfg.action}).`);
    }
    return { punished: punished || Boolean(wave?.punished.includes(member.id)) };
  }

  /**
   * Annonce la sanction (ou l'échec) d'un compte récent / bot. Pendant un raid (vague, regroupement
   * en cours ou plus de MEMBER_ALERTS_PER_MINUTE alertes dans la minute), la sanction est comptée
   * dans la carte récapitulative. Un échec est toujours signalé (puis regroupé une minute).
   */
  async #reportNewMember(member, reason, { ok, ban, error }, { inWave = false } = {}) {
    const guild = member.guild;
    const now = Date.now();
    const quiet = this.digests.has(guild.id) && now < this.digests.get(guild.id).until;
    if (inWave || quiet || (ok && this.#window(this.memberAlertWindows, guild.id, 60_000).hit(now) > MEMBER_ALERTS_PER_MINUTE)) {
      const d = this.#digest(guild, now);
      if (!ok) {
        d.failed += 1;
        d.lastError = error ?? d.lastError;
      } else if (ban) d.banned += 1;
      else d.kicked += 1;
      return;
    }
    if (ok) {
      await this.alert(guild, {
        tone: 'caution',
        icon: ICONS.shield,
        title: ban ? 'Nouveau membre banni' : 'Nouveau membre expulsé',
        description: `${member.user} a été ${ban ? 'banni' : 'expulsé'} automatiquement à son arrivée.`,
        thumbnail: member.user.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user)),
          field(ban ? ICONS.ban : ICONS.kick, 'Sanction', ban ? 'Bannissement' : 'Expulsion'),
          wide(ICONS.reason, 'Motif', reason.replace(/^AntiRaid: /, '')),
        ],
        footer: `ID : ${member.id}`,
      }).catch((e) => logger.debug('alerte nouveau membre', e?.message));
      return;
    }
    // Échec : le membre est toujours là. Alerte immédiate, les suivantes sont regroupées une minute.
    this.#quietFor(guild, now);
    await this.alert(guild, {
      tone: 'danger',
      icon: ICONS.warning,
      title: 'Sanction automatique impossible',
      description: `${member.user} n'a pas pu être ${ban ? 'banni' : 'expulsé'} à son arrivée : **il est toujours sur le serveur**.`,
      thumbnail: member.user.displayAvatarURL?.(),
      fields: [
        field(ICONS.user, 'Membre', userLine(member.user)),
        field(ban ? ICONS.ban : ICONS.kick, 'Sanction prévue', ban ? 'Bannissement' : 'Expulsion'),
        wide(ICONS.reason, 'Motif', reason.replace(/^AntiRaid: /, '')),
        wide(ICONS.error, 'Erreur', String(error ?? 'inconnue').slice(0, 200)),
        wide(ICONS.info, 'Ensuite', 'Vérifiez mes permissions (Expulser / Bannir) et ma place dans la liste des rôles. Les échecs de la minute suivante sont regroupés dans un récapitulatif.'),
      ],
      footer: `ID : ${member.id}`,
      fallback: true,
    }).catch((e) => logger.debug('alerte échec', e?.message));
  }

  /**
   * Sanctionne (kick/ban) les membres arrivés pendant la vague. Whitelist
   * revérifiée (rôles attribués depuis l'arrivée), propriétaire et bot exclus,
   * au plus MAX_WAVE_PUNISH membres par déclenchement.
   * @returns {Promise<{ punished: string[], skipped: number, capped: number }>}
   */
  async #punishWave(guild, ids, action) {
    const reason = 'AntiRaid: vague d\'arrivées';
    const punished = [];
    let skipped = 0;
    const eligible = ids.filter((id) => id !== guild.ownerId && id !== this.client.user?.id);
    const capped = Math.max(0, eligible.length - MAX_WAVE_PUNISH);
    // Les départs provoqués par la sanction ne doivent pas être annoncés par l'accueil.
    this.client.services?.welcome?.silenceWave?.(guild.id);
    for (const id of eligible.slice(-MAX_WAVE_PUNISH)) {
      const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      if (this.isWhitelisted(guild.id, id, member ? [...(member.roles?.cache?.keys() ?? [])] : [])) {
        skipped += 1;
        continue;
      }
      try {
        this.client.services?.welcome?.silence?.(guild.id, id);
        if (action === 'ban') {
          if (member && member.bannable === false) throw new Error('non bannissable');
          this.#markBan(guild.id, id);
          await guild.bans.create(id, { reason });
        } else {
          if (!member) throw new Error('déjà parti');
          if (member.kickable === false) throw new Error('non expulsable');
          await member.kick(reason);
        }
        punished.push(id);
      } catch (e) {
        if (action === 'ban') this.client.services?.moderation?.unmarkBotAction?.('ban', guild.id, id);
        this.client.services?.welcome?.unsilence?.(guild.id, id); // sanction échouée : un vrai départ sera annoncé
        skipped += 1;
        logger.debug(`punishWave ${id}`, e?.message);
      }
    }
    return { punished, skipped, capped };
  }

  /** Seuil historique d'un type d'action destructrice (0 : désactivé). */
  static #threshold(cfg, type) {
    const thresholds = {
      channelDelete: cfg.channelDeleteThreshold,
      roleDelete: cfg.roleDeleteThreshold,
      ban: cfg.banThreshold,
      kick: cfg.kickThreshold, // 0 / absent (anciennes configs) : désactivé
    };
    return Number(thresholds[type]) || 0;
  }

  /** Ban ou kick d'un arrivant récent (raider) : jamais destructeur. */
  #raiderTarget(guild, type, targetId, targetJoinedAt) {
    if (!MEMBER_SANCTIONS.has(type) || !targetId) return false;
    const joinedAt = targetJoinedAt ?? guild.members?.cache?.get?.(targetId)?.joinedTimestamp ?? null;
    return this.isRecentJoiner(guild.id, targetId, joinedAt);
  }

  /**
   * Pré-contrôle (Secur.assertAllowed, chemin historique) : `count` actions de plus, ajoutées à la
   * fenêtre courante, atteindraient-elles le seuil ? La whitelist est vérifiée par l'appelant.
   * @returns {number} le seuil atteint, ou 0
   */
  wouldTrigger(guild, userId, type, count = 1, { targetId = null, targetJoinedAt = null } = {}) {
    const cfg = this.config.get(guild.id).antiraid;
    if (!cfg?.enabled || !userId || userId === this.client.user?.id || userId === guild.ownerId) return 0;
    if (this.client.services?.secur?.covers?.(guild.id, type)) return 0;
    if (this.#raiderTarget(guild, type, targetId, targetJoinedAt)) return 0;
    const limit = AntiRaidService.#threshold(cfg, type);
    if (!limit) return 0;
    const w = this.destructiveWindows.get(`${guild.id}:${userId}:${type}`);
    const current = w && w.windowMs === cfg.destructiveWindowSeconds * 1000 ? w.count() : 0;
    return current + Math.max(1, count) >= limit ? limit : 0;
  }

  /**
   * Action destructrice détectée via audit log (suppression salon/rôle, ban…).
   * Alimentée par l'événement `guildAuditLogEntryCreate` (une entrée = une action,
   * pas de double comptage ni de fetch des audit logs par événement).
   * Aussi appelée par ModerationService après un ban ou un kick fait via le bot
   * (l'audit log l'attribue au bot) avec l'identifiant du modérateur.
   * La fenêtre est calculée sur `at` : l'HORODATAGE de l'entrée d'audit (snowflake), jamais
   * l'instant de réception (des entrées rejouées en retard ne s'additionnent pas). Un prune
   * (audit 21) compte `count` expulsions. Un module Secur actif sur ce type prend le relais.
   * @param {import('discord.js').Guild} guild
   * @param {string} executorId
   * @param {'channelDelete'|'roleDelete'|'ban'|'kick'} type
   * @param {{ targetId?: string|null, targetJoinedAt?: number|null, at?: number, count?: number }} [opts] cible du ban/kick
   *   (exemption des arrivants récents) ou salon supprimé (exemption des salons créés par le même auteur)
   */
  async handleDestructive(guild, executorId, type, { targetId = null, targetJoinedAt = null, at = Date.now(), count = 1, managedRole = false } = {}) {
    const cfg = this.config.get(guild.id).antiraid;
    if (!cfg?.enabled || !executorId) return;
    if (executorId === this.client.user?.id) return;
    if (executorId === guild.ownerId) return;
    if (this.client.services?.secur?.covers?.(guild.id, type)) return;
    // Supprimer un salon que l'on a soi-même créé (ticket ou vocal temporaire d'un bot tiers) non plus.
    if (type === 'channelDelete' && this.#ownChannel(guild.id, targetId, executorId)) return;
    // Rôle géré supprimé par Discord (bot expulsé, intégration retirée) : pas une action de l'auteur.
    if (type === 'roleDelete' && this.#managedRole(guild, targetId, managedRole)) return;
    // Bannir ou expulser un raider (arrivé il y a moins de 10 min) n'est pas une action destructrice.
    if (this.#raiderTarget(guild, type, targetId, targetJoinedAt)) return;
    const executor = await guild.members.fetch(executorId).catch(() => null);
    // Accès de whitelist en attente (donné par un non-owner, pas encore approuvé) : n'exempte pas.
    if (this.isWhitelisted(guild.id, executorId, executor ? [...executor.roles.cache.keys()] : [], { excludePending: true })) return;
    if (this.#trustedBot(guild.id, executorId, executor?.user?.bot ?? this.client.users?.cache?.get?.(executorId)?.bot)) return;

    const limit = AntiRaidService.#threshold(cfg, type);
    if (!limit) return;
    // Mémoire perdue (redémarrage) : le créateur du salon est relu dans le journal d'audit.
    if (type === 'channelDelete' && (await this.#createdViaAudit(guild, targetId, executorId))) return;

    const now = Date.now();
    if (now - this.lastWindowPrune > WINDOW_PRUNE_INTERVAL_MS) this.pruneWindows(now);
    const key = `${guild.id}:${executorId}:${type}`;
    const w = this.#window(this.destructiveWindows, key, cfg.destructiveWindowSeconds * 1000);
    const n = Math.max(1, Math.floor(Number(count)) || 1);
    const stamp = Number.isFinite(at) ? Math.min(at, now) : now;
    for (let i = 0; i < Math.min(n, limit); i += 1) w.times.push(stamp);
    const inWindow = burstCount(w.times, stamp, w.windowMs);
    if (inWindow < limit) return;
    const total = inWindow + Math.max(0, n - limit);

    w.reset();
    const outcome = await this.#punishExecutor(guild, executorId, cfg, type);
    await this.alert(guild, {
      tone: 'danger',
      icon: '🚨',
      title: 'Activité destructrice anormale',
      description: `<@${executorId}> a effectué **${total}** actions destructrices en **${cfg.destructiveWindowSeconds} s**.`,
      thumbnail: executor?.user?.displayAvatarURL?.(),
      fields: [
        field(ICONS.user, 'Auteur', executor ? userLine(executor.user) : `<@${executorId}>`),
        field('💣', 'Type', `${DESTRUCTIVE_LABELS[type] ?? type} ×**${total}**`),
        field(ICONS.shield, 'Sanction', outcome.label ?? (outcome.ok ? EXECUTOR_LABELS[cfg.punishExecutor] ?? cfg.punishExecutor : 'Aucune (échec ou désactivée)')),
        outcome.note ? wide(ICONS.warning, 'Attention', outcome.note) : null,
      ],
      footer: `ID : ${executorId}`,
      buttons: outcome.buttons ?? [],
      ping: true,
      fallback: true,
    });
  }

  /**
   * Tentatives répétées bloquées par le pré-contrôle (Secur.assertAllowed, 3 en 10 min) : l'auteur
   * insiste sur le seuil via le bot. Aucune action n'a eu lieu, mais il est sanctionné et l'alerte
   * part, comme s'il avait atteint le seuil.
   */
  async handleBlockedAttempts(guild, executorId, type, attempts) {
    const cfg = this.config.get(guild.id).antiraid;
    if (!cfg?.enabled || !executorId || executorId === this.client.user?.id || executorId === guild.ownerId) return;
    const executor = await guild.members.fetch(executorId).catch(() => null);
    if (this.isWhitelisted(guild.id, executorId, executor ? [...executor.roles.cache.keys()] : [], { excludePending: true })) return;
    if (this.#trustedBot(guild.id, executorId, executor?.user?.bot)) return;
    const outcome = await this.#punishExecutor(guild, executorId, cfg, type);
    await this.alert(guild, {
      tone: 'danger',
      icon: '🚨',
      title: 'Tentatives destructrices répétées',
      description: `<@${executorId}> a tenté **${attempts}** fois de dépasser le seuil via le bot en 10 minutes : chaque action a été refusée.`,
      thumbnail: executor?.user?.displayAvatarURL?.(),
      fields: [
        field(ICONS.user, 'Auteur', executor ? userLine(executor.user) : `<@${executorId}>`),
        field('💣', 'Type', `${DESTRUCTIVE_LABELS[type] ?? type} (refusées ×**${attempts}**)`),
        field(ICONS.shield, 'Sanction', outcome.label ?? (outcome.ok ? EXECUTOR_LABELS[cfg.punishExecutor] ?? cfg.punishExecutor : 'Aucune (échec ou désactivée)')),
        outcome.note ? wide(ICONS.warning, 'Attention', outcome.note) : null,
      ],
      footer: `ID : ${executorId}`,
      buttons: outcome.buttons ?? [],
      ping: true,
      fallback: true,
    });
  }

  /**
   * Expulse / bannit un compte récent ou un bot à son arrivée (l'annonce est faite par l'appelant).
   * @returns {Promise<{ ok: boolean, ban: boolean, error?: string }>}
   */
  async #punishNewMember(member, reason, cfg) {
    const ban = newAccountAction(cfg) === 'ban';
    try {
      this.client.services?.welcome?.silence?.(member.guild.id, member.id);
      if (ban) {
        this.#markBan(member.guild.id, member.id);
        await member.ban({ reason });
      } else await member.kick(reason);
      return { ok: true, ban };
    } catch (e) {
      // Échec : l'événement guildBanAdd ne viendra pas du bot, la marque est retirée.
      if (ban) this.client.services?.moderation?.unmarkBotAction?.('ban', member.guild.id, member.id);
      this.client.services?.welcome?.unsilence?.(member.guild.id, member.id);
      logger.debug('punishNewMember', e?.message);
      return { ok: false, ban, error: e?.message ?? String(e) };
    }
  }

  /**
   * Retire les rôles d'un membre en UN SEUL PATCH (exception volontaire à applyRoles : un nukeur ne
   * doit pas garder ses permissions le temps de N requêtes). Rôles gérés ou au-dessus du bot
   * conservés. Partagé avec Secur (derank).
   * @param {import('discord.js').GuildMember} member
   * @param {string} reason
   * @param {{ dangerous?: bigint[], guild?: import('discord.js').Guild }} [opts] permissions qui ne doivent plus subsister
   * @returns {Promise<{ ok: boolean, removed: string[], dangerousLeft: boolean, note?: string }>}
   *   ok : au moins un rôle retiré ET plus aucune permission dangereuse (rôles restants, @everyone,
   *   surcharges de salon propres au membre)
   */
  async stripMember(member, reason, { dangerous = DANGEROUS_PERMISSIONS, guild = member.guild } = {}) {
    const roles = member.roles.cache.filter((r) => r.id !== guild.id);
    const removable = roles.filter((r) => r.editable && !r.managed);
    const remaining = [...roles.filter((r) => !removable.has(r.id)).values()];
    const everyone = guild.roles?.everyone ?? guild.roles?.cache?.get?.(guild.id);
    if (everyone) remaining.push(everyone);
    const residual = () => {
      const viaRoles = remaining.filter((r) => r.permissions?.any?.(dangerous));
      // Surcharges de salon propres au membre, ou d'un rôle CONSERVÉ (géré, au-dessus du bot ; hors
      // @everyone, commun à tous) : le retrait des rôles ne les touche pas.
      const kept = [member.id, ...remaining.filter((r) => r.id !== guild.id).map((r) => r.id)];
      const overwrites = [...(guild.channels?.cache?.values?.() ?? [])]
        .filter((c) => kept.some((id) => c.permissionOverwrites?.cache?.get?.(id)?.allow?.any?.(dangerous)));
      return [
        ...viaRoles.map((r) => (r.id === guild.id ? '@everyone' : `${r}`)),
        ...overwrites.slice(0, 5).map((c) => `la surcharge de ${c}`),
        overwrites.length > 5 ? `${overwrites.length - 5} autre(s) salon(s)` : null,
      ].filter(Boolean);
    };
    if (!removable.size) {
      const via = residual();
      return { ok: false, removed: [], dangerousLeft: via.length > 0, note: 'Aucun rôle n\'a pu être retiré (rôles trop élevés ou gérés).' };
    }
    try {
      await member.roles.remove(removable, reason);
    } catch (e) {
      logger.debug('stripMember', e?.message);
      return { ok: false, removed: [], dangerousLeft: true, note: 'Le retrait des rôles a échoué (permission ou hiérarchie).' };
    }
    const via = residual();
    if (via.length) return { ok: false, removed: [...removable.keys()], dangerousLeft: true, note: `Rôles retirés, mais l'auteur garde des permissions dangereuses via ${via.join(', ')}.` };
    return { ok: true, removed: [...removable.keys()], dangerousLeft: false };
  }

  /**
   * Exécuteur BOT avec la sanction « retrait des rôles » : son rôle géré ne peut pas être retiré,
   * d'où secur.botExecutor (actif même Secur coupé) : always → expulsion ; recent (défaut) →
   * expulsion s'il est arrivé il y a moins de 7 jours, sinon retrait des rôles possibles puis
   * carte avec bouton « Expulser ce bot » et ping ; never → carte seule. Le bannissement reste
   * inchangé (il neutralise un bot). @returns {Promise<object|null>} null : traitement ordinaire
   */
  async #punishBotExecutor(guild, member, cfg, reason) {
    if (cfg.punishExecutor !== 'strip') return null;
    const secur = this.config.get(guild.id).secur ?? {};
    const policy = BOT_EXECUTOR_POLICIES.has(secur.botExecutor) ? secur.botExecutor : 'recent';
    const recent = Number.isFinite(member.joinedTimestamp) && Date.now() - member.joinedTimestamp < RECENT_BOT_MS;
    if (policy === 'always' || (policy === 'recent' && recent)) {
      try {
        this.client.services?.welcome?.silence?.(guild.id, member.id);
        await member.kick(reason);
        return { ok: true, label: 'Bot expulsé', note: recent ? 'Bot arrivé il y a moins de 7 jours : expulsé (le retrait des rôles ne neutralise pas un rôle géré).' : null };
      } catch (e) {
        this.client.services?.welcome?.unsilence?.(guild.id, member.id);
        logger.debug('punishBotExecutor', e?.message);
        return { ok: false, label: 'Bot non neutralisé automatiquement', note: `L'expulsion du bot a échoué (${String(e?.message ?? e).slice(0, 120)}).`, buttons: [kickBotButton(member.id)] };
      }
    }
    const res = await this.stripMember(member, reason, { guild });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      label: 'Bot non neutralisé automatiquement',
      note: `${policy === 'never' ? 'Bot auteur jamais expulsé automatiquement (réglage « bot auteur »).' : 'Bot arrivé il y a plus de 7 jours : non expulsé automatiquement.'} ${res.removed.length ? res.note : 'Son rôle géré lui laisse ses permissions.'} Vérifiez-le et expulsez-le si besoin.`,
      buttons: [kickBotButton(member.id)],
    };
  }

  /**
   * Sanctionne l'auteur d'actions destructrices.
   * « strip » n'est un succès que si au moins un rôle a été retiré ET qu'aucun rôle
   * restant (non modifiable par le bot, ou @everyone) ne confère de permission dangereuse.
   * @returns {Promise<{ ok: boolean, note?: string, label?: string, buttons?: object[] }>}
   */
  async #punishExecutor(guild, executorId, cfg, type) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    const reason = `AntiRaid: ${type} massif`;
    if (!member) {
      // Auteur parti (script « supprime puis quitte », bot retiré) : banni par identifiant,
      // sinon il revient avec n'importe quelle invitation.
      if (cfg.punishExecutor !== 'ban') return { ok: false };
      try {
        this.#markBan(guild.id, executorId);
        await guild.bans.create(executorId, { reason });
        return { ok: true, note: 'L\'auteur avait quitté le serveur : il a été banni par identifiant et ne pourra pas revenir.' };
      } catch (e) {
        this.client.services?.moderation?.unmarkBotAction?.('ban', guild.id, executorId);
        logger.debug('punishExecutor (auteur parti)', e?.message);
        return { ok: false, note: 'L\'auteur a quitté le serveur et son bannissement par identifiant a échoué : il peut revenir.' };
      }
    }
    if (member.user?.bot) {
      const bot = await this.#punishBotExecutor(guild, member, cfg, reason);
      if (bot) return bot;
    }
    if (cfg.punishExecutor === 'ban') {
      try {
        this.#markBan(guild.id, member.id);
        await member.ban({ reason });
        return { ok: true };
      } catch (e) {
        this.client.services?.moderation?.unmarkBotAction?.('ban', guild.id, member.id);
        logger.debug('punishExecutor', e?.message);
        return { ok: false, note: 'Le bannissement de l\'auteur a échoué (rôle trop élevé ou permission manquante).' };
      }
    }
    if (cfg.punishExecutor === 'strip') {
      const res = await this.stripMember(member, reason, { guild });
      return res.ok ? { ok: true } : { ok: false, note: res.note };
    }
    return { ok: false };
  }

  /**
   * Lockdown automatique. Un verrouillage ou une levée en cours (admin) est ATTENDU puis le
   * lockdown est appliqué : un raid ne reste jamais sans lockdown faute de verrou libre.
   * @returns {Promise<{ count: number, error?: string }|null>} null si le service est indisponible
   */
  async #tryLockdown(guild) {
    // Délègue au LockdownService s'il est disponible. Pas de carte « Lockdown activé » :
    // l'alerte AntiRaid (avec le nombre de salons et le bouton de levée) en tient lieu.
    const lockdown = this.client.services?.lockdown;
    if (!lockdown) return null;
    try {
      const n = await lockdown.enable(guild, guild.members.me, 'AntiRaid automatique', { log: false, wait: true });
      // Salons déjà verrouillés (lockdown manuel juste avant) : le lockdown est bien actif.
      return { count: n || (lockdown.status?.(guild) ?? 0) };
    } catch (err) {
      logger.warn(`Lockdown automatique impossible sur ${guild.id} :`, err?.message);
      return { count: 0, error: err?.message ?? String(err) };
    }
  }

  /** Dernier déclenchement connu sur ce serveur (null si aucun depuis le démarrage). */
  lastTriggerOf(guildId) {
    return this.lastTrigger.get(guildId) ?? null;
  }

  /**
   * Publie une alerte (carte danger/caution) dans le salon d'alertes et les logs sécurité.
   * Alerte critique (`fallback`) reçue nulle part (salon supprimé par un nukeur, logs sécurité
   * débranchés ou mis en pause, permissions) : MP au propriétaire, sinon salon système.
   * @param {import('discord.js').Guild} guild
   * @param {string | { tone?: string, icon?: string, title: string, description?: string, fields?: object[],
   *   thumbnail?: string, footer?: string, buttons?: import('discord.js').ButtonBuilder[], trigger?: boolean, fallback?: boolean }} alert
   * @returns {Promise<boolean>} true si l'alerte a été publiée quelque part
   */
  async alert(guild, alert) {
    const a = typeof alert === 'string' ? { description: alert } : alert;
    // Carte récapitulative : pas un nouveau déclenchement (le tableau de bord garde la vague).
    if (a.trigger !== false) this.lastTrigger.set(guild.id, { at: Date.now(), title: a.title ?? 'Alerte AntiRaid', description: a.description });
    const embed = card({
      tone: a.tone ?? 'danger',
      section: 'security',
      icon: a.icon ?? '🚨',
      title: a.title ?? 'Alerte AntiRaid',
      description: a.description,
      thumbnail: a.thumbnail,
      fields: a.fields ?? [],
      footer: a.footer,
    });
    const components = buttonRows(...(a.buttons ?? []));
    // Remise hors filtres des logs (une alerte n'est pas un log) : salon d'alerte, sinon logs
    // sécurité ; log normal en plus ; MP / salon système pour une alerte critique perdue.
    const res = await this.#notifier().deliver(guild, { embed, components }, {
      fallback: Boolean(a.fallback),
      critical: Boolean(a.critical),
      ping: Boolean(a.ping),
      event: 'antiraid',
      label: 'Alerte AntiRaid',
    });
    return res.delivered;
  }

  /** Remise des alertes : celle de Secur (état partagé : MP plafonnés, pings), sinon une propre. */
  #notifier() {
    const shared = this.client.services?.secur?.notifier;
    if (shared) return shared;
    if (!this.ownNotifier) this.ownNotifier = new SecurNotifier({ client: this.client, config: this.config, logging: this.logging });
    return this.ownNotifier;
  }

  /**
   * Journalise un changement de réglage de l'AntiRaid ou de la whitelist (logs sécurité) : un
   * administrateur compromis ne désarme pas la protection sans trace. Désactivation par un autre
   * que le propriétaire : MP au propriétaire en plus.
   * @param {import('discord.js').Guild} guild
   * @param {import('discord.js').User} user auteur du changement
   * @param {string|string[]} changes lignes « Réglage : avant → après »
   * @param {{ disabled?: boolean }} [opts]
   */
  async logConfigChange(guild, user, changes, { disabled = false } = {}) {
    const list = (Array.isArray(changes) ? changes : [changes]).filter(Boolean);
    if (!list.length || !guild?.id) return false;
    const embed = card({
      tone: disabled ? 'danger' : 'caution',
      section: 'security',
      icon: disabled ? '🔴' : ICONS.settings,
      title: disabled ? 'AntiRaid désactivé' : 'Réglages AntiRaid modifiés',
      description: list.map((l) => `• ${l}`).join('\n').slice(0, 3_900),
      fields: [field(ICONS.moderator, 'Par', user ? userLine(user) : '*Inconnu*')],
      footer: user?.id ? `ID : ${user.id}` : undefined,
    });
    const logged = await this.logging.send(guild.id, 'security', embed, undefined, { event: 'antiraid' });
    if (disabled && user?.id !== guild.ownerId && guild.ownerId) {
      const owner = await this.client.users?.fetch?.(guild.ownerId).catch(() => null);
      await owner?.send?.({
        content: `${ICONS.warning} L'AntiRaid de **${escapeMarkdown(String(guild.name ?? guild.id)).slice(0, 100)}** vient d'être **désactivé** par ${user ? `\`${escapeMarkdown(String(user.tag ?? user.username ?? user.id))}\`` : 'un administrateur'}. Si ce n'était pas prévu, réactivez-le avec /antiraid.`,
        embeds: fitEmbeds([embed]),
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    return logged === true;
  }
}

/**
 * Plus grand nombre d'actions tenant dans une fenêtre de `windowMs` qui contient l'instant `at`
 * (horodatages des entrées d'audit, éventuellement reçues dans le désordre). Pur.
 */
function burstCount(times, at, windowMs) {
  const near = times.filter((t) => t > at - windowMs && t < at + windowMs).sort((a, b) => a - b);
  let best = 0;
  for (const start of near) {
    if (start > at) break;
    const n = near.filter((t) => t >= start && t < start + windowMs).length;
    if (n > best) best = n;
  }
  return best;
}

/** Résumé d'une sanction de vague pour l'alerte. Pur. */
function waveSummary({ punished, skipped, capped }) {
  const parts = [`**${punished.length}**`];
  if (skipped) parts.push(`${skipped} ignoré${skipped > 1 ? 's' : ''}`);
  if (capped) parts.push(`${capped} hors plafond (${MAX_WAVE_PUNISH})`);
  return parts.join(' · ');
}

/** Champs d'une carte récapitulative (sanctions regroupées pendant un raid). Pur. */
function digestFields({ banned = 0, kicked = 0, failed = 0, wave = 0, lastError = null }) {
  const done = [banned && `**${banned}** banni${banned > 1 ? 's' : ''}`, kicked && `**${kicked}** expulsé${kicked > 1 ? 's' : ''}`].filter(Boolean);
  return [
    done.length ? field(ICONS.shield, 'Comptes récents / bots', done.join(' · ')) : null,
    wave ? field(ICONS.members, 'Arrivants de vague', `**${wave}** sanctionné${wave > 1 ? 's' : ''}`) : null,
    failed ? wide(ICONS.warning, 'Sanctions en échec', `**${failed}** échec${failed > 1 ? 's' : ''} : ces membres sont toujours sur le serveur.${lastError ? `\nDernière erreur : ${String(lastError).slice(0, 200)}` : ''}`) : null,
  ].filter(Boolean);
}

module.exports = { AntiRaidService, newAccountAction, waveSummary, digestFields, burstCount, kickBotButton, MAX_WAVE_PUNISH, RECENT_JOIN_MS, RECENT_BOT_MS, DANGEROUS_PERMISSIONS };
