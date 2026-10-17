'use strict';

const { createLogger } = require('../../core/logger');

const logger = createLogger('secur:undo');

/** Tâches d'annulation en attente par serveur ; au-delà, l'incident demande /backup. */
const MAX_UNDO_TASKS = 500;
/** Arrêt du bot : la tâche en cours est attendue au plus 2 s. */
const STOP_WAIT_MS = 2_000;
/** Nouvel essai quand la file est en pause (restauration /backup en cours). */
const PAUSE_RETRY_MS = 2_000;
/** Disjoncteur : 3 annulations du même objet en 60 s suspendent le module 5 min sur ce serveur. */
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_SUSPEND_MS = 5 * 60_000;
const BREAKER_MAX_KEYS = 1_000;

/**
 * File d'annulation d'UN serveur : séquentielle, à priorités (1 rôles, 2 catégories, 3 salons,
 * 4 surcharges, 5 membres et références ; ordre d'arrivée à priorité égale), 500 tâches au plus,
 * en pause tant que `isPaused()` (restauration /backup). Une tâche est `{ priority, module,
 * targetKey, incidentId, run }` ; `run()` relit l'état et s'abstient s'il a changé (module.undo).
 */
class UndoQueue {
  /**
   * @param {{ isPaused?: () => boolean, execute: (task: object) => Promise<void>, maxTasks?: number, pauseRetryMs?: number }} opts
   *   execute : exécute une tâche (disjoncteur et comptes de l'incident compris) ; ne doit pas lever
   */
  constructor({ isPaused = () => false, execute, maxTasks = MAX_UNDO_TASKS, pauseRetryMs = PAUSE_RETRY_MS }) {
    this.isPaused = isPaused;
    this.execute = execute;
    this.maxTasks = maxTasks;
    this.pauseRetryMs = pauseRetryMs;
    /** @type {object[][]} files par priorité (index 0 → priorité 1) */
    this.lanes = [[], [], [], [], []];
    this.size = 0;
    this.running = null;
    this.timer = null;
    this.stopped = false;
  }

  /** Ajoute une tâche. @returns {boolean} false si la file est pleine (ou arrêtée) */
  push(task) {
    if (this.stopped || this.size >= this.maxTasks) return false;
    const p = Number.isInteger(task.priority) && task.priority >= 1 && task.priority <= 5 ? task.priority : 5;
    this.lanes[p - 1].push(task);
    this.size += 1;
    this.#kick();
    return true;
  }

  /** Retire les tâches d'un module (disjoncteur). @returns {object[]} tâches retirées */
  clearModule(moduleKey) {
    const removed = [];
    this.lanes = this.lanes.map((lane) => lane.filter((t) => (t.module === moduleKey ? (removed.push(t), false) : true)));
    this.size -= removed.length;
    return removed;
  }

  /** true si une tâche est en cours ou en attente. */
  get busy() {
    return Boolean(this.running) || this.size > 0;
  }

  #next() {
    for (const lane of this.lanes) {
      if (lane.length) {
        this.size -= 1;
        return lane.shift();
      }
    }
    return null;
  }

  #kick() {
    if (this.running || this.stopped) return;
    this.running = this.#drain().finally(() => {
      this.running = null;
    });
  }

  async #drain() {
    while (!this.stopped && this.size > 0) {
      if (this.isPaused()) {
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.#kick();
          }, this.pauseRetryMs);
          this.timer.unref?.();
        }
        return;
      }
      const task = this.#next();
      if (!task) return;
      try {
        await this.execute(task);
      } catch (e) {
        logger.debug('Tâche d\'annulation en échec :', e?.message);
      }
    }
  }

  /** Arrêt : plus aucune tâche ; la tâche en cours est attendue STOP_WAIT_MS au plus. */
  async stop(waitMs = STOP_WAIT_MS) {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const dropped = this.lanes.flat();
    this.lanes = [[], [], [], [], []];
    this.size = 0;
    if (this.running) {
      let t;
      await Promise.race([this.running.catch(() => {}), new Promise((r) => { t = setTimeout(r, waitMs); t.unref?.(); })]);
      clearTimeout(t);
    }
    return dropped;
  }
}

/**
 * Disjoncteur anti-boucle entre bots (critique §4.8) : un même objet annulé 3 fois en 60 s →
 * module suspendu 5 min sur ce serveur (en mémoire). Clés bornées (1 000).
 */
class UndoBreaker {
  constructor({ windowMs = BREAKER_WINDOW_MS, threshold = BREAKER_THRESHOLD, suspendMs = BREAKER_SUSPEND_MS, maxKeys = BREAKER_MAX_KEYS, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.suspendMs = suspendMs;
    this.maxKeys = maxKeys;
    this.now = now;
    /** @type {Map<string, number[]>} `${guild}:${module}:${target}` → tentatives */
    this.attempts = new Map();
    /** @type {Map<string, number>} `${guild}:${module}` → fin de suspension */
    this.suspended = new Map();
  }

  /** Fin de suspension du module (0 : actif). */
  suspendedUntil(guildId, moduleKey) {
    const key = `${guildId}:${moduleKey}`;
    const until = this.suspended.get(key) ?? 0;
    if (until && until <= this.now()) {
      this.suspended.delete(key);
      return 0;
    }
    return until;
  }

  isSuspended(guildId, moduleKey) {
    return this.suspendedUntil(guildId, moduleKey) > 0;
  }

  /**
   * Note une tentative d'annulation. @returns {boolean} true si elle déclenche le disjoncteur
   * (le module est alors suspendu).
   */
  note(guildId, moduleKey, targetKey) {
    if (targetKey == null || targetKey === '') return false;
    const now = this.now();
    const key = `${guildId}:${moduleKey}:${targetKey}`;
    const list = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.attempts.delete(key);
    this.attempts.set(key, list);
    while (this.attempts.size > this.maxKeys) this.attempts.delete(this.attempts.keys().next().value);
    if (list.length < this.threshold) return false;
    this.attempts.delete(key);
    this.suspended.set(`${guildId}:${moduleKey}`, now + this.suspendMs);
    while (this.suspended.size > this.maxKeys) this.suspended.delete(this.suspended.keys().next().value);
    return true;
  }

  /** Purge des tentatives expirées et des suspensions terminées. */
  prune() {
    const now = this.now();
    for (const [key, list] of this.attempts) if (!list.some((t) => now - t < this.windowMs)) this.attempts.delete(key);
    for (const [key, until] of this.suspended) if (until <= now) this.suspended.delete(key);
  }

  forgetGuild(guildId) {
    for (const map of [this.attempts, this.suspended]) for (const key of map.keys()) if (key.startsWith(`${guildId}:`)) map.delete(key);
  }
}

module.exports = { UndoQueue, UndoBreaker, MAX_UNDO_TASKS, BREAKER_THRESHOLD, BREAKER_WINDOW_MS, BREAKER_SUSPEND_MS, STOP_WAIT_MS };
