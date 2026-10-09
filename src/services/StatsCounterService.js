'use strict';

const { ChannelType, GatewayIntentBits, PermissionFlagsBits: P } = require('discord.js');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('counters');

/** Discord limite le renommage d'un salon à 2 par 10 minutes : on s'en tient à 1. */
const RENAME_WINDOW_MS = 10 * 60_000;
/** Passage périodique (valeurs sans événement : salons, rôles…). */
const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Anti-rebond des déclenchements par événement (arrivée, départ, boost). */
const DEBOUNCE_MS = 30_000;
/**
 * Attente maximale d'un renommage. Au-delà (limite de Discord atteinte, par exemple après un
 * renommage à la main : discord.js attend jusqu'à 10 min), la mise à jour n'attend plus :
 * le renommage aboutit seul, le passage suivant corrige la valeur.
 */
const RENAME_TIMEOUT_MS = 15_000;
/** Liste complète des membres relue au plus toutes les 10 minutes (comptes humains / bots). */
const MEMBER_FETCH_INTERVAL_MS = 10 * 60_000;
const MAX_TEMPLATE = 100;
const MAX_NAME = 100;
const CATEGORY_NAME = '📊 Statistiques';

/**
 * Types de compteurs. `presence` : exige l'intent GuildPresences (privilégié) ;
 * sans lui, le compteur n'est pas proposé.
 */
const COUNTER_TYPES = Object.freeze({
  members: { label: 'Membres', emoji: '👥', template: '👥 Membres : {n}', description: 'Nombre total de membres' },
  humans: { label: 'Humains', emoji: '🧑', template: '🧑 Humains : {n}', description: 'Membres hors bots' },
  bots: { label: 'Bots', emoji: '🤖', template: '🤖 Bots : {n}', description: 'Nombre de bots' },
  online: { label: 'En ligne', emoji: '🟢', template: '🟢 En ligne : {n}', description: 'Membres connectés', presence: true },
  boosts: { label: 'Boosts', emoji: '💎', template: '💎 Boosts : {n}', description: 'Nombre de boosts du serveur' },
  channels: { label: 'Salons', emoji: '💬', template: '💬 Salons : {n}', description: 'Salons (hors catégories et fils)' },
  roles: { label: 'Rôles', emoji: '🎭', template: '🎭 Rôles : {n}', description: 'Rôles (hors @everyone)' },
});
const COUNTER_KEYS = Object.keys(COUNTER_TYPES);

/**
 * Attend `promise` au plus `ms` (minuteur unref). Ne rejette jamais.
 * @returns {Promise<{ value?: unknown, error?: unknown, timedOut?: boolean }>}
 */
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([promise.then((value) => ({ value }), (error) => ({ error: error ?? new Error('échec') })), timeout]).finally(() => clearTimeout(timer));
}

/** L'intent GuildPresences est-il activé (src/config/intents.js) ? */
function hasPresenceIntent(client) {
  try {
    return Boolean(client?.options?.intents?.has?.(GatewayIntentBits.GuildPresences));
  } catch {
    return false;
  }
}

/** Types proposés sur ce bot (sans « En ligne » si l'intent des présences est absent). */
function availableTypes(client) {
  const presence = hasPresenceIntent(client);
  return COUNTER_KEYS.filter((k) => presence || !COUNTER_TYPES[k].presence);
}

/** Nombre au format français, espaces simples (noms de salons). Pur. */
function formatCount(n) {
  return Number(n ?? 0).toLocaleString('fr-FR').replace(/\s/g, ' ');
}

/** Nom du salon à partir d'un modèle (`{n}` = valeur), borné à 100 caractères. Pur. */
function renderName(template, value) {
  const name = String(template).replaceAll('{n}', formatCount(value)).replace(/\s+/g, ' ').trim();
  return [...name].slice(0, MAX_NAME).join('') || formatCount(value);
}

/**
 * Valide un modèle saisi (≤ 100 caractères, contient {n}). Pur.
 * @returns {string} modèle nettoyé
 */
function validateTemplate(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) throw new UserError('Le modèle ne peut pas être vide.');
  if ([...t].length > MAX_TEMPLATE) throw new UserError(`Le modèle dépasse ${MAX_TEMPLATE} caractères.`);
  if (!t.includes('{n}')) throw new UserError('Le modèle doit contenir `{n}`, remplacé par la valeur du compteur (ex : `👥 Membres : {n}`).');
  return t;
}

/** Valeurs actuelles de chaque compteur (lecture du cache, synchrone). */
function computeValues(guild) {
  const members = guild.members?.cache;
  const total = guild.memberCount ?? members?.size ?? 0;
  const bots = members ? members.filter((m) => m.user?.bot).size : 0;
  const channels = guild.channels?.cache;
  return {
    members: total,
    humans: Math.max(0, total - bots),
    bots,
    online: members ? members.filter((m) => m.presence && m.presence.status !== 'offline').size : 0,
    boosts: guild.premiumSubscriptionCount ?? 0,
    channels: channels ? channels.filter((c) => c.type !== ChannelType.GuildCategory && !c.isThread?.()).size : 0,
    roles: Math.max(0, (guild.roles?.cache?.size ?? 1) - 1),
  };
}

/** Permissions nécessaires sur un salon compteur pour le renommer. */
const CHANNEL_PERMS = [P.ViewChannel, P.Connect, P.ManageChannels];

/**
 * Compteurs de statistiques : salons vocaux verrouillés (Connect refusé à @everyone) dont
 * le nom affiche une valeur. Mises à jour groupées : au plus un renommage par salon et par
 * 10 minutes, seulement si la valeur a changé ; déclenchées par un passage périodique
 * (minuteur unref, arrêté à l'arrêt du bot) et, avec anti-rebond, par les arrivées,
 * départs et boosts.
 */
class StatsCounterService {
  /** @param {{ client: import('discord.js').Client, config: import('./ConfigService').ConfigService }} deps */
  constructor({ client, config }) {
    this.client = client;
    this.config = config;
    this.debounceMs = DEBOUNCE_MS;
    this.sweepMs = SWEEP_INTERVAL_MS;
    this.sweepTimer = null;
    /** @type {Map<string, NodeJS.Timeout>} anti-rebond / nouvel essai, par serveur */
    this.timers = new Map();
    /** @type {Map<string, Promise<object>>} mise à jour en cours, par serveur */
    this.running = new Map();
    /** @type {Set<string>} serveurs avec une création / suppression en cours */
    this.busy = new Set();
    /** @type {Map<string, number>} dernière lecture complète des membres */
    this.memberFetchAt = new Map();
    /** @type {Map<string, string>} salon → problème détecté (« noperm ») */
    this.problems = new Map();
    /** @type {Map<string, Promise<unknown>>} renommages bloqués par la limite de Discord, par salon */
    this.stalled = new Map();
    this.renameTimeoutMs = RENAME_TIMEOUT_MS;
    this.stopping = false;
  }

  cfg(guildId) {
    return this.config.get(guildId).statsCounters ?? { categoryId: null, counters: {} };
  }

  counter(guildId, type) {
    return this.cfg(guildId).counters?.[type] ?? { enabled: false, channelId: null, template: null, renamedAt: 0 };
  }

  templateOf(guildId, type) {
    return this.counter(guildId, type).template || COUNTER_TYPES[type].template;
  }

  /** Compteurs actifs (activés avec un salon). */
  active(guildId) {
    return COUNTER_KEYS.filter((k) => {
      const c = this.counter(guildId, k);
      return c.enabled && c.channelId;
    });
  }

  // ---------------------------------------------------------------- permissions

  /** Permissions serveur manquantes pour créer les salons. @returns {string[]} libellés */
  missingGuildPermissions(guild) {
    const me = guild.members?.me;
    return [
      [P.ManageChannels, 'Gérer les salons'],
      [P.ManageRoles, 'Gérer les rôles (permissions des salons)'],
      [P.Connect, 'Se connecter'],
    ].filter(([flag]) => !me?.permissions?.has?.(flag)).map(([, label]) => label);
  }

  /** Le bot peut-il renommer ce salon ? */
  canManage(channel) {
    const me = channel?.guild?.members?.me;
    if (!me || !channel.permissionsFor) return false;
    try {
      return channel.permissionsFor(me)?.has(CHANNEL_PERMS) === true;
    } catch {
      return false;
    }
  }

  /** Permissions des salons : Connect refusé à @everyone, le bot garde la main. */
  #overwrites(guild) {
    return [
      { id: guild.id, deny: [P.Connect] },
      { id: guild.members.me.id, allow: CHANNEL_PERMS },
    ];
  }

  // ---------------------------------------------------------------- planification

  /** Démarre le passage périodique (minuteur unref). */
  start() {
    if (this.sweepTimer) return;
    this.stopping = false;
    this.sweepTimer = setInterval(() => this.sweep().catch((e) => logger.warn('Passage des compteurs :', e?.message)), this.sweepMs);
    this.sweepTimer.unref?.();
  }

  /** Arrête minuteurs et passage périodique ; attend (≤ 3 s) les renommages en cours. */
  async stop() {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const inflight = [...this.running.values()];
    if (inflight.length) await Promise.race([Promise.allSettled(inflight), new Promise((r) => setTimeout(r, 3_000).unref?.())]);
  }

  /** Mise à jour de tous les serveurs ayant des compteurs actifs. */
  async sweep() {
    for (const guild of this.client.guilds.cache.values()) {
      if (this.stopping) return;
      if (!guild.available || !this.active(guild.id).length) continue;
      await this.update(guild).catch((e) => logger.debug(`Compteurs ${guild.id} :`, e?.message));
    }
  }

  /**
   * Programme une mise à jour (anti-rebond) : un seul minuteur par serveur, le premier
   * programmé l'emporte (une rafale d'arrivées ne repousse pas indéfiniment la mise à jour).
   */
  schedule(guildId, delay = this.debounceMs) {
    if (this.stopping || this.timers.has(guildId) || !this.active(guildId).length) return false;
    const timer = setTimeout(() => {
      this.timers.delete(guildId);
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) this.update(guild).catch((e) => logger.debug(`Compteurs ${guildId} :`, e?.message));
    }, Math.max(0, delay));
    timer.unref?.();
    this.timers.set(guildId, timer);
    return true;
  }

  /** Mise à jour d'un serveur (une seule à la fois ; un appel concurrent attend la même). */
  update(guild) {
    const current = this.running.get(guild.id);
    if (current) return current;
    const run = this.#update(guild).finally(() => this.running.delete(guild.id));
    this.running.set(guild.id, run);
    return run;
  }

  async #update(guild, now = Date.now()) {
    const summary = { renamed: [], unchanged: [], waiting: [], noperm: [], removed: [] };
    const types = this.active(guild.id);
    if (!types.length || this.stopping) return summary;
    if (types.some((t) => t === 'humans' || t === 'bots')) await this.#ensureMembers(guild, now);
    const values = computeValues(guild);
    let retryAt = Infinity;
    for (const type of types) {
      if (this.stopping) break;
      const c = this.counter(guild.id, type);
      const channel = guild.channels.cache.get(c.channelId);
      if (!channel) {
        this.forgetChannel(guild.id, c.channelId);
        summary.removed.push(type);
        continue;
      }
      const name = renderName(this.templateOf(guild.id, type), values[type]);
      if (channel.name === name) {
        summary.unchanged.push(type);
        continue;
      }
      if (!this.canManage(channel)) {
        this.problems.set(channel.id, 'noperm');
        summary.noperm.push(type);
        continue;
      }
      const nextAt = (c.renamedAt || 0) + RENAME_WINDOW_MS;
      // Renommage précédent encore bloqué par la limite de Discord : jamais empilé.
      if (nextAt > now || this.stalled.has(channel.id)) {
        retryAt = Math.min(retryAt, Math.max(nextAt, now + RENAME_WINDOW_MS / 10));
        summary.waiting.push(type);
        continue;
      }
      // Enregistré AVANT l'appel : un échec ou un redémarrage ne permet pas de dépasser la limite.
      this.config.update(guild.id, { statsCounters: { counters: { [type]: { renamedAt: now } } } });
      const rename = Promise.resolve().then(() => channel.setName(name, 'Compteur de statistiques'));
      const outcome = await settleWithin(rename, this.renameTimeoutMs);
      if (outcome.timedOut) {
        // Limite atteinte (discord.js attend la fin de la fenêtre) : on n'attend pas avec lui.
        this.stalled.set(channel.id, rename);
        rename.catch(() => {}).finally(() => this.stalled.delete(channel.id));
        retryAt = Math.min(retryAt, now + RENAME_WINDOW_MS);
        summary.waiting.push(type);
        continue;
      }
      const err = outcome.error;
      if (!err) {
        this.problems.delete(channel.id);
        summary.renamed.push(type);
      } else if (err?.code === 10003) {
        this.forgetChannel(guild.id, channel.id);
        summary.removed.push(type);
      } else if (err?.code === 50013 || err?.code === 50001) {
        this.problems.set(channel.id, 'noperm');
        summary.noperm.push(type);
      } else logger.debug(`Renommage du compteur ${type} (${guild.id}) :`, err?.message);
    }
    // Valeur changée mais fenêtre de renommage non écoulée : nouvel essai à son ouverture.
    if (Number.isFinite(retryAt)) this.schedule(guild.id, retryAt - now + 1_000);
    return summary;
  }

  /** Charge la liste complète des membres si le cache est incomplet (au plus toutes les 10 min). */
  async #ensureMembers(guild, now) {
    if ((guild.members.cache.size ?? 0) >= (guild.memberCount ?? 0)) return;
    if (now - (this.memberFetchAt.get(guild.id) ?? 0) < MEMBER_FETCH_INTERVAL_MS) return;
    this.memberFetchAt.set(guild.id, now);
    await guild.members.fetch({ time: 15_000 }).catch((e) => logger.debug(`Liste des membres de ${guild.id} :`, e?.message));
  }

  /** Prochain renommage possible d'un compteur (timestamp ms, 0 = maintenant). */
  nextRenameAt(guildId, type) {
    const at = (this.counter(guildId, type).renamedAt || 0) + RENAME_WINDOW_MS;
    return at > Date.now() ? at : 0;
  }

  // ---------------------------------------------------------------- configuration

  /** Salon supprimé à la main (ou introuvable) : retiré de la configuration. @returns {boolean} */
  forgetChannel(guildId, channelId) {
    if (!channelId) return false;
    const cfg = this.cfg(guildId);
    const patch = {};
    for (const k of COUNTER_KEYS) {
      if (cfg.counters?.[k]?.channelId === channelId) patch[k] = { enabled: false, channelId: null };
    }
    const isCategory = cfg.categoryId === channelId;
    if (!Object.keys(patch).length && !isCategory) return false;
    this.problems.delete(channelId);
    this.config.update(guildId, { statsCounters: { ...(isCategory ? { categoryId: null } : {}), ...(Object.keys(patch).length ? { counters: patch } : {}) } });
    logger.info(`Compteur(s) retiré(s) de la configuration de ${guildId} : salon ${channelId} supprimé.`);
    return true;
  }

  /** Exécute `fn` en empêchant deux créations/suppressions simultanées sur un serveur. */
  async #exclusive(guildId, fn) {
    if (this.busy.has(guildId)) throw new UserError('Une opération sur les compteurs est déjà en cours. Patientez quelques secondes.');
    this.busy.add(guildId);
    try {
      return await fn();
    } finally {
      this.busy.delete(guildId);
    }
  }

  #assertCanCreate(guild) {
    const missing = this.missingGuildPermissions(guild);
    if (missing.length) throw new UserError(`Il me manque : ${missing.map((l) => `**${l}**`).join(', ')}.`);
  }

  async #ensureCategory(guild, reason) {
    const cfg = this.cfg(guild.id);
    const existing = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
    if (existing?.type === ChannelType.GuildCategory) return existing;
    const category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      position: 0,
      permissionOverwrites: this.#overwrites(guild),
      reason,
    });
    this.config.update(guild.id, { statsCounters: { categoryId: category.id } });
    return category;
  }

  async #createChannel(guild, category, type, reason) {
    const values = computeValues(guild);
    const channel = await guild.channels.create({
      name: renderName(this.templateOf(guild.id, type), values[type]),
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: this.#overwrites(guild),
      reason,
    });
    this.config.update(guild.id, { statsCounters: { counters: { [type]: { enabled: true, channelId: channel.id } } } });
    return channel;
  }

  /**
   * Crée la catégorie « 📊 Statistiques » et les salons des compteurs demandés
   * (réutilise ceux qui existent déjà). Chaque salon est enregistré aussitôt créé.
   * @returns {Promise<{ category: object, created: string[], reused: string[] }>}
   */
  async create(guild, types, reason = 'Compteurs de statistiques') {
    return this.#exclusive(guild.id, async () => {
      this.#assertCanCreate(guild);
      const wanted = availableTypes(this.client).filter((t) => types.includes(t));
      if (!wanted.length) throw new UserError('Aucun compteur à créer.');
      if (types.includes('humans') || types.includes('bots')) await this.#ensureMembers(guild, Date.now());
      const category = await this.#ensureCategory(guild, reason);
      const created = [];
      const reused = [];
      for (const type of wanted) {
        const c = this.counter(guild.id, type);
        if (c.channelId && guild.channels.cache.has(c.channelId)) {
          if (!c.enabled) this.config.update(guild.id, { statsCounters: { counters: { [type]: { enabled: true } } } });
          reused.push(type);
          continue;
        }
        await this.#createChannel(guild, category, type, reason);
        created.push(type);
      }
      return { category, created, reused };
    });
  }

  /** Désactive un compteur : son salon est supprimé, son modèle est conservé. */
  async disable(guild, type, reason = 'Compteur de statistiques désactivé') {
    return this.#exclusive(guild.id, async () => {
      const c = this.counter(guild.id, type);
      const channel = c.channelId ? guild.channels.cache.get(c.channelId) : null;
      if (channel) {
        try {
          await channel.delete(reason);
        } catch (err) {
          if (err?.code !== 10003) throw new UserError('Je ne peux pas supprimer ce salon : vérifiez ma permission **Gérer les salons**.');
        }
      }
      this.problems.delete(c.channelId);
      this.config.update(guild.id, { statsCounters: { counters: { [type]: { enabled: false, channelId: null } } } });
      return Boolean(channel);
    });
  }

  /**
   * Supprime tous les salons compteurs et la catégorie (si elle est vide), puis remet
   * la configuration à zéro. Un salon impossible à supprimer reste configuré.
   * @returns {Promise<{ removed: number, failed: string[] }>}
   */
  async removeAll(guild, reason = 'Compteurs de statistiques supprimés') {
    return this.#exclusive(guild.id, async () => {
      const cfg = this.cfg(guild.id);
      let removed = 0;
      const failed = [];
      const patch = {};
      for (const k of COUNTER_KEYS) {
        const id = cfg.counters?.[k]?.channelId;
        const channel = id ? guild.channels.cache.get(id) : null;
        if (channel && (await channel.delete(reason).then(() => true, (e) => e?.code === 10003))) removed += 1;
        else if (channel) {
          failed.push(k); // échec (permission) : le compteur reste configuré
          continue;
        }
        this.problems.delete(id);
        patch[k] = { enabled: false, channelId: null, template: null, renamedAt: 0 };
      }
      const category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
      let categoryId = cfg.categoryId;
      if (!category) categoryId = null;
      else if (!guild.channels.cache.some((c) => c.parentId === category.id)) {
        if (await category.delete(reason).then(() => true, (e) => e?.code === 10003)) categoryId = null;
      }
      this.config.update(guild.id, { statsCounters: { categoryId, counters: patch } });
      return { removed, failed };
    });
  }

  /** Change le modèle d'un compteur (null = modèle par défaut). @returns {string} modèle effectif */
  setTemplate(guildId, type, template) {
    const value = template == null ? null : validateTemplate(template);
    this.config.update(guildId, { statsCounters: { counters: { [type]: { template: value } } } });
    return value ?? COUNTER_TYPES[type].template;
  }
}

module.exports = {
  StatsCounterService,
  COUNTER_TYPES,
  COUNTER_KEYS,
  RENAME_WINDOW_MS,
  RENAME_TIMEOUT_MS,
  CATEGORY_NAME,
  availableTypes,
  hasPresenceIntent,
  renderName,
  validateTemplate,
  computeValues,
  formatCount,
};
