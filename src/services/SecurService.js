'use strict';

const path = require('node:path');
const { AuditLogEvent, PermissionFlagsBits, SnowflakeUtil } = require('discord.js');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');
const { status, fitEmbeds } = require('../utils/ui');
const { applyRoles } = require('../utils/memberRoles');
const S = require('../utils/secur');
const { SecurRegistry } = require('./secur/registry');
const { SecurNotifier } = require('./secur/notify');
const { UndoQueue, UndoBreaker } = require('./secur/undoQueue');
const journal = require('./secur/journal');
const cards = require('./secur/cards');

const logger = createLogger('secur');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Une entrée d'audit reçue plus de 60 s après son horodatage est comptée, jamais annulée. */
const LATE_MS = MINUTE;
/** Un incident (auteur) reste ouvert 60 s après sa dernière action : une sanction, une ligne. */
const INCIDENT_MS = MINUTE;
/** Incidents ouverts gardés en mémoire (les plus anciens sortent d'abord). */
const MAX_OPEN_INCIDENTS = 20;
/** Entrées gardées au-delà de leur fenêtre (comparaison avec une entrée reçue en retard). */
const WINDOW_RETENTION_MS = 5 * MINUTE;
const PRUNE_INTERVAL_MS = MINUTE;
/** Accès de whitelist en attente : n'exemptent pas pendant 24 h au plus. */
const GRANT_TTL_MS = DAY;
const INCIDENT_RETENTION_MS = 90 * DAY;
const GRANT_RETENTION_MS = 30 * DAY;
const PURGE_INTERVAL_MS = HOUR;
/** Bot auteur arrivé depuis moins de 7 jours : expulsé (réglage botExecutor « recent »). */
const RECENT_BOT_MS = 7 * DAY;
const BOT_REMOVED_TTL_MS = 10 * MINUTE;
const SNOWFLAKE = /^\d{17,20}$/;
/** Types du chemin historique de l'AntiRaid (seuils antiraid.*Threshold). */
const HISTORICAL_TYPES = new Set(['channelDelete', 'roleDelete', 'ban', 'kick']);
const HISTORICAL_LABELS = { channelDelete: 'Suppression de salons', roleDelete: 'Suppression de rôles', ban: 'Bannissements', kick: 'Expulsions' };

const rank = (punish) => Math.max(0, S.PUNISH_ORDER.indexOf(punish));

/** Horodatage d'une entrée d'audit : son snowflake (jamais l'instant de réception). Pur. */
function auditTimestamp(entry, fallback = Date.now()) {
  if (Number.isFinite(entry?.createdTimestamp)) return entry.createdTimestamp;
  try {
    if (entry?.id && SNOWFLAKE.test(String(entry.id))) return SnowflakeUtil.timestampFrom(String(entry.id));
  } catch {
    /* identifiant illisible */
  }
  return fallback;
}

/**
 * Meilleure fenêtre de `windowMs` contenant l'instant `at` : somme des poids et entrées. Pur.
 * Les entrées peuvent arriver dans le désordre (horodatages du journal d'audit).
 */
function bestWindow(entries, at, windowMs) {
  const near = entries.filter((e) => Math.abs(e.at - at) <= windowMs).sort((a, b) => a.at - b.at);
  let best = { sum: 0, list: [] };
  for (const start of near) {
    if (start.at > at) break;
    const list = near.filter((e) => e.at >= start.at && e.at <= start.at + windowMs);
    const sum = list.reduce((n, e) => n + e.weight, 0);
    if (sum > best.sum) best = { sum, list };
  }
  return best;
}

/**
 * Secur : moteur anti-nuke commun (SEC1). Les modules (registre) classent les entrées du journal
 * d'audit ; le moteur compte par fenêtre glissante calculée sur l'HORODATAGE des entrées, ouvre UN
 * incident par auteur (une sanction, une ligne), annule les actions dans une file à priorités
 * protégée par un disjoncteur, et remet les alertes hors filtres des logs (notify).
 *
 * Contrats (voir plan.notes) : assertAllowed, reportBotAction, signal, covers, recordGrant,
 * journal, restore, noteBotRemoved, processSecurityDue, purgeGuild.
 */
class SecurService {
  /**
   * @param {{ client: object, config: object, logging: object, antiraid?: object, incidents?: object, grants?: object,
   *   registry?: SecurRegistry, modulesDir?: string, now?: () => number }} deps
   */
  constructor({ client, config, logging, antiraid = null, incidents = null, grants = null, registry = null, modulesDir = path.join(__dirname, 'secur', 'modules'), now = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    this.antiraid = antiraid;
    this.incidents = incidents;
    this.grants = grants;
    this.now = now;
    this.registry = registry ?? new SecurRegistry().load(modulesDir);
    this.notifier = new SecurNotifier({ client, config, logging, now });
    this.breaker = new UndoBreaker({ now });
    /** @type {Map<string, { windowMs: number, entries: object[] }>} `${guild}:${auteur}:${module}` */
    this.windows = new Map();
    /** @type {Map<string, object>} incidents ouverts `${guild}:${auteur}` */
    this.open = new Map();
    /** @type {Map<string, UndoQueue>} files d'annulation par serveur */
    this.queues = new Map();
    /** @type {Map<string, number>} bots retirés par l'AntiRaid `${guild}:${bot}` → instant */
    this.botsRemoved = new Map();
    /** @type {Set<string>} expulsions de bots en cours (bouton) */
    this.kickingBots = new Set();
    this.lastPrune = now();
    this.lastPurgeAt = 0;
    this.stopped = false;
  }

  /* ------------------------------------------------------------------ */
  /* Niveaux, couverture                                                  */
  /* ------------------------------------------------------------------ */

  /** Options des niveaux de sécurité (OWNER_IDS de confiance, identifiant du bot). */
  levelOpts() {
    return {
      botOwnerIds: this.client.config?.ownerIds ?? [],
      trustBotOwners: Boolean(this.client.config?.securTrustBotOwners),
      botId: this.client.user?.id ?? null,
    };
  }

  /**
   * Accès de whitelist EN ATTENTE d'un utilisateur (n'exemptent pas), ou null s'il n'y en a pas.
   * @returns {{ user: boolean, roles: Set<string> }|null}
   */
  pendingExemptions(guildId, userId) {
    if (!this.grants || !guildId) return null;
    let rows;
    try {
      rows = this.grants.pending(guildId, this.now() - GRANT_TTL_MS);
    } catch {
      return null;
    }
    if (!rows.length) return null;
    const roles = new Set();
    let user = false;
    for (const g of rows) {
      if (g.kind === 'user' && g.subject_id === userId) user = true;
      else if (g.kind === 'role' && g.subject_id === userId && g.role_id) roles.add(g.role_id);
      else if (g.kind === 'wlrole') roles.add(g.subject_id);
    }
    return user || roles.size ? { user, roles } : null;
  }

  /** Niveau de sécurité d'un utilisateur (membre relu par l'appelant). */
  levelOf(guild, userId, member = null, isBot = Boolean(member?.user?.bot)) {
    const roleIds = member?.roles?.cache?.keys ? [...member.roles.cache.keys()] : [];
    return S.securityLevel(guild, userId, roleIds, this.config.get(guild.id), { ...this.levelOpts(), isBot, pending: this.pendingExemptions(guild.id, userId) });
  }

  /** Module chargé (registre) ET actif (mode ≠ off) sur ce serveur. Un module suspendu reste couvert. */
  covers(guildId, key) {
    if (!guildId || !this.registry.has(key)) return false;
    return S.moduleMode(this.config.get(guildId), key) !== 'off';
  }

  /** Au moins un module chargé est actif sur ce serveur. */
  isActive(guildId) {
    if (!this.registry.modules.size || !guildId) return false;
    const cfg = this.config.get(guildId);
    return this.registry.keys().some((k) => S.moduleMode(cfg, k) !== 'off');
  }

  /** État des 18 modules déclarés (panneau, section statut). */
  moduleStatus(guildId) {
    const cfg = this.config.get(guildId);
    return S.MODULE_KEYS.map((key) => ({
      key,
      ...S.SECUR_MODULES[key],
      loaded: this.registry.has(key),
      mode: S.moduleMode(cfg, key),
      limit: S.effectiveLimit(cfg, key),
      suspendedUntil: this.breaker.suspendedUntil(guildId, key),
    }));
  }

  async #member(guild, userId) {
    if (!userId) return null;
    return guild.members?.cache?.get?.(userId) ?? (await guild.members?.fetch?.(userId).catch(() => null)) ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Pipeline                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Entrée du journal d'audit (src/events/securAudit.js). Sortie immédiate si aucun module n'est
   * actif (config en cache). Les accès de whitelist donnés par un non-owner sont suivis même
   * Secur coupé.
   */
  async handleAuditEntry(entry, guild) {
    if (this.stopped || !guild?.id || !entry) return;
    if (entry.action === AuditLogEvent.MemberRoleUpdate) await this.#watchWhitelistRoles(entry, guild).catch((e) => logger.warn('Suivi des rôles whitelistés :', e?.message));
    if (!this.registry.modules.size) return;
    const cfg = this.config.get(guild.id);
    const mods = this.registry.forType(entry.action).filter((m) => S.moduleMode(cfg, m.key) !== 'off');
    if (!mods.length) return;
    const executorId = entry.executorId;
    if (!executorId || executorId === this.client.user?.id) return;
    const at = auditTimestamp(entry, this.now());
    const classified = [];
    for (const mod of mods) {
      try {
        const res = mod.classify(entry, guild, { client: this.client, service: this, cfg, moduleCfg: S.moduleConfig(cfg, mod.key), at });
        if (res) classified.push([mod, res]);
      } catch (e) {
        logger.warn(`Module Secur ${mod.key} : classify a échoué`, e?.message);
      }
    }
    if (!classified.length) return;
    const member = await this.#member(guild, executorId);
    const isBot = Boolean(member?.user?.bot ?? entry.executor?.bot);
    const level = this.levelOf(guild, executorId, member, isBot);
    for (const [mod, res] of classified) {
      if (S.isExempt(level, S.moduleMode(cfg, mod.key))) continue;
      await this.#count(guild, executorId, mod.key, { at, weight: res.weight, record: res.record ?? null, member, isBot });
    }
  }

  /**
   * Action hors journal d'audit (message @everyone…) signalée par un module ou un écouteur.
   * @returns {Promise<object|null>} incident ouvert ou rejoint (null : sous le seuil, exempté, coupé)
   */
  async signal(guild, executorId, key, record = null, { at = this.now(), weight = 1 } = {}) {
    if (this.stopped || !guild?.id || !this.covers(guild.id, key) || !executorId || executorId === this.client.user?.id) return null;
    const member = await this.#member(guild, executorId);
    const isBot = Boolean(member?.user?.bot);
    if (S.isExempt(this.levelOf(guild, executorId, member, isBot), S.moduleMode(this.config.get(guild.id), key))) return null;
    return this.#count(guild, executorId, key, { at, weight, record, member, isBot });
  }

  /**
   * Action faite PAR LE BOT pour un modérateur (/ban, /channel supprimer…), déjà autorisée par
   * assertAllowed : comptée au nom du modérateur (at = maintenant, count actions).
   */
  async reportBotAction(guild, moderator, type, { count = 1, targetId = null, at = this.now() } = {}) {
    if (this.stopped || !guild?.id || !moderator?.id || moderator.id === this.client.user?.id || !this.covers(guild.id, type)) return null;
    const member = await this.#member(guild, moderator.id);
    const isBot = Boolean(member?.user?.bot ?? moderator.bot);
    if (S.isExempt(this.levelOf(guild, moderator.id, member, isBot), S.moduleMode(this.config.get(guild.id), type))) return null;
    return this.#count(guild, moderator.id, type, { at, weight: count, record: { targetId, viaBot: true }, member, isBot });
  }

  /** Somme des actions d'un auteur dans la fenêtre courante d'un module. */
  windowSum(guildId, userId, key, now = this.now()) {
    const w = this.windows.get(`${guildId}:${userId}:${key}`);
    if (!w) return 0;
    const windowMs = S.effectiveWindowMs(this.config.get(guildId), key);
    return w.entries.filter((e) => e.at > now - windowMs && e.at <= now).reduce((n, e) => n + e.weight, 0);
  }

  #window(key, windowMs) {
    let w = this.windows.get(key);
    if (!w) {
      w = { windowMs, entries: [] };
      this.windows.set(key, w);
    }
    w.windowMs = windowMs;
    return w;
  }

  /** Incident ouvert d'un auteur (ou null s'il a expiré). */
  #openIncident(key, now) {
    const state = this.open.get(key);
    if (!state) return null;
    if (now > state.expiresAt) {
      this.open.delete(key);
      return null;
    }
    return state;
  }

  /**
   * Compte une action. Section critique SYNCHRONE (aucun await) : des entrées concurrentes
   * partagent le même incident (une sanction, une ligne), chacune avec sa tâche d'annulation.
   */
  #count(guild, executorId, key, { at, weight = 1, record = null, member = null, isBot = false }) {
    const now = this.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    const cfg = this.config.get(guild.id);
    const windowMs = S.effectiveWindowMs(cfg, key);
    const limit = S.effectiveLimit(cfg, key);
    const entry = { at, weight: Math.max(1, Math.floor(Number(weight)) || 1), record, late: now - at > LATE_MS, queued: false, counted: false };
    const w = this.#window(`${guild.id}:${executorId}:${key}`, windowMs);
    w.entries.push(entry);
    const best = bestWindow(w.entries, at, windowMs);
    const triggered = best.sum >= limit;
    const incKey = `${guild.id}:${executorId}`;
    let state = this.#openIncident(incKey, now);
    if (!triggered && !state) return Promise.resolve(null);
    let list = [entry];
    if (triggered) {
      const consumed = new Set(best.list);
      w.entries = w.entries.filter((e) => !consumed.has(e));
      list = best.list;
    }
    if (!state) state = this.#createIncident(guild, executorId, now, member, isBot);
    state.guild = guild;
    state.expiresAt = now + INCIDENT_MS;
    if (member?.user) state.executor = member.user;
    for (const e of list) {
      if (e.counted) continue;
      e.counted = true;
      state.actions += e.weight;
    }
    if (triggered) {
      state.modules.add(key);
      if (S.moduleMode(cfg, key) === 'max') state.maxMode = true;
      const punish = S.modulePunish(cfg, key);
      if (rank(punish) > rank(state.target)) state.target = punish;
    }
    for (const e of list) this.#queueUndo(guild, state, key, e, cfg);
    return this.#schedule(state, guild).then(() => state);
  }

  #createIncident(guild, executorId, now, member, isBot) {
    const state = {
      key: `${guild.id}:${executorId}`,
      guildId: guild.id,
      guild,
      executorId,
      executor: member?.user ?? null,
      isBot,
      createdAt: now,
      expiresAt: now + INCIDENT_MS,
      modules: new Set(),
      actions: 0,
      target: 'none',
      attempted: null,
      applied: 'none',
      removedRoles: [],
      details: [],
      undoTotal: 0,
      undoPending: 0,
      undone: 0,
      undoFailed: 0,
      undoSkipped: 0,
      lateSkipped: 0,
      overflow: false,
      idMap: new Map(),
      chain: Promise.resolve(),
      queued: null,
      posted: false,
      message: null,
      lastCard: null,
      botPending: false,
      botKicked: null,
      maxMode: false,
      id: null,
    };
    try {
      state.id = this.incidents?.create({ guildId: guild.id, executorId, modules: [], actions: 0, punishment: 'none', outcome: 'pending', createdAt: now }) ?? null;
    } catch (e) {
      logger.warn('Incident Secur non enregistré :', e?.message);
    }
    this.open.delete(state.key);
    this.open.set(state.key, state);
    while (this.open.size > MAX_OPEN_INCIDENTS) this.open.delete(this.open.keys().next().value);
    return state;
  }

  /** File d'annulation d'un serveur (créée au besoin). */
  #queue(guildId) {
    let q = this.queues.get(guildId);
    if (!q) {
      q = new UndoQueue({
        isPaused: () => Boolean(this.client.services?.backup?.isRestoring?.(guildId)),
        execute: (task) => this.#runUndo(task),
      });
      this.queues.set(guildId, q);
    }
    return q;
  }

  #queueUndo(guild, state, key, entry, cfg) {
    if (entry.queued) return;
    entry.queued = true;
    if (entry.late) {
      state.lateSkipped += 1;
      return;
    }
    const mod = this.registry.get(key);
    if (!mod || typeof mod.undo !== 'function' || !S.SECUR_MODULES[key].undoable || S.moduleConfig(cfg, key).undo !== true) return;
    if (this.breaker.isSuspended(guild.id, key)) {
      state.undoSkipped += 1;
      return;
    }
    let targetKey = null;
    try {
      targetKey = typeof mod.targetKey === 'function' ? mod.targetKey(entry.record) : null;
    } catch {
      targetKey = null;
    }
    const task = { priority: mod.priority, module: key, targetKey, guildId: guild.id, record: entry.record, at: entry.at, state };
    if (!this.#queue(guild.id).push(task)) {
      state.overflow = true;
      return;
    }
    state.undoTotal += 1;
    state.undoPending += 1;
  }

  async #runUndo(task) {
    const { state, module: key, guildId } = task;
    try {
      const guild = this.client.guilds?.cache?.get?.(guildId) ?? state.guild;
      if (!guild || this.breaker.isSuspended(guildId, key)) {
        state.undoSkipped += 1;
        return;
      }
      const mod = this.registry.get(key);
      const cfg = this.config.get(guildId);
      let res;
      try {
        res = await mod.undo(guild, task.record, { client: this.client, service: this, cfg, moduleCfg: S.moduleConfig(cfg, key), idMap: state.idMap, incidentId: state.id, at: task.at });
      } catch (e) {
        res = { ok: false, note: e?.message };
      }
      if (res?.ok) state.undone += 1;
      else {
        state.undoFailed += 1;
        if (res?.note && state.details.length < 8) state.details.push(String(res.note).slice(0, 200));
      }
      if (this.breaker.note(guildId, key, task.targetKey)) await this.#trip(guild, key, task.targetKey);
    } finally {
      state.undoPending = Math.max(0, state.undoPending - 1);
      if (state.undoPending === 0) this.#schedule(state, state.guild).catch(() => {});
    }
  }

  /** Disjoncteur déclenché : file du module vidée, carte « Conflit d'annulation ». */
  async #trip(guild, key, targetKey) {
    const removed = this.queues.get(guild.id)?.clearModule(key) ?? [];
    for (const t of removed) {
      t.state.undoSkipped += 1;
      t.state.undoPending = Math.max(0, t.state.undoPending - 1);
      if (t.state.undoPending === 0) this.#schedule(t.state, t.state.guild).catch(() => {});
    }
    logger.warn(`Disjoncteur Secur : module ${key} suspendu sur ${guild.id} (${removed.length} annulation(s) abandonnée(s)).`);
    await this.notifier.deliver(guild, { embed: cards.conflictCard({ moduleKey: key, targetKey, until: this.breaker.suspendedUntil(guild.id, key) }) }, { fallback: true, event: 'secur', fingerprint: `conflict:${key}` }).catch(() => {});
  }

  /** Regroupe les mises à jour d'un incident (sanction, ligne, carte) en une seule passe à la fois. */
  #schedule(state, guild) {
    if (state.queued) return state.queued;
    const run = state.chain.then(() => {
      state.queued = null;
      return this.#settle(state, guild);
    });
    state.queued = run;
    state.chain = run.catch((e) => logger.warn('Incident Secur :', e?.message ?? e));
    return state.chain;
  }

  /** Détails affichés et enregistrés d'un incident. */
  #details(state) {
    const lines = [...state.details];
    if (state.lateSkipped) lines.push(`${state.lateSkipped} action(s) reçue(s) plus de 60 s après coup : comptée(s), jamais annulée(s).`);
    if (state.overflow) lines.push('File d\'annulation pleine (500 tâches) : restaurez avec /backup.');
    if (state.undoSkipped) lines.push(`${state.undoSkipped} annulation(s) suspendue(s) : conflit d'annulation (disjoncteur).`);
    return lines;
  }

  #view(state) {
    return {
      id: state.id ?? 0,
      executorId: state.executorId,
      executor: state.executor,
      modules: [...state.modules],
      actions: state.actions,
      punishment: state.applied,
      details: this.#details(state),
      undone: state.undone,
      undoFailed: state.undoFailed,
      undoTotal: state.undoTotal,
      restoreKind: state.applied === 'ban' ? 'unban' : state.applied === 'derank' && state.removedRoles.length ? 'roles' : null,
      restoredBy: state.restoredBy ?? null,
      botPending: state.botPending,
      botKicked: state.botKicked,
    };
  }

  async #settle(state, guild) {
    if (state.attempted === null || rank(state.target) > rank(state.attempted)) await this.#punish(guild, state);
    const view = this.#view(state);
    if (state.id && this.incidents) {
      try {
        this.incidents.update(guild.id, state.id, {
          modules: view.modules,
          actions: view.actions,
          punishment: state.applied,
          outcome: view.details.join('\n') || 'ok',
          removedRoles: state.removedRoles.length ? state.removedRoles : null,
          undone: state.undone,
          undoFailed: state.undoFailed,
        }, this.now());
      } catch (e) {
        logger.debug('Mise à jour de l\'incident :', e?.message);
      }
    }
    const embed = cards.incidentCard(view);
    const components = cards.incidentButtons(view);
    const snapshot = JSON.stringify({ ...view, executor: view.executor?.id ?? null });
    if (!state.posted) {
      state.posted = true;
      state.lastCard = snapshot;
      const res = await this.notifier.deliver(guild, { embed, components }, {
        critical: true,
        fallback: true,
        ping: true,
        event: 'secur',
        fingerprint: `incident:${guild.id}:${state.id ?? state.executorId}`,
      });
      state.message = res.message;
      if (res.message && state.id) this.incidents?.setAlert?.(guild.id, state.id, res.channelId, res.message.id);
      return;
    }
    if (state.message && snapshot !== state.lastCard) {
      state.lastCard = snapshot;
      await state.message.edit({ embeds: fitEmbeds([embed]), components }).catch((e) => logger.debug('Carte d\'incident non modifiée :', e?.message));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sanctions                                                            */
  /* ------------------------------------------------------------------ */

  #casier(guild, userId, type, reason) {
    try {
      this.client.repositories?.sanctions?.create?.({ guildId: guild.id, userId, moderatorId: this.client.user?.id ?? userId, type, reason });
    } catch (e) {
      logger.debug('Casier Secur :', e?.message);
    }
  }

  async #kick(guild, member, reason) {
    if (!member) return { ok: false, error: 'déjà parti' };
    if (member.kickable === false) return { ok: false, error: 'non expulsable' };
    this.client.services?.welcome?.silence?.(guild.id, member.id);
    try {
      await member.kick(reason);
      this.#casier(guild, member.id, 'kick', reason);
      return { ok: true };
    } catch (e) {
      this.client.services?.welcome?.unsilence?.(guild.id, member.id);
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  async #ban(guild, userId, member, reason) {
    if (member && member.bannable === false) return { ok: false, error: 'non bannissable' };
    const moderation = this.client.services?.moderation;
    moderation?.markBotAction?.('ban', guild.id, userId);
    this.client.services?.welcome?.silence?.(guild.id, userId);
    try {
      await guild.bans.create(userId, { reason });
      this.#casier(guild, userId, 'ban', reason);
      return { ok: true };
    } catch (e) {
      moderation?.unmarkBotAction?.('ban', guild.id, userId);
      this.client.services?.welcome?.unsilence?.(guild.id, userId);
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /** Derank : un seul PATCH, rôles gérés ou non modifiables conservés, rôles retirés mémorisés. */
  async #strip(member, reason, state) {
    const res = this.antiraid?.stripMember
      ? await this.antiraid.stripMember(member, reason, { dangerous: S.DANGEROUS })
      : { ok: false, removed: [], dangerousLeft: true, note: 'AntiRaid indisponible.' };
    if (res.removed.length) {
      state.removedRoles = [...new Set([...state.removedRoles, ...res.removed])];
      if (rank(state.applied) < rank('derank')) state.applied = 'derank';
    }
    return res;
  }

  /**
   * Applique la sanction la plus forte des modules déclenchés (escalade comprise). La sanction
   * du module PRIME : « none » n'est jamais transformée en expulsion.
   */
  async #punish(guild, state) {
    const target = state.target;
    state.attempted = target;
    if (target === 'none') return;
    const cfg = this.config.get(guild.id);
    const reason = `Secur : ${[...state.modules].map((k) => S.SECUR_MODULES[k]?.label ?? k).join(', ')}`.slice(0, 400);
    const member = await this.#member(guild, state.executorId);
    if (!member) {
      if (target === 'ban' && state.applied !== 'ban') {
        const res = await this.#ban(guild, state.executorId, null, reason);
        if (res.ok) {
          state.applied = 'ban';
          state.details.push('L\'auteur avait quitté le serveur : banni par identifiant.');
        } else state.details.push(`L'auteur a quitté le serveur ; bannissement par identifiant impossible (${String(res.error).slice(0, 100)}).`);
      } else if (rank(state.applied) < rank('kick')) state.details.push('L\'auteur a quitté le serveur avant la sanction.');
      return;
    }
    if (member.user?.bot) return this.#punishBot(guild, state, member, target, reason, cfg);
    if (target === 'derank') {
      if (rank(state.applied) >= rank('derank')) return;
      const res = await this.#strip(member, reason, state);
      if (!res.dangerousLeft) {
        if (!res.removed.length && res.note) state.details.push(res.note);
        return;
      }
      // Permission dangereuse résiduelle (rôle non modifiable, @everyone, surcharge) : expulsion.
      const kicked = await this.#kick(guild, member, `${reason} (permission dangereuse résiduelle)`);
      if (kicked.ok) {
        state.applied = 'kick';
        state.details.push('Il gardait une permission dangereuse après le retrait des rôles : expulsé.');
      } else state.details.push(`**Non sanctionnable** : il garde une permission dangereuse et je ne peux pas l'expulser (${String(kicked.error).slice(0, 100)}).`);
      return;
    }
    if (target === 'kick') {
      if (rank(state.applied) >= rank('kick')) return;
      const res = await this.#kick(guild, member, reason);
      if (res.ok) state.applied = 'kick';
      else state.details.push(`Expulsion impossible (${String(res.error).slice(0, 100)}).`);
      return;
    }
    if (target === 'ban' && state.applied !== 'ban') {
      const res = await this.#ban(guild, member.id, member, reason);
      if (res.ok) state.applied = 'ban';
      else state.details.push(`Bannissement impossible (${String(res.error).slice(0, 100)}).`);
    }
  }

  /**
   * Exécuteur BOT (sanction ≠ none) : le derank ne retire pas son rôle géré, d'où botExecutor :
   * always → expulsion ; recent (défaut) → expulsion s'il est arrivé il y a moins de 7 jours ou
   * si un module est en max, sinon carte « Bot non neutralisé » + bouton + ping ; never → carte.
   */
  async #punishBot(guild, state, member, target, reason, cfg) {
    const policy = S.BOT_EXECUTOR_POLICIES.includes(cfg.secur?.botExecutor) ? cfg.secur.botExecutor : 'recent';
    const recent = Number.isFinite(member.joinedTimestamp) && this.now() - member.joinedTimestamp < RECENT_BOT_MS;
    const remove = policy === 'always' || (policy === 'recent' && (recent || state.maxMode));
    if (remove) {
      const res = target === 'ban' ? await this.#ban(guild, member.id, member, reason) : await this.#kick(guild, member, reason);
      if (res.ok) {
        state.applied = target === 'ban' ? 'ban' : 'kick';
        state.botPending = false;
        return;
      }
      state.details.push(`Bot non expulsé (${String(res.error).slice(0, 100)}).`);
      state.botPending = true;
      return;
    }
    if (rank(state.applied) < rank('derank')) {
      const res = await this.#strip(member, reason, state);
      if (!res.dangerousLeft) return; // rôle d'administration non géré : neutralisé
    }
    state.botPending = true;
    if (!state.details.some((d) => d.startsWith('Bot arrivé'))) {
      state.details.push(policy === 'never'
        ? 'Bot auteur : jamais expulsé automatiquement (réglage « bot auteur » : jamais).'
        : 'Bot arrivé il y a plus de 7 jours : non expulsé automatiquement (réglage « bot auteur » : récent).');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pré-contrôle                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Pré-contrôle d'une action faite PAR LE BOT pour un membre (avant tout appel à Discord) :
   * refus d'emblée si `count` actions, ajoutées à la fenêtre courante, atteindraient le seuil.
   * Un admin légitime n'est ainsi jamais sanctionné au milieu d'une opération groupée.
   * Synchrone ; lève une UserError en cas de refus.
   * @param {{ guild: import('discord.js').Guild, user?: object, member?: object }} ctx interaction ou équivalent
   * @param {string} type clé de module Secur ou type historique (channelDelete, roleDelete, ban, kick)
   */
  assertAllowed(ctx, type, { count = 1, targetId = null } = {}) {
    const guild = ctx?.guild;
    const user = ctx?.user ?? ctx?.member?.user ?? null;
    const userId = user?.id;
    if (!guild?.id || !userId) return true;
    const n = Math.max(1, Math.floor(Number(count)) || 1);
    const cfg = this.config.get(guild.id);
    const member = ctx.member?.roles?.cache?.keys ? ctx.member : guild.members?.cache?.get?.(userId) ?? null;
    const roleIds = member?.roles?.cache?.keys ? [...member.roles.cache.keys()] : Array.isArray(ctx.member?.roles) ? ctx.member.roles : [];
    const opts = this.levelOpts();
    if (userId === opts.botId) return true;
    if (this.covers(guild.id, type)) {
      const mode = S.moduleMode(cfg, type);
      const level = S.securityLevel(guild, userId, roleIds, cfg, { ...opts, isBot: Boolean(user.bot), pending: this.pendingExemptions(guild.id, userId) });
      if (S.isExempt(level, mode)) return true;
      const limit = S.effectiveLimit(cfg, type);
      if (this.windowSum(guild.id, userId, type) + n >= limit) this.#refuse(guild, userId, S.SECUR_MODULES[type].label, n, limit);
      return true;
    }
    if (!HISTORICAL_TYPES.has(type) || !cfg.antiraid?.enabled || typeof this.antiraid?.wouldTrigger !== 'function') return true;
    if (userId === guild.ownerId) return true;
    if (this.antiraid.isWhitelisted(guild.id, userId, roleIds, { excludePending: true })) return true;
    const limit = this.antiraid.wouldTrigger(guild, userId, type, n, { targetId });
    if (limit) this.#refuse(guild, userId, HISTORICAL_LABELS[type], n, limit);
    return true;
  }

  #refuse(guild, userId, label, count, limit) {
    Promise.resolve(this.logging?.send?.(guild.id, 'security', cards.blockedCard({ userId, label, count, limit }), undefined, { event: 'secur' })).catch(() => {});
    throw new UserError(`Action bloquée par la sécurité (${label}) : ${count} action(s) atteindraient le seuil. Demandez à un owner.`);
  }

  /* ------------------------------------------------------------------ */
  /* Accès de whitelist en attente                                        */
  /* ------------------------------------------------------------------ */

  /** Audit 25 : rôle de whitelist.roles ajouté par un auteur qui n'est ni owner, ni le bot. */
  async #watchWhitelistRoles(entry, guild) {
    const cfg = this.config.get(guild.id);
    const wlRoles = Array.isArray(cfg.whitelist?.roles) ? cfg.whitelist.roles : [];
    if (!wlRoles.length || !this.grants) return;
    const added = entry.changes?.find?.((c) => c.key === '$add')?.new ?? [];
    const hits = added.map((r) => r?.id).filter((id) => id && wlRoles.includes(id) && !guild.roles?.cache?.get?.(id)?.managed);
    const executorId = entry.executorId;
    const targetId = entry.targetId;
    if (!hits.length || !executorId || !targetId || executorId === this.client.user?.id) return;
    if (S.hasOwnerLevel(guild, targetId, cfg, this.levelOpts())) return;
    for (const roleId of hits) await this.recordGrant(guild, { kind: 'role', subjectId: targetId, roleId, grantedBy: executorId });
  }

  /**
   * Accès de whitelist donné par un auteur qui n'a pas le niveau owner : en attente (n'exempte
   * pas, 24 h au plus) et notifié tout de suite (carte critique hors filtres, MP au propriétaire,
   * boutons Approuver / Révoquer). Appelé par /whitelist, /antiraid (SEC2) et /role, /massrole (SEC5).
   * @param {{ kind: 'role'|'user'|'wlrole', subjectId: string, roleId?: string|null, grantedBy: string }} grant
   * @returns {Promise<{ id: number, existing: boolean }|null>} null : auteur owner (aucune attente)
   */
  async recordGrant(guild, { kind, subjectId, roleId = null, grantedBy }) {
    if (!this.grants || !guild?.id || !grantedBy || grantedBy === this.client.user?.id) return null;
    const cfg = this.config.get(guild.id);
    if (S.hasOwnerLevel(guild, grantedBy, cfg, this.levelOpts())) return null;
    let created;
    try {
      created = this.grants.create({ guildId: guild.id, kind, subjectId, roleId, grantedBy, grantedAt: this.now(), ttlMs: GRANT_TTL_MS });
    } catch (e) {
      logger.warn('Accès de whitelist non enregistré :', e?.message);
      return null;
    }
    if (created.existing) return created;
    const row = this.grants.get(guild.id, created.id);
    const res = await this.notifier.deliver(guild, { embed: cards.grantCard(row, { ttlMs: GRANT_TTL_MS }), components: cards.grantButtons(row) }, {
      critical: true,
      fallback: true,
      event: 'securGrant',
      fingerprint: `grant:${kind}:${subjectId}:${roleId ?? ''}`,
    });
    if (res.message) this.grants.setCard(guild.id, created.id, res.channelId, res.message.id);
    return created;
  }

  /**
   * Bouton secur:grant:<id>:approve|revoke (niveau owner). Verrou SQL : un seul clic gagne.
   * revoke retire le rôle (applyRoles) ou l'entrée de whitelist.
   */
  async decideGrant(interaction, id, action) {
    const guild = interaction.guild;
    S.assertOwnerLevel(guild, interaction.user.id, this.config.get(guild.id), this.levelOpts());
    if (action !== 'approve' && action !== 'revoke') throw new UserError('Action inconnue.');
    await interaction.deferUpdate();
    const grant = this.grants?.get(guild.id, id);
    if (!grant) throw new UserError('Cet accès est introuvable.');
    const won = action === 'approve' ? this.grants.approve(guild.id, id, interaction.user.id, this.now()) : this.grants.revoke(guild.id, id, interaction.user.id, this.now());
    const fresh = this.grants.get(guild.id, id);
    if (!won) {
      await interaction.editReply({ embeds: [cards.grantCard(fresh, { ttlMs: GRANT_TTL_MS })], components: cards.grantButtons(fresh) }).catch(() => {});
      await interaction.followUp({ embeds: [status.note('Cet accès a déjà été traité.')], ephemeral: true });
      return;
    }
    let note = action === 'approve' ? 'Accès approuvé : il exempte de nouveau.' : 'Accès révoqué.';
    if (action === 'revoke') note = await this.#revokeAccess(guild, fresh, interaction.user);
    await interaction.editReply({ embeds: [cards.grantCard(fresh, { ttlMs: GRANT_TTL_MS })], components: [] });
    await interaction.followUp({ embeds: [status.ok(note)], ephemeral: true });
    await Promise.resolve(this.logging?.send?.(guild.id, 'security', cards.grantCard(fresh, { ttlMs: GRANT_TTL_MS }), undefined, { event: 'securGrant' })).catch(() => {});
  }

  async #revokeAccess(guild, grant, user) {
    const reason = `Secur : accès de whitelist révoqué par ${user.tag ?? user.id}`.slice(0, 400);
    if (grant.kind === 'role') {
      const member = await this.#member(guild, grant.subject_id);
      if (!member) return 'Accès révoqué (le membre a quitté le serveur).';
      if (!member.roles.cache.has(grant.role_id)) return 'Accès révoqué (il n\'avait plus le rôle).';
      const res = await applyRoles(member, { remove: [grant.role_id] }, reason);
      return res.removed.length ? `Accès révoqué : rôle <@&${grant.role_id}> retiré à <@${grant.subject_id}>.` : `Accès révoqué, mais je n'ai pas pu retirer le rôle <@&${grant.role_id}> (hiérarchie ou permission).`;
    }
    const wl = this.config.get(guild.id).whitelist ?? {};
    if (grant.kind === 'user') {
      this.config.update(guild.id, { whitelist: { users: (wl.users ?? []).filter((u) => u !== grant.subject_id) } });
      return `Accès révoqué : <@${grant.subject_id}> retiré de la whitelist.`;
    }
    this.config.update(guild.id, { whitelist: { roles: (wl.roles ?? []).filter((r) => r !== grant.subject_id) } });
    return `Accès révoqué : rôle <@&${grant.subject_id}> retiré de la whitelist.`;
  }

  /** Accès en attente d'un serveur (section statut). */
  pendingGrants(guildId) {
    try {
      return this.grants?.pending(guildId, this.now() - GRANT_TTL_MS) ?? [];
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Boutons des cartes                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * secur:restore:<id> (niveau owner) : rend les rôles retirés, ou débannit. deferUpdate AVANT
   * tout appel lent (applyRoles passe les rôles un par un), puis verrou SQL (un seul clic gagne).
   */
  async restore(interaction, incidentId) {
    const guild = interaction.guild;
    S.assertOwnerLevel(guild, interaction.user.id, this.config.get(guild.id), this.levelOpts());
    await interaction.deferUpdate();
    const row = this.incidents?.get(guild.id, incidentId);
    if (!row) throw new UserError('Cet incident est introuvable (purgé après 90 jours ?).');
    if (!this.incidents.markRestored(guild.id, incidentId, interaction.user.id, this.now())) {
      await interaction.followUp({ embeds: [status.note('Cet incident a déjà été restauré.')], ephemeral: true });
      return;
    }
    const reason = `Secur : restauration par ${interaction.user.tag ?? interaction.user.id}`.slice(0, 400);
    let done = false;
    let note;
    if (row.punishment === 'ban') {
      this.client.services?.moderation?.markBotAction?.('unban', guild.id, row.executor_id);
      try {
        await guild.bans.remove(row.executor_id, reason);
        done = true;
        note = `<@${row.executor_id}> a été débanni.`;
      } catch (e) {
        this.client.services?.moderation?.unmarkBotAction?.('unban', guild.id, row.executor_id);
        if (e?.code === 10026) {
          done = true;
          note = `<@${row.executor_id}> n'était plus banni.`;
        } else note = `Débannissement impossible : ${String(e?.message ?? e).slice(0, 150)}.`;
      }
    } else {
      const member = await this.#member(guild, row.executor_id);
      const roles = (row.removed_roles ?? []).filter((id) => {
        const role = guild.roles?.cache?.get?.(id);
        return role && !role.managed && role.editable !== false;
      });
      if (!member) note = 'Le membre n\'est plus sur le serveur : rien à rendre pour le moment.';
      else if (!roles.length) note = 'Aucun des rôles retirés n\'existe encore (ou ils sont au-dessus de moi).';
      else {
        const res = await applyRoles(member, { add: roles }, reason);
        done = res.added.length > 0;
        note = done ? `${res.added.length} rôle(s) rendu(s) à <@${row.executor_id}>${res.failed.length ? ` (${res.failed.length} en échec)` : ''}.` : 'Aucun rôle n\'a pu être rendu (hiérarchie ou permission).';
      }
    }
    if (!done) {
      this.incidents.unmarkRestored(guild.id, incidentId, interaction.user.id);
      await interaction.followUp({ embeds: [status.warn(note)], ephemeral: true });
      return;
    }
    const fresh = this.incidents.get(guild.id, incidentId);
    const view = cards.viewFromRow(fresh);
    for (const state of this.open.values()) if (state.id === incidentId) state.restoredBy = interaction.user.id;
    await interaction.editReply({ embeds: [cards.incidentCard(view)], components: cards.incidentButtons(view) }).catch(() => {});
    await interaction.followUp({ embeds: [status.ok(note)], ephemeral: true });
  }

  /**
   * secur:kickbot:<botId> : un administrateur ayant « Expulser » expulse un bot que la politique
   * botExecutor n'a pas expulsé. Verrou en mémoire : un double clic ne fait qu'une expulsion.
   */
  async kickBot(interaction, botId) {
    const guild = interaction.guild;
    if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.KickMembers)) throw new UserError('Il vous faut la permission **Expulser des membres** pour cette action.');
    if (!SNOWFLAKE.test(String(botId ?? ''))) throw new UserError('Ce bouton est invalide.');
    const lock = `${guild.id}:${botId}`;
    if (this.kickingBots.has(lock)) throw new UserError('Expulsion déjà en cours.');
    this.kickingBots.add(lock);
    try {
      await interaction.deferUpdate();
      const member = await this.#member(guild, botId);
      const rows = (interaction.message?.components ?? [])
        .map((row) => ({ type: 1, components: (row.components ?? []).filter((c) => c.customId !== interaction.customId).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)) }))
        .filter((row) => row.components.length);
      if (!member) {
        await interaction.editReply({ components: rows }).catch(() => {});
        await interaction.followUp({ embeds: [status.note('Ce bot n\'est plus sur le serveur.')], ephemeral: true });
        return;
      }
      if (!member.user?.bot) throw new UserError('Ce bouton ne vise que les bots.');
      const mine = interaction.member;
      const above = interaction.user.id === guild.ownerId || (mine?.roles?.highest && member.roles?.highest ? mine.roles.highest.comparePositionTo(member.roles.highest) > 0 : true);
      if (!above) throw new UserError('Ce bot a un rôle égal ou supérieur au vôtre : vous ne pouvez pas l\'expulser.');
      const res = await this.#kick(guild, member, `Secur : bot expulsé par ${interaction.user.tag ?? interaction.user.id}`.slice(0, 400));
      if (!res.ok) throw new UserError(`Je ne peux pas expulser ce bot : ${String(res.error).slice(0, 150)}.`);
      for (const state of this.open.values()) if (state.guildId === guild.id && state.executorId === botId) state.botKicked = interaction.user.id;
      await interaction.editReply({ components: rows }).catch(() => {});
      await interaction.followUp({ embeds: [status.ok(`Bot <@${botId}> expulsé.`)], ephemeral: true });
      await Promise.resolve(this.logging?.send?.(guild.id, 'security', cards.botKickedCard({ botId, by: interaction.user.id }), undefined, { event: 'secur' })).catch(() => {});
    } finally {
      this.kickingBots.delete(lock);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Journal, bots retirés, maintenance                                   */
  /* ------------------------------------------------------------------ */

  /** Journal d'un changement de réglages de sécurité (voir secur/journal.js). */
  journal(guild, entry) {
    return journal.record({ client: this.client, logging: this.logging, notifier: this.notifier, config: this.config }, guild, entry);
  }

  /** L'AntiRaid (anti-bot) vient de retirer ce bot : le module `bot` n'a plus à le faire. */
  noteBotRemoved(guild, botId, now = this.now()) {
    if (!guild?.id || !botId) return;
    this.botsRemoved.delete(`${guild.id}:${botId}`);
    this.botsRemoved.set(`${guild.id}:${botId}`, now);
    while (this.botsRemoved.size > 1_000) this.botsRemoved.delete(this.botsRemoved.keys().next().value);
  }

  wasBotRemoved(guildId, botId, now = this.now()) {
    const at = this.botsRemoved.get(`${guildId}:${botId}`);
    return Boolean(at && now - at < BOT_REMOVED_TTL_MS);
  }

  /** Mémoire bornée : fenêtres, incidents expirés, disjoncteur, bots retirés. */
  prune(now = this.now()) {
    this.lastPrune = now;
    for (const [key, w] of this.windows) {
      w.entries = w.entries.filter((e) => e.at > now - (w.windowMs + WINDOW_RETENTION_MS));
      if (!w.entries.length) this.windows.delete(key);
    }
    for (const [key, state] of this.open) if (now > state.expiresAt) this.open.delete(key);
    for (const [key, at] of this.botsRemoved) if (now - at >= BOT_REMOVED_TTL_MS) this.botsRemoved.delete(key);
    this.breaker.prune();
  }

  /** Étape `security` du scheduler : purge des incidents (90 jours) et des accès (30 jours). */
  async processSecurityDue({ isStopping = () => false } = {}) {
    const now = this.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    if (isStopping() || now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    const incidents = this.incidents?.purgeBefore?.(now - INCIDENT_RETENTION_MS) ?? 0;
    const grants = this.grants?.purgeBefore?.(now - GRANT_RETENTION_MS) ?? 0;
    if (incidents || grants) logger.info(`Secur : ${incidents} incident(s) et ${grants} accès purgé(s).`);
  }

  /** Serveur quitté : état mémoire oublié (guildDelete, purge des serveurs quittés). */
  forgetGuild(guildId) {
    if (!guildId) return;
    const prefix = `${guildId}:`;
    for (const map of [this.windows, this.open, this.botsRemoved]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    const q = this.queues.get(guildId);
    if (q) {
      this.queues.delete(guildId);
      q.stop(0).catch(() => {});
    }
    this.breaker.forgetGuild(guildId);
    this.notifier.forgetGuild(guildId);
  }

  /** Données d'un serveur supprimées (incidents, accès) et état mémoire oublié. */
  purgeGuild(guildId) {
    if (!guildId) return 0;
    const n = (this.incidents?.purgeGuild?.(guildId) ?? 0) + (this.grants?.purgeGuild?.(guildId) ?? 0);
    this.forgetGuild(guildId);
    return n;
  }

  /** Arrêt : files d'annulation arrêtées (tâche en cours attendue 2 s au plus). */
  async stop() {
    this.stopped = true;
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(queues.map((q) => q.stop().catch(() => {})));
  }
}

module.exports = { SecurService, auditTimestamp, bestWindow, GRANT_TTL_MS, LATE_MS, INCIDENT_MS, RECENT_BOT_MS, INCIDENT_RETENTION_MS, GRANT_RETENTION_MS };
