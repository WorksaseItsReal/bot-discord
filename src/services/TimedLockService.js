'use strict';

const { createLogger } = require('../core/logger');
const { discordTimestamp, formatDuration, MAX_DURATION_MS } = require('../utils/time');
const { field, ICONS, code } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { logCard } = require('./LoggingService');
const { normalizeLock, SCOPES } = require('./LockdownService');
const { UserError } = require('../core/errors');

const logger = createLogger('timedlocks');

/** Durée minimale d'une levée programmée. */
const MIN_TIMED_MS = 60_000;
/** Au-delà de ce retard, une levée impossible (permission, hiérarchie) est abandonnée et signalée. */
const MAX_LATE_MS = 86_400_000;
/** Salon inconnu / accès perdu : la levée ne pourra jamais aboutir. */
const GONE_CODES = new Set([10003, 50001]);
/** Attente avant un nouvel essai après un échec : 1 minute, doublée à chaque échec, 1 heure au plus. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;

/** Libellés des sortes d'actions temporaires. */
const KIND_LABELS = { lock: 'Verrouillage', slowmode: 'Mode lent', lockdown: 'Lockdown' };
const KIND_ARTICLES = { lock: 'le verrouillage', slowmode: 'le mode lent', lockdown: 'le lockdown' };

/**
 * Durée d'une action temporaire saisie (« 30m », « 2h », « 1d ») : 1 minute à 1 an.
 * @returns {number} millisecondes
 */
function timedDuration(raw, parseDuration) {
  const ms = parseDuration(raw);
  if (!ms) throw new UserError('Durée invalide : utilisez par exemple `30m`, `2h` ou `1d` (un an maximum).');
  if (ms < MIN_TIMED_MS) throw new UserError('Durée minimale : **1 minute**.');
  if (ms > MAX_DURATION_MS) throw new UserError('Durée maximale : **un an**.');
  return ms;
}

/**
 * Levée automatique des verrouillages (/lock duree), modes lents (/slowmode pendant) et
 * lockdowns (/lockdown enable duree) : étape `timedlocks` du SchedulerService. Chaque
 * ligne est RELUE avant d'agir, et l'état réel du salon est vérifié : un salon déjà
 * déverrouillé, ou dont le mode lent a été changé à la main, n'est pas touché.
 */
class TimedLockService {
  /**
   * @param {{ client: import('discord.js').Client, timed: import('../database/repositories/TimedActionRepository').TimedActionRepository }} deps
   */
  constructor({ client, timed }) {
    this.client = client;
    this.repo = timed;
    /**
     * Prochain essai d'une levée en échec (permission perdue, erreur passagère) : attente
     * croissante (1 min → 1 h) pour ne pas répéter un appel voué à l'échec à chaque passage.
     * @type {Map<number, { at: number, attempts: number }>}
     */
    this.retries = new Map();
  }

  get lockdown() {
    return this.client.services?.lockdown ?? null;
  }

  /**
   * Programme la levée d'une action (remplace une levée déjà programmée pour la même cible).
   * @param {{ guildId: string, channelId: string, kind: 'lock'|'slowmode'|'lockdown', durationMs: number, moderatorId?: string|null, data?: object, now?: number }} opts
   * @returns {number} échéance (ms)
   */
  schedule({ guildId, channelId, kind, durationMs, moderatorId = null, data = {}, now = Date.now() }) {
    const expiresAt = now + durationMs;
    this.repo.schedule({ guildId, channelId, kind, data, moderatorId, expiresAt, now });
    return expiresAt;
  }

  /** Annule la levée programmée d'une cible. @returns {boolean} */
  cancel(guildId, kind, channelId, reason = 'cancelled') {
    try {
      return this.repo.cancel(guildId, kind, channelId, reason);
    } catch (e) {
      logger.debug('Annulation d\'une levée programmée :', e?.message);
      return false;
    }
  }

  /** Levée programmée en cours pour une cible (ou null). */
  activeFor(guildId, kind, channelId) {
    return this.repo.activeFor(guildId, kind, channelId);
  }

  /**
   * Étape du scheduler : lève les actions arrivées à échéance.
   * @param {{ isStopping?: () => boolean, now?: number }} [opts]
   */
  async processDue({ isStopping = () => false, now = Date.now() } = {}) {
    // Réessais d'une ligne close entre-temps (/unlock, nouveau mode lent…) : oubliés.
    for (const id of this.retries.keys()) if (!this.repo.byId(id)?.active) this.retries.delete(id);
    // Lignes en attente d'un nouvel essai écartées de la requête : elles ne monopolisent
    // jamais les 200 places d'un passage (les autres levées échues passent quand même).
    const waiting = [...this.retries].filter(([, r]) => r.at > Date.now()).map(([id]) => id);
    for (const row of this.repo.findDue(now, { exclude: waiting })) {
      if (isStopping()) return;
      if ((this.retries.get(row.id)?.at ?? 0) > Date.now()) continue;
      try {
        await this.#expire(row);
        if (this.retries.has(row.id) && !this.repo.byId(row.id)?.active) this.retries.delete(row.id);
      } catch (e) {
        logger.warn(`Levée automatique #${row.id} (${row.kind}, serveur ${row.guild_id}) en échec, réessai :`, e?.message ?? e);
      }
    }
  }

  /** Ligne relue en base : toujours active et échue ? */
  #stillDue(row) {
    const fresh = this.repo.byId(row.id);
    return fresh?.active && fresh.expires_at <= Date.now() ? fresh : null;
  }

  async #expire(row) {
    const guild = this.client.guilds.cache.get(row.guild_id);
    if (!guild) {
      // Client prêt et serveur absent : le bot l'a quitté, plus rien à lever.
      if (this.client.isReady?.()) this.repo.close(row.id, 'gone');
      return;
    }
    if (!guild.available) return;
    if (!this.#stillDue(row)) return;
    if (row.kind === 'lockdown') return this.#expireLockdown(guild, row);
    const channel = await this.#channel(guild, row.channel_id);
    if (!channel) {
      this.repo.close(row.id, 'gone');
      return;
    }
    if (row.kind === 'lock') return this.#expireLock(guild, channel, row);
    if (row.kind === 'slowmode') return this.#expireSlowmode(guild, channel, row);
    this.repo.close(row.id, 'failed');
  }

  async #channel(guild, id) {
    const cached = guild.channels.cache.get(id);
    if (cached) return cached;
    try {
      const ch = await this.client.channels.fetch(id);
      return ch?.guildId === guild.id ? ch : null;
    } catch (e) {
      if (GONE_CODES.has(e?.code)) return null;
      throw e;
    }
  }

  async #expireLock(guild, channel, row) {
    const lockdown = this.lockdown;
    if (!lockdown) return;
    // Verrouillage ou levée globale en cours : l'état des salons bouge, prochain passage.
    if (lockdown.isBusy?.(guild.id)) return;
    const saved = lockdown.locks?.get(guild.id, channel.id);
    // Déjà déverrouillé (à la main, hors du bot…) : rien à restaurer.
    if (!saved) {
      this.repo.close(row.id, 'changed');
      return;
    }
    // Lockdown en cours : le salon reste verrouillé et sera restauré avec le lockdown.
    if (lockdown.status(guild) > 0) {
      const state = normalizeLock(saved.data);
      lockdown.locks.save(guild.id, channel.id, { v: 2, scope: SCOPES.lockdown, perms: state.perms });
      this.repo.close(row.id, 'lockdown');
      await this.#log(guild, row, channel, `La durée du verrouillage de ${channel} est écoulée, mais un **lockdown** est en cours : le salon sera déverrouillé avec lui.`);
      return;
    }
    if (!this.#stillDue(row)) return;
    let unlocked;
    try {
      // Conditions relues APRÈS les opérations en cours sur ce salon (/lock, /unlock simultanés) :
      // un verrouillage posé entre-temps a remplacé la levée programmée, il n'est pas levé.
      unlocked = await lockdown.unlockChannel(channel, 'Fin du verrouillage temporaire', {
        timerReason: 'expired',
        onlyIf: () => Boolean(this.#stillDue(row)) && !lockdown.isBusy?.(guild.id) && Boolean(lockdown.locks.get(guild.id, channel.id)) && lockdown.status(guild) === 0,
      });
    } catch (e) {
      await this.#failed(guild, row, channel, e);
      return;
    }
    if (unlocked === false) return; // relu : remplacé, levé ou lockdown en cours (prochain passage)
    this.repo.close(row.id, 'expired');
    logger.info(`Verrouillage temporaire #${row.id} levé : guild=${guild.id} salon=${channel.id}`);
    await this.#log(guild, row, channel, `${channel} est déverrouillé : la durée du verrouillage est écoulée.`);
  }

  async #expireSlowmode(guild, channel, row) {
    const applied = Number(row.data?.applied ?? -1);
    const previous = Math.max(0, Number(row.data?.previous ?? 0) || 0);
    // Mode lent changé depuis (autre valeur, désactivé) : la décision manuelle prime.
    if (typeof channel.setRateLimitPerUser !== 'function' || (channel.rateLimitPerUser ?? 0) !== applied) {
      this.repo.close(row.id, 'changed');
      return;
    }
    if (!this.#stillDue(row)) return;
    try {
      await channel.setRateLimitPerUser(previous, 'Fin du mode lent temporaire');
    } catch (e) {
      await this.#failed(guild, row, channel, e);
      return;
    }
    this.repo.close(row.id, 'expired');
    await this.#log(guild, row, channel, previous
      ? `Le mode lent de ${channel} revient à **${formatDuration(previous * 1000)}** : la durée est écoulée.`
      : `Le mode lent de ${channel} est désactivé : la durée est écoulée.`);
  }

  async #expireLockdown(guild, row) {
    const lockdown = this.lockdown;
    if (!lockdown) return;
    if (lockdown.isBusy?.(guild.id)) return; // verrouillage ou levée en cours : prochain passage
    // Déjà levé (à la main, /unlockall…) : rien à faire.
    if (lockdown.status(guild) === 0) {
      this.repo.close(row.id, 'changed');
      return;
    }
    if (!this.#stillDue(row)) return;
    // disable() clôt la ligne (« expired ») et publie la carte « Lockdown levé » (sécurité).
    await lockdown.disable(guild, this.client.user, { reason: 'Levée automatique : la durée du lockdown est écoulée', timerReason: 'expired' });
    this.repo.close(row.id, 'expired');
    logger.info(`Lockdown temporaire #${row.id} levé : guild=${guild.id}`);
  }

  /** Échec : réessai au prochain passage, abandon signalé après 24 h (ou tout de suite si le salon est perdu). */
  async #failed(guild, row, channel, error) {
    const late = Date.now() - row.expires_at;
    if (!GONE_CODES.has(error?.code) && late <= MAX_LATE_MS) {
      const attempts = (this.retries.get(row.id)?.attempts ?? 0) + 1;
      this.retries.set(row.id, { at: Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)), attempts });
      logger.debug(`Levée automatique #${row.id} échouée (essai ${attempts}, nouvel essai plus tard) :`, error?.message);
      return;
    }
    this.retries.delete(row.id);
    if (!this.repo.close(row.id, 'failed')) return;
    await this.#log(guild, row, channel, `Je n'ai pas pu lever automatiquement ${KIND_ARTICLES[row.kind] ?? 'l\'action'} de ${channel} (${truncate(error?.message ?? 'erreur Discord', 200)}). Faites-le à la main.`, { warning: true });
  }

  /** Log « Sécurité · Levées automatiques ». */
  async #log(guild, row, channel, description, { warning = false } = {}) {
    const logging = this.client.services?.logging;
    if (!logging) return;
    const embed = logCard({
      category: 'security',
      tone: warning ? 'warning' : 'success',
      icon: warning ? ICONS.warning : row.kind === 'slowmode' ? '🐇' : ICONS.unlock,
      title: warning ? 'Levée automatique impossible' : `${KIND_LABELS[row.kind] ?? 'Action'} levé automatiquement`,
      description,
      fields: [
        channel ? field(ICONS.channel, 'Salon', `${channel}`) : null,
        row.moderator_id ? field(ICONS.moderator, 'Posé par', `<@${row.moderator_id}>`) : null,
        field(ICONS.date, 'Posé', discordTimestamp(row.created_at, 'R')),
        field(ICONS.id, 'Référence', code(`#${row.id}`)),
      ],
    });
    await logging.send(guild.id, 'security', embed, undefined, { event: 'timedLift' }).catch(() => {});
  }
}

module.exports = { TimedLockService, timedDuration, KIND_LABELS, MIN_TIMED_MS };
