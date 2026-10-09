'use strict';

const { PermissionFlagsBits, ActionRowBuilder } = require('discord.js');
const { card, field, ICONS, linkButton, fitEmbeds } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { parseEmoji, emojiMatches, firstImage, isNsfwChannel } = require('../utils/community');
const { isIgnoredChannel } = require('./LevelService');
const { createLogger } = require('../core/logger');

const logger = createLogger('starboard');

/** Attente avant de recompter (les réactions arrivent par rafales). */
const DEBOUNCE_MS = 2_000;
/** Intervalle minimal entre deux mises à jour d'une même carte. */
const MIN_EDIT_INTERVAL_MS = 5_000;
/** Mises à jour récentes retenues (intervalle minimal) avant élagage. */
const RECENT_MAX = 1_000;
/** Codes Discord : message / salon inconnu. */
const UNKNOWN = new Set([10003, 10008]);

const SEND_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * Starboard : un message qui atteint N réactions (emoji réglable) est reposté dans le
 * salon starboard sous forme de carte, mise à jour en direct (avec anti-rebond : une
 * édition au plus toutes les 5 s par message, jamais une par réaction).
 *
 * Ne comptent pas : l'auteur du message (auto-étoile) et les bots. Ne sont jamais
 * repostés : les messages de bots ou système, ceux des salons exclus et du salon
 * starboard lui-même, et ceux d'un salon NSFW si le starboard n'est pas NSFW.
 */
class StarboardService {
  /**
   * @param {{ client: import('discord.js').Client, starboard: import('../database/repositories/StarboardRepository').StarboardRepository,
   *   config: import('./ConfigService').ConfigService, debounceMs?: number, minEditIntervalMs?: number }} deps
   */
  constructor({ client, starboard, config, debounceMs = DEBOUNCE_MS, minEditIntervalMs = MIN_EDIT_INTERVAL_MS }) {
    this.client = client;
    this.repo = starboard;
    this.config = config;
    this.debounceMs = debounceMs;
    this.minEditIntervalMs = minEditIntervalMs;
    /** Recomptes programmés / en cours : `${guildId}:${messageId}` → entrée. */
    this.entries = new Map();
    /** Fin du dernier recompte : clé → ms (intervalle minimal entre deux éditions). */
    this.recent = new Map();
    this.stopped = false;
  }

  cfg(guildId) {
    return this.config.get(guildId).community?.starboard ?? {};
  }

  // ------------------------------------------------------------ événements

  /** La réaction concerne-t-elle le starboard de ce serveur ? (sans appel réseau) */
  isRelevant(guildId, channelId, emoji) {
    if (!guildId || !channelId) return false;
    const cfg = this.cfg(guildId);
    if (!cfg.enabled || !cfg.channelId || channelId === cfg.channelId) return false;
    return emojiMatches(cfg.emoji || '⭐', emoji);
  }

  /** messageReactionAdd / messageReactionRemove (réaction et utilisateur éventuellement partiels). */
  handleReaction(reaction, user) {
    if (this.stopped || !reaction) return false;
    const message = reaction.message;
    const guildId = message?.guildId ?? message?.guild?.id;
    if (user?.id && user.id === this.client?.user?.id) return false;
    if (user?.bot) return false; // un bot ne change jamais le compte
    if (!this.isRelevant(guildId, message?.channelId, reaction.emoji)) return false;
    this.schedule(guildId, message.channelId, message.id);
    return true;
  }

  /** messageReactionRemoveAll : toutes les réactions retirées d'un message. */
  handleRemoveAll(message) {
    const guildId = message?.guildId ?? message?.guild?.id;
    if (this.stopped || !guildId || !message?.channelId) return false;
    const cfg = this.cfg(guildId);
    if (!cfg.enabled || !this.repo.get(guildId, message.id)) return false;
    this.schedule(guildId, message.channelId, message.id);
    return true;
  }

  /** messageReactionRemoveEmoji : un emoji retiré d'un message (par un modérateur). */
  handleRemoveEmoji(reaction) {
    return this.handleReaction(reaction, null);
  }

  /**
   * messageDelete : message d'origine supprimé → sa carte est retirée ; carte du
   * starboard supprimée à la main → la ligne est oubliée (recréée si on réagit encore).
   */
  async handleDelete(message) {
    const guildId = message?.guildId ?? message?.guild?.id;
    if (!guildId || !message?.id) return;
    const asCard = this.repo.byStarMessage(message.id);
    if (asCard) {
      this.repo.delete(asCard.guild_id, asCard.message_id);
      return;
    }
    const row = this.repo.get(guildId, message.id);
    if (!row) return;
    this.#cancel(`${guildId}:${message.id}`);
    this.repo.delete(guildId, message.id);
    if (row.star_message_id) await this.#deleteCard(guildId, row.star_message_id);
  }

  // ------------------------------------------------------------ anti-rebond

  /** Programme un recompte (une seule mise à jour pour une rafale de réactions). */
  schedule(guildId, channelId, messageId) {
    if (this.stopped) return;
    const key = `${guildId}:${messageId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { guildId, channelId, messageId, timer: null, running: null, dirty: false };
      this.entries.set(key, entry);
    }
    if (entry.running) {
      entry.dirty = true; // recompté juste après la mise à jour en cours
      return;
    }
    if (entry.timer) return;
    const since = Date.now() - (this.recent.get(key) ?? 0);
    const delay = Math.max(this.debounceMs, this.minEditIntervalMs - since);
    entry.timer = setTimeout(() => this.#run(key), delay);
    entry.timer.unref?.();
  }

  #run(key) {
    const entry = this.entries.get(key);
    if (!entry || this.stopped) return;
    entry.timer = null;
    entry.running = this.flush(entry.guildId, entry.channelId, entry.messageId)
      .catch((err) => logger.warn(`Mise à jour du starboard impossible (${entry.guildId}/${entry.messageId}) :`, err?.message))
      .finally(() => {
        entry.running = null;
        this.#remember(key);
        if (entry.dirty && !this.stopped) {
          entry.dirty = false;
          this.schedule(entry.guildId, entry.channelId, entry.messageId);
        } else if (!entry.timer) {
          this.entries.delete(key);
        }
      });
  }

  #remember(key) {
    const now = Date.now();
    this.recent.set(key, now);
    if (this.recent.size > RECENT_MAX) for (const [k, at] of this.recent) if (now - at > this.minEditIntervalMs) this.recent.delete(k);
  }

  #cancel(key) {
    const entry = this.entries.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry && !entry.running) this.entries.delete(key);
    else if (entry) entry.dirty = false;
  }

  /** Arrêt propre : recomptes programmés annulés, ceux en cours attendus. */
  async stop() {
    this.stopped = true;
    const running = [];
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.running) running.push(entry.running);
    }
    await Promise.allSettled(running);
    this.entries.clear();
  }

  // ------------------------------------------------------------ recompte

  /**
   * Étoiles valides : réactions de l'emoji configuré, sans l'auteur ni les bots.
   * Jusqu'à 100 réactions, le compte est exact (liste des utilisateurs) ; au-delà,
   * il est estimé à partir du total moins les exclus trouvés dans les 100 premiers.
   */
  async countStars(message, emoji) {
    const reaction = message.reactions?.cache?.find((r) => emojiMatches(emoji, r.emoji));
    const total = reaction?.count ?? 0;
    if (!reaction || total <= 0) return 0;
    let users = reaction.users?.cache;
    try {
      users = await reaction.users.fetch({ limit: 100 });
    } catch (err) {
      logger.debug('Réactions illisibles, cache utilisé :', err?.message);
    }
    const list = [...(users?.values?.() ?? [])];
    const excluded = list.filter((u) => u?.bot || u?.id === message.author?.id).length;
    if (list.length >= total) return Math.max(0, list.length - excluded);
    return Math.max(0, total - excluded);
  }

  /** Le message peut-il figurer au starboard ? (null si oui, sinon la raison) */
  ineligibility(message, cfg, starChannel) {
    if (!message?.author) return 'auteur inconnu';
    if (message.author.bot || message.webhookId) return 'message de bot';
    if (message.system) return 'message système';
    if (message.channelId === cfg.channelId) return 'salon starboard';
    if (isIgnoredChannel(message.channel, cfg.excludedChannels ?? [])) return 'salon exclu';
    if (isNsfwChannel(message.channel) && !isNsfwChannel(starChannel)) return 'salon NSFW';
    return null;
  }

  /** Recompte un message et met sa carte en accord (création, mise à jour, retrait). */
  async flush(guildId, channelId, messageId) {
    const cfg = this.cfg(guildId);
    if (!cfg.enabled || !cfg.channelId) return null;
    const guild = this.client.guilds?.cache?.get(guildId);
    const channel = guild?.channels?.cache?.get(channelId) ?? this.client.channels?.cache?.get(channelId);
    const starChannel = guild?.channels?.cache?.get(cfg.channelId);
    if (!channel?.messages || !starChannel?.isTextBased?.()) return null;

    let message = channel.messages.cache.get(messageId);
    if (!message || message.partial) {
      try {
        message = await channel.messages.fetch(messageId);
      } catch (err) {
        if (UNKNOWN.has(err?.code)) await this.handleDelete({ id: messageId, guildId });
        else logger.debug(`Message ${messageId} illisible :`, err?.message);
        return null;
      }
    }
    if (this.ineligibility(message, cfg, starChannel)) return null;

    const emoji = parseEmoji(cfg.emoji) ?? parseEmoji('⭐');
    const stars = await this.countStars(message, emoji);
    const threshold = Math.max(1, cfg.threshold ?? 3);
    const row = this.repo.get(guildId, messageId);
    const base = { guildId, messageId, channelId, authorId: message.author.id };

    if (stars >= threshold) {
      if (row?.star_message_id) {
        if (row.stars === stars) return 'unchanged';
        const edited = await this.#editCard(starChannel, row.star_message_id, message, stars, emoji);
        if (edited) {
          this.repo.upsert({ ...base, starMessageId: row.star_message_id, stars });
          return 'updated';
        }
      }
      const sent = await this.#sendCard(starChannel, message, stars, emoji);
      if (!sent) return null;
      this.repo.upsert({ ...base, starMessageId: sent.id, stars });
      return 'posted';
    }
    if (!row) return 'below';
    if (cfg.removeBelow !== false || !row.star_message_id) {
      this.repo.delete(guildId, messageId);
      if (row.star_message_id) await this.#deleteCard(guildId, row.star_message_id, starChannel);
      return 'removed';
    }
    if (row.stars !== stars && (await this.#editCard(starChannel, row.star_message_id, message, stars, emoji))) {
      this.repo.upsert({ ...base, starMessageId: row.star_message_id, stars });
      return 'updated';
    }
    return 'unchanged';
  }

  // ------------------------------------------------------------ carte

  /** Carte du starboard pour un message. */
  render(message, stars, emoji) {
    const author = message.author;
    const text = String(message.content ?? '').trim() || message.embeds?.[0]?.description || '';
    const image = firstImage(message);
    const extra = message.attachments?.size ? `${ICONS.image} ${message.attachments.size} pièce(s) jointe(s)` : null;
    const channelName = message.channel?.name ? `#${message.channel.name}` : 'message';
    const embed = card({
      tone: 'gold',
      section: { emoji: ICONS.star, label: 'Starboard' },
      icon: emoji.id ? ICONS.star : emoji.name,
      title: `${stars} · ${channelName}`,
      url: message.url,
      description: [text ? truncate(text, 3500) : '*Message sans texte.*', extra && !image ? `\n${extra}` : null],
      fields: [
        field(ICONS.user, 'Auteur', `<@${author.id}>`),
        field(ICONS.channel, 'Salon', `<#${message.channelId}>`),
        field(ICONS.date, 'Publié', message.createdTimestamp ? discordTimestamp(message.createdTimestamp, 'R') : null),
      ],
      thumbnail: author.displayAvatarURL?.({ size: 128 }) ?? null,
      image,
      footer: `Message ${message.id}`,
      timestamp: message.createdTimestamp || true,
    });
    return {
      embeds: fitEmbeds([embed]),
      components: message.url ? [new ActionRowBuilder().addComponents(linkButton('Aller au message', message.url, ICONS.link))] : [],
      // Le contenu d'un membre ne notifie jamais personne une seconde fois.
      allowedMentions: { parse: [] },
    };
  }

  #canSend(starChannel) {
    const me = starChannel.guild?.members?.me;
    const perms = me && starChannel.permissionsFor?.(me);
    return !perms || perms.has(SEND_PERMS);
  }

  async #sendCard(starChannel, message, stars, emoji) {
    if (!this.#canSend(starChannel)) {
      logger.debug(`Starboard ${starChannel.id} : permissions insuffisantes (voir, envoyer, intégrer des liens).`);
      return null;
    }
    try {
      return await starChannel.send(this.render(message, stars, emoji));
    } catch (err) {
      logger.debug(`Publication au starboard impossible (${starChannel.id}) :`, err?.message);
      return null;
    }
  }

  /** @returns {Promise<boolean>} faux si la carte n'existe plus (à recréer) */
  async #editCard(starChannel, starMessageId, message, stars, emoji) {
    try {
      const { allowedMentions: _ignored, ...payload } = this.render(message, stars, emoji);
      await starChannel.messages.edit(starMessageId, payload);
      return true;
    } catch (err) {
      if (!UNKNOWN.has(err?.code)) logger.debug(`Carte du starboard ${starMessageId} non modifiée :`, err?.message);
      return false;
    }
  }

  async #deleteCard(guildId, starMessageId, starChannel = null) {
    const ch = starChannel ?? this.client.guilds?.cache?.get(guildId)?.channels?.cache?.get(this.cfg(guildId).channelId);
    if (!ch?.messages) return;
    await ch.messages.delete(starMessageId).catch((err) => {
      if (!UNKNOWN.has(err?.code)) logger.debug(`Carte du starboard ${starMessageId} non supprimée :`, err?.message);
    });
  }
}

module.exports = { StarboardService, DEBOUNCE_MS, MIN_EDIT_INTERVAL_MS };
