'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { matchesTrigger, renderResponse, parseEmoji } = require('../utils/community');
const { isIgnoredChannel } = require('./LevelService');
const { hasMediaOrLink } = require('./AutomationService');
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

// ---------------------------------------------------------------- réactions automatiques par salon

/** Salons à réactions automatiques par serveur. */
const AUTO_REACT_MAX_CHANNELS = 10;
/** Emojis par salon. */
const AUTO_REACT_MAX_EMOJIS = 3;
/** Messages en attente de réaction au plus, par salon puis au total (au-delà : abandon compté). */
const REACT_QUEUE_PER_CHANNEL = 20;
const REACT_QUEUE_TOTAL = 500;
/** File SÉRIELLE par salon : environ une réaction toutes les 250 ms. */
const REACT_GAP_MS = 250;
/** Messages concernés par les réactions d'un salon. */
const REACT_MODES = Object.freeze({
  all: 'Tous les messages',
  media: 'Images, vidéos et liens',
  text: 'Texte seul (sans média)',
});
const FORUM_TYPES = new Set([15, 16]); // GuildForum, GuildMedia
const SEGMENTER = new Intl.Segmenter('fr', { granularity: 'grapheme' });
const NAMED_EMOJI = /^:([\w~]{2,32}):$/;

/** Découpe une saisie en emojis candidats (espaces, virgules, ou emojis collés). Pur. */
function emojiTokens(raw) {
  const tokens = [];
  for (const part of String(raw ?? '').split(/[\s,;]+/).filter(Boolean)) {
    if (parseEmoji(part) || NAMED_EMOJI.test(part)) {
      tokens.push(part);
      continue;
    }
    const re = /<a?:[\w~]{2,32}:\d{17,20}>|:[\w~]{2,32}:/g;
    let last = 0;
    let m;
    while ((m = re.exec(part))) {
      for (const { segment } of SEGMENTER.segment(part.slice(last, m.index))) tokens.push(segment);
      tokens.push(m[0]);
      last = re.lastIndex;
    }
    for (const { segment } of SEGMENTER.segment(part.slice(last))) tokens.push(segment);
  }
  return tokens;
}

/**
 * Emojis d'un salon à réactions automatiques : 1 à 3, Unicode ou personnalisés DE CE SERVEUR
 * (`<:nom:id>`, ou `:nom:` résolu dans les emojis du serveur). Lecture du cache seulement.
 * @returns {{ emojis: string[] } | { error: string }}
 */
function parseReactionEmojis(raw, guild) {
  const tokens = emojiTokens(raw);
  if (!tokens.length) return { error: 'Indiquez au moins un emoji.' };
  const cache = guild?.emojis?.cache;
  const out = [];
  for (const token of tokens) {
    let emoji = parseEmoji(token);
    const named = emoji ? null : NAMED_EMOJI.exec(token);
    if (named) {
      const found = [...(cache?.values?.() ?? [])].filter((e) => e.name === named[1]);
      if (found.length !== 1) return { error: `L'emoji \`:${named[1]}:\` n'existe pas sur ce serveur (ou plusieurs portent ce nom : utilisez \`<:nom:id>\`).` };
      const e = found[0];
      emoji = { id: e.id, name: e.name, animated: Boolean(e.animated), text: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` };
    }
    if (!emoji) return { error: `\`${token.slice(0, 20).replace(/`/g, 'ˋ')}\` n'est pas un emoji : entrez des emojis Unicode (👍) ou de ce serveur (\`<:nom:id>\`).` };
    if (emoji.id && !cache?.has?.(emoji.id)) return { error: 'Cet emoji personnalisé n\'appartient pas à ce serveur.' };
    if (!out.includes(emoji.text)) out.push(emoji.text);
  }
  if (out.length > AUTO_REACT_MAX_EMOJIS) return { error: `${AUTO_REACT_MAX_EMOJIS} emojis au plus par salon.` };
  return { emojis: out };
}

/**
 * Réglage de réactions applicable à ce message, ou null. Salon configuré ; fil d'un salon
 * configuré si `threads` ; forum configuré : message d'ouverture de chaque post (son
 * identifiant est celui du fil). Pur.
 */
function reactionEntryFor(message, cfg) {
  if (!cfg?.enabled) return null;
  const list = Array.isArray(cfg.channels) ? cfg.channels : [];
  if (!list.length) return null;
  const valid = (e) => (e && Array.isArray(e.emojis) && e.emojis.length ? e : null);
  const direct = list.find((e) => e?.channelId === message.channelId);
  if (direct) return valid(direct);
  const channel = message.channel;
  if (!channel?.isThread?.() || !channel.parentId) return null;
  const parent = valid(list.find((e) => e?.channelId === channel.parentId));
  if (!parent) return null;
  // Post de forum : son message d'ouverture porte l'identifiant du fil ; les réponses ne comptent pas.
  if (message.id === message.channelId) return parent;
  if (FORUM_TYPES.has(channel.parent?.type)) return null;
  return parent.threads ? parent : null;
}

/** Le message correspond-il au mode du salon (tous, médias, texte seul) ? Pur. */
function reactionModeMatches(message, mode = 'all') {
  if (mode === 'media') return hasMediaOrLink(message);
  if (mode === 'text') return Boolean(String(message.content ?? '').trim()) && !hasMediaOrLink(message);
  return true;
}

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
    // Réactions automatiques par salon (seconde passe, indépendante des déclencheurs).
    /** @type {Map<string, { guildId: string, items: { message: object, readyAt: number }[], running: boolean }>} */
    this.reactQueues = new Map();
    this.reactPending = 0;
    this.reactGapMs = REACT_GAP_MS;
    /** Réactions abandonnées (file pleine), par serveur. */
    this.reactDropped = new Map();
    /** Attentes en cours (délai, espacement) : levées par stop(). */
    this.sleepers = new Set();
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
    if (this.stopped || !this.isEligible(message)) return false;
    // Seconde passe : réactions du salon (un message peut aussi déclencher une réponse à motif).
    this.queueReactions(message);
    if (this.pending.size >= PENDING_MAX) return false;
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

  // ------------------------------------------------------------ réactions automatiques

  /**
   * Met le message en file de réactions de son salon (sortie immédiate si la fonction est
   * désactivée). Délai de `delayMs` (l'AutoMod peut le supprimer entre-temps), puis réactions
   * dans l'ordre, une toutes les ~250 ms. File bornée par salon et au total.
   * @returns {boolean} le message attend ses réactions
   */
  queueReactions(message) {
    if (this.stopped || !this.isEligible(message)) return false;
    const cfg = this.config.get(message.guildId)?.autoReact;
    if (!cfg?.enabled) return false;
    const entry = reactionEntryFor(message, cfg);
    if (!entry || !reactionModeMatches(message, entry.mode)) return false;
    const key = message.channelId;
    let queue = this.reactQueues.get(key);
    if (queue && (queue.items.length >= REACT_QUEUE_PER_CHANNEL || this.reactPending >= REACT_QUEUE_TOTAL)) {
      this.reactDropped.set(message.guildId, (this.reactDropped.get(message.guildId) ?? 0) + 1);
      logger.debug(`Réactions automatiques : file pleine dans ${key} (${message.guildId}), message ignoré.`);
      return false;
    }
    if (!queue && this.reactPending >= REACT_QUEUE_TOTAL) {
      this.reactDropped.set(message.guildId, (this.reactDropped.get(message.guildId) ?? 0) + 1);
      return false;
    }
    if (!queue) {
      queue = { guildId: message.guildId, items: [], running: false };
      this.reactQueues.set(key, queue);
    }
    queue.items.push({ message, readyAt: Date.now() + this.delayMs });
    this.reactPending += 1;
    this.#pumpReactions(key).catch((err) => logger.warn(`Réactions automatiques (${message.guildId}) :`, err?.message));
    return true;
  }

  /** État de la file pour le tableau de bord : messages en attente et réactions abandonnées. */
  reactionStats(guildId) {
    let pending = 0;
    for (const q of this.reactQueues.values()) if (q.guildId === guildId) pending += q.items.length;
    return { pending, dropped: this.reactDropped.get(guildId) ?? 0 };
  }

  /** Vide la file d'un salon, un message après l'autre (un seul passage actif par salon). */
  async #pumpReactions(key) {
    const queue = this.reactQueues.get(key);
    if (!queue || queue.running) return;
    queue.running = true;
    try {
      while (!this.stopped && queue.items.length) {
        const wait = queue.items[0].readyAt - Date.now();
        if (wait > 0) await this.#sleep(wait);
        if (this.stopped || !queue.items.length) break;
        const { message } = queue.items.shift();
        this.reactPending = Math.max(0, this.reactPending - 1);
        await this.#reactTo(message);
      }
    } finally {
      queue.running = false;
      if (!queue.items.length && this.reactQueues.get(key) === queue) this.reactQueues.delete(key);
    }
  }

  /** Réagit à un message (relu : supprimé, réglage changé, permissions). @returns {Promise<number>} réactions posées */
  async #reactTo(message) {
    if (this.stopped || this.wasDeleted(message.id)) return 0;
    const entry = reactionEntryFor(message, this.config.get(message.guildId)?.autoReact);
    if (!entry) return 0;
    const guild = message.guild;
    const me = guild?.members?.me;
    const perms = me && message.channel?.permissionsFor?.(me);
    // Permissions du bot revérifiées : Voir le salon, Ajouter des réactions, Lire l'historique.
    if (!perms?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory])) return 0;
    let done = 0;
    for (const text of entry.emojis.slice(0, AUTO_REACT_MAX_EMOJIS)) {
      if (this.stopped || this.wasDeleted(message.id)) break;
      const emoji = parseEmoji(text);
      if (!emoji) continue;
      if (emoji.id) {
        const known = guild.emojis?.cache?.get(emoji.id);
        if (!known || known.available === false) continue; // emoji supprimé ou indisponible
      }
      try {
        await message.react(emoji.id ? emoji.text : emoji.name);
        done += 1;
      } catch (err) {
        logger.debug(`Réaction automatique impossible (${message.channelId}) :`, err?.message);
        if (err?.code === 10008 || err?.code === 10003 || err?.code === 50001) break; // message ou salon disparu, accès perdu
      }
      await this.#sleep(this.reactGapMs);
    }
    return done;
  }

  /** Attente unref, levée immédiatement par stop(). */
  #sleep(ms) {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        this.sleepers.delete(entry);
        resolve();
      }, Math.max(0, ms));
      entry.timer.unref?.();
      this.sleepers.add(entry);
    });
  }

  stop() {
    this.stopped = true;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    for (const q of this.reactQueues.values()) q.items.length = 0;
    this.reactQueues.clear();
    this.reactPending = 0;
    for (const s of this.sleepers) {
      clearTimeout(s.timer);
      s.resolve();
    }
    this.sleepers.clear();
  }
}

module.exports = {
  AutoResponderService,
  channelAllowed,
  parseReactionEmojis,
  reactionEntryFor,
  reactionModeMatches,
  MAX_TRIGGERS,
  RESPONSE_DELAY_MS,
  AUTO_REACT_MAX_CHANNELS,
  AUTO_REACT_MAX_EMOJIS,
  REACT_QUEUE_PER_CHANNEL,
  REACT_QUEUE_TOTAL,
  REACT_GAP_MS,
  REACT_MODES,
};
