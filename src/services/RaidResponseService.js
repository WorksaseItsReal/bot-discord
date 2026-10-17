'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');
const { discordTimestamp } = require('../utils/time');

const logger = createLogger('raidResponse');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Discord accepte une échéance d'au plus 24 h : on vise 24 h − 1 min au plus. */
const MAX_PAUSE_MS = 24 * HOUR - MINUTE;
/** Durées proposées (heures). */
const PAUSE_HOURS = Object.freeze([1, 3, 6, 12, 24]);
const DEFAULT_HOURS = 6;
/** Riposte de vague : au plus UNE pause par serveur toutes les 10 min (la fenêtre AntiRaid se réarme). */
const WAVE_COOLDOWN_MS = 10 * MINUTE;
const MAX_TRACKED = 1_000;

const MISSING_PERMISSION = 'Il me manque la permission **Gérer le serveur** : je ne peux pas suspendre ni rétablir les invitations et les messages privés.';

/** Durée valide en heures (sinon 6 h). Pur. */
function normalizeHours(hours) {
  const n = Number(hours);
  return PAUSE_HOURS.includes(n) ? n : DEFAULT_HOURS;
}

/** Échéance d'une pause de `hours` heures : plafonnée à maintenant + 24 h − 1 min. Pur. */
function pauseUntil(now, hours) {
  return now + Math.min(normalizeHours(hours) * HOUR, MAX_PAUSE_MS);
}

/** Instant (ms) d'une échéance encore à venir, sinon null. Pur. */
function future(date, now) {
  const t = date instanceof Date ? date.getTime() : date == null ? NaN : new Date(date).getTime();
  return Number.isFinite(t) && t > now ? t : null;
}

/** Traduit une erreur de Discord en UserError lisible. Pur. */
function translateError(err) {
  if (err?.isUserError) return err;
  if (err?.code === 50013 || err?.code === 50001 || err?.status === 403) return new UserError(MISSING_PERMISSION);
  if (err?.code === 50035 || err?.status === 400) return new UserError('Discord a refusé ces échéances (elles doivent être dans le futur, 24 h au plus).');
  if (err?.code === 10004) return new UserError('Ce serveur est introuvable pour Discord.');
  return new UserError('Discord n\'a pas pu appliquer la mesure pour le moment. Réessayez dans un instant.');
}

/** Texte court d'un état (champ « Invitations » des alertes, cartes). Pur. */
function describeState({ invitesDisabledUntil = null, dmsDisabledUntil = null } = {}, now = Date.now()) {
  const parts = [];
  const inv = future(invitesDisabledUntil, now);
  const dms = future(dmsDisabledUntil, now);
  if (inv) parts.push(`Invitations suspendues jusqu'à ${discordTimestamp(inv, 't')} (${discordTimestamp(inv, 'R')})`);
  if (dms) parts.push(`MP suspendus jusqu'à ${discordTimestamp(dms, 't')} (${discordTimestamp(dms, 'R')})`);
  return parts.join('\n') || 'Invitations et MP actifs.';
}

/**
 * Riposte native de Discord (SEC3) : suspension des invitations et des MP entre membres par
 * l'API incident-actions (Guild#setIncidentActions), au lieu d'expulser des raiders par vagues.
 *  - pause : échéance plafonnée à maintenant + 24 h − 1 min, JAMAIS raccourcie ;
 *  - resume : échéances remises à null ;
 *  - status : guild.fetch() puis incidentsData ;
 *  - onWave : appelé par l'AntiRaid (vague d'arrivées), seulement si raidResponse.onWave, au plus
 *    une pause par serveur toutes les 10 min, jamais renouvelée au-delà de 24 h : une SÉRIE de
 *    ripostes (vagues successives tant que la pause précédente court) est plafonnée à son début
 *    + 24 h − 1 min ; une nouvelle série ne démarre qu'après l'expiration de la précédente.
 * Les deux échéances sont toujours envoyées (celle qui ne change pas garde sa valeur actuelle).
 * Verrou par serveur : les appels d'un même serveur s'enchaînent. Aucun minuteur.
 */
class RaidResponseService {
  /** @param {{ client: object, config: object, logging?: object, now?: () => number }} deps */
  constructor({ client, config, logging = null, now = () => Date.now() }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    this.now = now;
    /** @type {Map<string, Promise<unknown>>} dernier appel en cours par serveur (verrou) */
    this.locks = new Map();
    /** @type {Map<string, { at: number, since: number, until: number, text: string }>} dernière riposte de vague par serveur (since : début de la série) */
    this.waves = new Map();
  }

  /** Les appels d'un même serveur s'exécutent l'un après l'autre. */
  async #withLock(guildId, fn) {
    const previous = this.locks.get(guildId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(guildId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(guildId) === tail) this.locks.delete(guildId);
    }
  }

  /** Lève l'UserError « Gérer le serveur » si le bot ne l'a pas (aucune requête vouée au 403). */
  assertCanManage(guild) {
    const me = guild?.members?.me;
    if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageGuild)) throw new UserError(MISSING_PERMISSION);
  }

  /** État actuel lu chez Discord (repli sur le cache si la lecture échoue). */
  async #incidents(guild) {
    try {
      const fresh = await guild.fetch();
      return fresh?.incidentsData ?? guild.incidentsData ?? null;
    } catch (err) {
      logger.debug('Lecture des incidents :', err?.message);
      return guild.incidentsData ?? null;
    }
  }

  async #put(guild, invitesDisabledUntil, dmsDisabledUntil) {
    try {
      return await guild.setIncidentActions({ invitesDisabledUntil, dmsDisabledUntil });
    } catch (err) {
      throw translateError(err);
    }
  }

  /**
   * Suspend les invitations et/ou les MP pendant `hours` heures (1, 3, 6, 12 ou 24).
   * Une échéance déjà plus lointaine est conservée (jamais raccourcie). `notAfter` (riposte de
   * vague) : échéance visée plafonnée à cet instant ; rien à prolonger (plafond à moins d'une
   * minute ou déjà atteint) : aucun appel.
   * @returns {Promise<{ invitesDisabledUntil: number|null, dmsDisabledUntil: number|null, previous: { invites: number|null, dms: number|null } }>}
   */
  async pause(guild, { invites = true, dms = false, hours = DEFAULT_HOURS, actorId = null, reason = null, notAfter = Infinity } = {}) {
    if (!invites && !dms) throw new UserError('Choisissez au moins les invitations ou les messages privés.');
    this.assertCanManage(guild);
    return this.#withLock(guild.id, async () => {
      const now = this.now();
      const current = await this.#incidents(guild);
      const capped = Math.min(pauseUntil(now, hours), notAfter);
      const target = capped > now + MINUTE ? capped : 0;
      const curInv = future(current?.invitesDisabledUntil, now);
      const curDms = future(current?.dmsDisabledUntil, now);
      const nextInv = invites && target ? Math.max(curInv ?? 0, target) : curInv;
      const nextDms = dms && target ? Math.max(curDms ?? 0, target) : curDms;
      // Riposte de vague sans rien à prolonger (plafond de la série atteint) : aucun appel.
      if (Number.isFinite(notAfter) && nextInv === curInv && nextDms === curDms) return { invitesDisabledUntil: curInv, dmsDisabledUntil: curDms, previous: { invites: curInv, dms: curDms } };
      const data = await this.#put(guild, nextInv, nextDms);
      logger.info(`Incident ${guild.id} : invitations ${nextInv ? 'suspendues' : 'actives'}, MP ${nextDms ? 'suspendus' : 'actifs'}${actorId ? ` (par ${actorId})` : ''}${reason ? ` — ${reason}` : ''}.`);
      return {
        invitesDisabledUntil: future(data?.invitesDisabledUntil, now) ?? nextInv,
        dmsDisabledUntil: future(data?.dmsDisabledUntil, now) ?? nextDms,
        previous: { invites: curInv, dms: curDms },
      };
    });
  }

  /**
   * Rétablit les invitations et/ou les MP (échéance remise à null).
   * @returns {Promise<{ invitesDisabledUntil: number|null, dmsDisabledUntil: number|null, previous: { invites: number|null, dms: number|null } }>}
   */
  async resume(guild, { invites = true, dms = true } = {}) {
    if (!invites && !dms) throw new UserError('Choisissez au moins les invitations ou les messages privés.');
    this.assertCanManage(guild);
    return this.#withLock(guild.id, async () => {
      const now = this.now();
      const current = await this.#incidents(guild);
      const curInv = future(current?.invitesDisabledUntil, now);
      const curDms = future(current?.dmsDisabledUntil, now);
      const nextInv = invites ? null : curInv;
      const nextDms = dms ? null : curDms;
      const data = await this.#put(guild, nextInv, nextDms);
      return {
        invitesDisabledUntil: future(data?.invitesDisabledUntil, now),
        dmsDisabledUntil: future(data?.dmsDisabledUntil, now),
        previous: { invites: curInv, dms: curDms },
      };
    });
  }

  /**
   * État des mesures d'incident (guild.fetch puis incidentsData).
   * @returns {Promise<{ invitesDisabledUntil: number|null, dmsDisabledUntil: number|null, raidDetectedAt: number|null, dmSpamDetectedAt: number|null }>}
   */
  async status(guild) {
    const fresh = await guild.fetch();
    const data = fresh?.incidentsData ?? null;
    const now = this.now();
    const at = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : null);
    return {
      invitesDisabledUntil: future(data?.invitesDisabledUntil, now),
      dmsDisabledUntil: future(data?.dmsDisabledUntil, now),
      raidDetectedAt: at(data?.raidDetectedAt),
      dmSpamDetectedAt: at(data?.dmSpamDetectedAt),
    };
  }

  /**
   * Hook de vague de l'AntiRaid (attendu 2 s au plus). Agit seulement si raidResponse.onWave ;
   * au plus une pause par serveur toutes les 10 min. Son `text` devient le champ « Invitations »
   * de l'alerte. Ne lève jamais.
   * @returns {Promise<{ text: string }|null>}
   */
  async onWave(guild, { count = 0 } = {}) {
    if (!guild?.id) return null;
    const cfg = this.config.get(guild.id)?.raidResponse;
    if (!cfg?.onWave || (!cfg.invites && !cfg.dms)) return null;
    const now = this.now();
    const last = this.waves.get(guild.id);
    if (last && now - last.at < WAVE_COOLDOWN_MS) return { text: last.text };
    // Série : elle se poursuit tant que la pause de la riposte précédente court (plafond since + 24 h).
    const since = last && last.until > now ? last.since : now;
    // Réservé AVANT l'appel : deux vagues simultanées ne font qu'une pause.
    const entry = { at: now, since, until: last?.until ?? 0, text: 'Suspension en cours…' };
    this.waves.delete(guild.id);
    this.waves.set(guild.id, entry);
    while (this.waves.size > MAX_TRACKED) this.waves.delete(this.waves.keys().next().value);
    try {
      const res = await this.pause(guild, { invites: Boolean(cfg.invites), dms: Boolean(cfg.dms), hours: cfg.hours, reason: `vague de ${count} arrivées`, notAfter: since + MAX_PAUSE_MS });
      entry.until = Math.max(res.invitesDisabledUntil ?? 0, res.dmsDisabledUntil ?? 0);
      entry.text = describeState(res, this.now());
    } catch (err) {
      entry.text = `⚠️ Suspension impossible : ${translateError(err).message}`;
    }
    return { text: entry.text };
  }

  forgetGuild(guildId) {
    this.waves.delete(guildId);
    this.locks.delete(guildId);
  }
}

module.exports = {
  RaidResponseService,
  normalizeHours,
  pauseUntil,
  future,
  translateError,
  describeState,
  PAUSE_HOURS,
  DEFAULT_HOURS,
  MAX_PAUSE_MS,
  WAVE_COOLDOWN_MS,
  MISSING_PERMISSION,
};
