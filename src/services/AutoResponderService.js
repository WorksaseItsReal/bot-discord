'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { matchesTrigger, renderResponse, parseEmoji } = require('../utils/community');
const { isIgnoredChannel } = require('./LevelService');
const { createLogger } = require('../core/logger');

const logger = createLogger('autoresponses');

/**
 * Délai avant de répondre : laisse à l'AutoMod le temps de supprimer le message
 * (même principe que LevelService#handleMessage).
 */
const RESPONSE_DELAY_MS = 1_500;
/** Déclencheurs par serveur. */
const MAX_TRIGGERS = 25;
const DELETED_TTL_MS = 60_000;
const DELETED_MAX = 2_000;
const COOLDOWN_PRUNE_AT = 5_000;
/** Réponses en attente au plus (garde-fou en cas de flot de messages). */
const PENDING_MAX = 500;

/** Le salon est-il autorisé pour ce déclencheur ? (liste vide = partout ; fils et catégories suivent leur parent) Pur. */
function channelAllowed(channel, trigger) {
  const allowed = trigger.channels ?? [];
  if (allowed.length && !isIgnoredChannel(channel, allowed)) return false;
  return !isIgnoredChannel(channel, trigger.excludedChannels ?? []);
}

/**
 * Réponses automatiques : un message qui contient un déclencheur (mot entier, contient,
 * commence par, message exact — jamais d'expression régulière saisie) reçoit une réponse
 * texte et/ou une réaction. Cooldown par déclencheur ET par salon. Bots, webhooks et
 * messages supprimés par l'AutoMod ignorés. Aucune mention ne notifie (allowedMentions vide).
 */
class AutoResponderService {
  /**
   * @param {{ client?: object, config: import('./ConfigService').ConfigService, delayMs?: number }} deps
   */
  constructor({ client, config, delayMs = RESPONSE_DELAY_MS }) {
    this.client = client;
    this.config = config;
    this.delayMs = delayMs;
    /** Fin du cooldown : `${guildId}:${triggerId}:${channelId}` → ms. */
    this.cooldowns = new Map();
    /** Messages supprimés récemment : id → expiration. */
    this.deleted = new Map();
    this.pending = new Set();
    this.stopped = false;
  }

  cfg(guildId) {
    return this.config.get(guildId).community?.autoResponses ?? {};
  }

  /** Premier déclencheur actif qui correspond au message (sans tenir compte du cooldown). */
  match(message, cfg = this.cfg(message.guildId)) {
    if (!cfg.enabled) return null;
    const content = message.content ?? '';
    if (!content.trim()) return null;
    for (const trigger of cfg.triggers ?? []) {
      if (trigger.enabled === false || !trigger.pattern) continue;
      if (!channelAllowed(message.channel, trigger)) continue;
      if (matchesTrigger(content, trigger.pattern, trigger.mode)) return trigger;
    }
    return null;
  }

  /** Message éligible ? (bots, webhooks, messages système et hors serveur exclus) */
  isEligible(message) {
    return Boolean(message?.guildId && message.author && !message.author.bot && !message.webhookId && !message.system);
  }

  /**
   * Point d'entrée messageCreate. La réponse est programmée `delayMs` plus tard et
   * abandonnée si le message a été supprimé entre-temps (AutoMod, modérateur).
   * @returns {boolean} une réponse a été programmée
   */
  handleMessage(message) {
    if (this.stopped || !this.isEligible(message) || this.pending.size >= PENDING_MAX) return false;
    if (!this.match(message)) return false;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      this.process(message).catch((err) => logger.warn(`Réponse automatique impossible (${message.guildId}) :`, err?.message));
    }, this.delayMs);
    timer.unref?.();
    this.pending.add(timer);
    return true;
  }

  markDeleted(messageId) {
    if (!messageId) return;
    const now = Date.now();
    this.deleted.set(messageId, now + DELETED_TTL_MS);
    if (this.deleted.size > DELETED_MAX) for (const [id, exp] of this.deleted) if (exp <= now) this.deleted.delete(id);
  }

  /** Supprimé par un modérateur ou filtré par l'AutoMod ? (lecture sans consommer la marque) */
  wasDeleted(messageId) {
    if ((this.deleted.get(messageId) ?? 0) > Date.now()) return true;
    const suppressed = this.client?.services?.logging?.suppressed;
    return Boolean(suppressed?.get?.(messageId) > Date.now());
  }

  /** Après le délai : revérifie, applique le cooldown, répond. @returns {Promise<object|null>} déclencheur utilisé */
  async process(message) {
    if (this.stopped || this.wasDeleted(message.id)) return null;
    const trigger = this.match(message);
    if (!trigger) return null;
    const now = Date.now();
    const key = `${message.guildId}:${trigger.id}:${message.channelId}`;
    if ((this.cooldowns.get(key) ?? 0) > now) return null;
    this.cooldowns.set(key, now + Math.max(0, trigger.cooldownSeconds ?? 30) * 1000);
    if (this.cooldowns.size > COOLDOWN_PRUNE_AT) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);
    await this.respond(message, trigger);
    return trigger;
  }

  async respond(message, trigger) {
    const channel = message.channel;
    const me = message.guild?.members?.me;
    const perms = me && channel?.permissionsFor?.(me);
    const can = (flag) => !perms || perms.has(flag);
    const emoji = trigger.reaction ? parseEmoji(trigger.reaction) : null;
    if (emoji && can(PermissionFlagsBits.AddReactions) && can(PermissionFlagsBits.ReadMessageHistory)) {
      await message.react(emoji.id ?? emoji.name).catch((err) => logger.debug(`Réaction automatique impossible (${trigger.id}) :`, err?.message));
    }
    if (!trigger.response || !can(PermissionFlagsBits.SendMessages)) return;
    const content = renderResponse(trigger.response, { member: `<@${message.author.id}>`, server: message.guild?.name ?? '' });
    if (!content.trim()) return;
    const payload = {
      content,
      // Jamais de mention qui notifie : ni @everyone/@here, ni rôles, ni membres.
      allowedMentions: { parse: [], repliedUser: false },
    };
    if (can(PermissionFlagsBits.ReadMessageHistory)) payload.reply = { messageReference: message.id, failIfNotExists: false };
    await channel.send(payload).catch((err) => logger.debug(`Réponse automatique non envoyée (${trigger.id}) :`, err?.message));
  }

  stop() {
    this.stopped = true;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}

module.exports = { AutoResponderService, channelAllowed, MAX_TRIGGERS, RESPONSE_DELAY_MS };
