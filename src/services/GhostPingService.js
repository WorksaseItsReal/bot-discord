'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('../core/logger');

const logger = createLogger('ghostping');

/** Salons de ghostping au plus. */
const MAX_CHANNELS = 5;
/** Arrivées regroupées sur 2 s : un message par salon. */
const BATCH_MS = 2_000;
/** Mentions par message, et membres en attente au plus par serveur (au-delà : envoi anticipé ou abandon). */
const MAX_MENTIONS = 20;
/** Délai avant suppression : 1 à 10 s (1,5 s par défaut). */
const MIN_DELETE_S = 1;
const MAX_DELETE_S = 10;
const DEFAULT_DELETE_S = 1.5;
/** Pas de ghostping dans la minute qui suit un déclenchement de l'AntiRaid. */
const WAVE_QUIET_MS = 60_000;
/** Un même membre n'est pas repingué avant 10 min (départs / retours en boucle). */
const MEMBER_COOLDOWN_MS = 10 * 60_000;
/** Budget de l'arrêt : les mentions encore affichées sont supprimées en parallèle, au plus 3 s. */
const STOP_BUDGET_MS = 3_000;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const BOT_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

/** Délai de suppression borné (secondes). Pur. */
function clampDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DELETE_S;
  return Math.min(MAX_DELETE_S, Math.max(MIN_DELETE_S, n));
}

/** Délai saisi (« 1,5 », « 2 », « 3s ») en secondes, ou null s'il est invalide ou hors de 1 à 10 s. Pur. */
function parseDelay(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(',', '.').replace(/\s*(s|sec|secondes?)$/, '');
  if (!/^\d{1,2}(\.\d)?$/.test(text)) return null;
  const n = Number(text);
  return n >= MIN_DELETE_S && n <= MAX_DELETE_S ? n : null;
}

/** Attend `promise` au plus `ms` (minuteur unref). Ne rejette jamais. */
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).catch(() => {}), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ghostping d'arrivée (/bienvenue › Ghostping) : le nouveau membre est mentionné dans quelques
 * salons (il y voit une pastille de notification), puis le message est supprimé 1 à 10 s plus tard.
 *
 *  - Déclenchement : fin de l'accueil (arrivée non sanctionnée par l'AntiRaid, écran d'adhésion
 *    accepté) ou, si `afterVerification` et que la vérification est active, vérification réussie.
 *  - Jamais pour un bot, jamais pendant une vague (AntiRaid déclenché il y a moins de 60 s, vague
 *    sanctionnée, lockdown actif), jamais deux fois en 10 min pour un même membre.
 *  - Arrivées regroupées sur 2 s : un message par salon, 20 mentions au plus,
 *    allowedMentions limité aux membres mentionnés ; un salon n'est retenu que si le MEMBRE peut
 *    le voir et que le bot peut y voir et y écrire.
 *  - Aucun log (debug seulement). À l'arrêt, les mentions en attente de suppression sont
 *    supprimées immédiatement (borné).
 */
class GhostPingService {
  /**
   * @param {{ client: import('discord.js').Client, config: import('./ConfigService').ConfigService, now?: () => number }} deps
   */
  constructor({ client, config, now = Date.now }) {
    this.client = client;
    this.config = config;
    this.now = now;
    this.batchMs = BATCH_MS;
    /** @type {Map<string, { members: Map<string, object>, timer: NodeJS.Timeout|null }>} arrivées en attente, par serveur */
    this.batches = new Map();
    /** @type {Map<string, number>} dernier envoi, par serveur */
    this.lastFlush = new Map();
    /** @type {Map<string, number>} serveur:membre → fin du délai avant un nouveau ping */
    this.recent = new Map();
    /** @type {Set<{ message: object, timer: NodeJS.Timeout }>} mentions affichées, en attente de suppression */
    this.live = new Set();
    /** @type {Set<Promise<unknown>>} envois et suppressions en cours */
    this.background = new Set();
    this.stopped = false;
  }

  settings(guildId) {
    return this.config.get(guildId).ghostPing ?? {};
  }

  /** Le ping attend-il la vérification (option active ET vérification active) ? */
  waitsForVerification(guildId) {
    const v = this.config.get(guildId).welcome?.verification ?? {};
    return this.settings(guildId).afterVerification !== false && Boolean(v.enabled && v.roleId);
  }

  /**
   * Vague d'arrivées en cours ? Déclenchement AntiRaid de moins de 60 s, vague sanctionnée
   * (silence de l'accueil), et, si demandé, lockdown actif (lecture en base).
   */
  inWave(guild, { checkLockdown = false } = {}) {
    const now = this.now();
    const services = this.client?.services ?? {};
    const alertAt = services.antiraid?.joinAlertAt?.get?.(guild.id);
    if (alertAt && now - alertAt < WAVE_QUIET_MS) return true;
    if ((services.welcome?.waves?.get?.(guild.id) ?? 0) > now) return true;
    if (checkLockdown && services.lockdown?.status) {
      try {
        if (services.lockdown.status(guild) > 0) return true;
      } catch (err) {
        logger.debug(`Lockdown illisible (${guild.id}) :`, err?.message);
        return true; // doute : pas de ping
      }
    }
    return false;
  }

  /**
   * Programme le ghostping d'un membre (regroupé avec les arrivées des 2 s suivantes).
   * @param {import('discord.js').GuildMember} member
   * @param {{ source?: 'join'|'verify' }} [ctx] join : fin de l'accueil · verify : vérification réussie
   * @returns {boolean} le membre attend son ping
   */
  queue(member, { source = 'join' } = {}) {
    const guild = member?.guild;
    if (this.stopped || !guild || !member.id || member.user?.bot) return false;
    const cfg = this.settings(guild.id);
    if (!cfg.enabled || !(cfg.channels ?? []).length) return false;
    // Un seul déclencheur : l'arrivée, ou la vérification si le ping l'attend.
    const waits = this.waitsForVerification(guild.id);
    if (source === 'verify' ? !waits : waits) return false;
    if (this.inWave(guild)) {
      logger.debug(`Ghostping ignoré pendant une vague (${guild.id}).`);
      return false;
    }
    const now = this.now();
    const key = `${guild.id}:${member.id}`;
    if ((this.recent.get(key) ?? 0) > now) return false;
    let batch = this.batches.get(guild.id);
    if (batch?.members.has(member.id)) return false;
    if (batch && batch.members.size >= MAX_MENTIONS) {
      logger.debug(`Ghostping : file pleine sur ${guild.id}, ${member.id} ignoré.`);
      return false;
    }
    if (!batch) {
      batch = { members: new Map(), timer: null };
      this.batches.set(guild.id, batch);
    }
    batch.members.set(member.id, member);
    this.recent.set(key, now + MEMBER_COOLDOWN_MS);
    if (this.recent.size > 5_000) for (const [k, until] of this.recent) if (until <= now) this.recent.delete(k);
    // Lot complet : envoi immédiat, sauf si le précédent date de moins de 2 s (au plus 20 pings / 2 s).
    if (batch.members.size >= MAX_MENTIONS && now - (this.lastFlush.get(guild.id) ?? 0) >= this.batchMs) {
      this.#flush(guild.id);
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => this.#flush(guild.id), this.batchMs);
      batch.timer.unref?.();
    }
    return true;
  }

  /** Membres en attente de ping (tableau de bord, tests). */
  pendingCount(guildId) {
    return this.batches.get(guildId)?.members.size ?? 0;
  }

  #track(promise) {
    const p = Promise.resolve(promise).catch((err) => logger.debug('Ghostping :', err?.message ?? err));
    this.background.add(p);
    p.finally(() => this.background.delete(p));
    return p;
  }

  #flush(guildId) {
    const batch = this.batches.get(guildId);
    if (!batch) return null;
    this.batches.delete(guildId);
    clearTimeout(batch.timer);
    this.lastFlush.set(guildId, this.now());
    return this.#track(this.#send(guildId, [...batch.members.values()]));
  }

  /** Envoie un lot : un message par salon retenu. @returns {Promise<number>} messages envoyés */
  async #send(guildId, members) {
    if (this.stopped) return 0;
    const guild = this.client?.guilds?.cache?.get(guildId);
    if (!guild?.available) return 0;
    const cfg = this.settings(guildId);
    if (!cfg.enabled) return 0;
    if (this.inWave(guild, { checkLockdown: true })) {
      logger.debug(`Ghostping annulé : vague ou lockdown en cours (${guildId}).`);
      return 0;
    }
    // Membres toujours là (expulsé ou parti entre-temps : pas de mention), objets à jour (rôles).
    const present = members.map((m) => guild.members.cache.get(m.id)).filter((m) => m && !m.user?.bot);
    if (!present.length) return 0;
    const delayMs = clampDelay(cfg.deleteAfterSeconds) * 1000;
    const me = guild.members.me;
    let sent = 0;
    for (const channelId of (cfg.channels ?? []).slice(0, MAX_CHANNELS)) {
      if (this.stopped) break;
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !TEXT_TYPES.includes(channel.type)) continue;
      if (!me || !channel.permissionsFor(me)?.has(BOT_PERMS)) continue;
      // Seulement les membres qui VOIENT ce salon (sinon la mention ne leur sert à rien).
      const ids = present.filter((m) => channel.permissionsFor(m)?.has(PermissionFlagsBits.ViewChannel)).map((m) => m.id).slice(0, MAX_MENTIONS);
      if (!ids.length) continue;
      let message;
      try {
        message = await channel.send({ content: ids.map((id) => `<@${id}>`).join(' '), allowedMentions: { users: ids, parse: [] } });
      } catch (err) {
        logger.debug(`Ghostping non envoyé dans ${channelId} (${guildId}) :`, err?.message);
        continue;
      }
      sent += 1;
      this.#scheduleDelete(message, delayMs);
    }
    return sent;
  }

  #scheduleDelete(message, ms) {
    if (this.stopped) {
      this.#track(this.#delete(message));
      return;
    }
    const entry = { message, timer: null };
    entry.timer = setTimeout(() => {
      this.live.delete(entry);
      this.#track(this.#delete(message));
    }, ms);
    entry.timer.unref?.();
    this.live.add(entry);
  }

  /** Supprime une mention (jamais journalisée : marque « supprimé par le bot »). */
  async #delete(message) {
    this.client?.services?.logging?.suppressMessage?.(message.id);
    await message.delete().catch((err) => logger.debug(`Ghostping non supprimé (${message.id}) :`, err?.message));
  }

  /** Arrêt : plus de nouveaux pings ; les mentions affichées sont supprimées tout de suite (borné). */
  async stop() {
    this.stopped = true;
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
    const live = [...this.live];
    this.live.clear();
    for (const entry of live) {
      clearTimeout(entry.timer);
      this.#track(this.#delete(entry.message));
    }
    // Envois en cours : leurs messages sont supprimés dès leur retour (#scheduleDelete après stop).
    const deadline = Date.now() + STOP_BUDGET_MS;
    while (this.background.size && Date.now() < deadline) {
      await settleWithin(Promise.allSettled([...this.background]), deadline - Date.now());
    }
  }
}

module.exports = {
  GhostPingService,
  clampDelay,
  parseDelay,
  MAX_CHANNELS,
  MAX_MENTIONS,
  BATCH_MS,
  MIN_DELETE_S,
  MAX_DELETE_S,
  DEFAULT_DELETE_S,
  WAVE_QUIET_MS,
  MEMBER_COOLDOWN_MS,
  TEXT_TYPES,
};
