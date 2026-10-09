'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { card, fitEmbeds } = require('../utils/ui');
const { createLogger } = require('../core/logger');

const logger = createLogger('sticky');

/** Intervalle minimal entre deux republications dans un même salon. */
const MIN_INTERVAL_MS = 15_000;
/** Attente après le N-ième message (une rafale ne republie qu'une fois). */
const SETTLE_MS = 2_000;
/** Sous le seuil de messages : republication quand même après ce délai d'activité. */
const IDLE_MS = 60_000;
/** Messages épinglés par serveur. */
const MAX_STICKIES = 25;
const MAX_CONTENT = 2_000;
const MAX_TITLE = 100;
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 50;
const UNKNOWN = new Set([10003, 10008]);

const SEND_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * Messages épinglés automatiquement (« sticky ») : un embed réaffiché en bas d'un salon
 * après de l'activité. Anti-rebond : au plus une republication toutes les 15 s par salon,
 * et seulement après N messages (ou, sous ce seuil, après une minute d'activité).
 * Les messages des bots comptent dans les N, mais une republication exige au moins un
 * message d'un MEMBRE depuis la précédente : deux bots « sticky » dans un même salon ne
 * se relancent jamais l'un l'autre.
 * Le message précédent est supprimé. Tout est en base (table sticky_messages) : après un
 * redémarrage, les salons où d'autres messages sont arrivés entre-temps sont rattrapés.
 */
class StickyService {
  /**
   * @param {{ client: import('discord.js').Client, sticky: import('../database/repositories/StickyRepository').StickyRepository,
   *   minIntervalMs?: number, settleMs?: number, idleMs?: number }} deps
   */
  constructor({ client, sticky, minIntervalMs = MIN_INTERVAL_MS, settleMs = SETTLE_MS, idleMs = IDLE_MS }) {
    this.client = client;
    this.repo = sticky;
    this.minIntervalMs = minIntervalMs;
    this.settleMs = settleMs;
    this.idleMs = idleMs;
    /** Ligne par salon (chargées à la première utilisation). @type {Map<string, object>|null} */
    this.rows = null;
    /** État par salon : { count, humans, firstAt, timer, dueAt, running, posting, lastPostAt }. */
    this.states = new Map();
    this.stopped = false;
  }

  #all() {
    if (!this.rows) this.rows = new Map(this.repo.all().map((r) => [r.channel_id, r]));
    return this.rows;
  }

  #state(channelId) {
    let s = this.states.get(channelId);
    if (!s) {
      s = { count: 0, humans: 0, firstAt: null, timer: null, dueAt: 0, running: null, posting: false, lastPostAt: 0 };
      this.states.set(channelId, s);
    }
    return s;
  }

  get(channelId) {
    return this.#all().get(channelId) ?? null;
  }

  list(guildId) {
    return [...this.#all().values()].filter((r) => r.guild_id === guildId);
  }

  // ------------------------------------------------------------ gestion

  /**
   * Définit (ou remplace) le message épinglé d'un salon et le publie tout de suite.
   * @returns {Promise<{ row: object, posted: boolean }>}
   */
  async set({ guildId, channel, title = null, content, threshold = 3, authorId = null }) {
    const existing = this.get(channel.id);
    if (!existing && this.list(guildId).length >= MAX_STICKIES) throw new Error(`${MAX_STICKIES} messages épinglés maximum`);
    const t = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.floor(Number(threshold) || 3)));
    const row = this.repo.upsert({ guildId, channelId: channel.id, title: title ? String(title).slice(0, MAX_TITLE) : null, content: String(content).slice(0, MAX_CONTENT), threshold: t, authorId });
    row.last_message_id = existing?.last_message_id ?? row.last_message_id ?? null;
    this.#all().set(channel.id, row);
    const s = this.#state(channel.id);
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const sent = await this.repost(channel.id);
    return { row, posted: Boolean(sent) };
  }

  /** Retire le message épinglé d'un salon (et supprime le dernier publié). */
  async remove(channelId) {
    const row = this.get(channelId);
    if (!row) return false;
    this.#all().delete(channelId);
    this.repo.delete(channelId);
    const s = this.states.get(channelId);
    if (s?.timer) clearTimeout(s.timer);
    if (s?.running) await s.running.catch(() => {});
    this.states.delete(channelId);
    const lastId = row.last_message_id;
    const channel = this.client.channels?.cache?.get(channelId);
    if (lastId && channel?.messages) {
      this.client.services?.logging?.suppressMessage?.(lastId);
      await channel.messages.delete(lastId).catch((err) => {
        if (!UNKNOWN.has(err?.code)) logger.debug(`Ancien message épinglé ${lastId} non supprimé :`, err?.message);
      });
    }
    return true;
  }

  // ------------------------------------------------------------ événements

  /** messageCreate : compte l'activité du salon et programme la republication. */
  handleMessage(message) {
    if (this.stopped || !message?.guildId) return false;
    const row = this.get(message.channelId);
    if (!row) return false;
    const s = this.#state(message.channelId);
    // Notre propre message épinglé (écho de la passerelle) ne compte pas comme activité.
    if (message.author?.id && message.author.id === this.client?.user?.id && (s.posting || message.id === row.last_message_id)) return false;
    s.count += 1;
    if (!message.author?.bot && !message.webhookId && !message.system) s.humans += 1;
    // Que des messages de bots : comptés, mais aucune republication (anti ping-pong entre bots).
    if (!s.humans) return true;
    s.firstAt ??= Date.now();
    this.#schedule(message.channelId);
    return true;
  }

  /** messageDelete : le message épinglé supprimé à la main sera republié à la prochaine activité. */
  handleDelete(message) {
    const row = message?.channelId ? this.get(message.channelId) : null;
    if (!row || row.last_message_id !== message.id) return;
    row.last_message_id = null;
    this.repo.setLastMessage(row.channel_id, null);
  }

  /** channelDelete : plus de salon, plus de message épinglé. */
  handleChannelDelete(channel) {
    if (!channel?.id || !this.get(channel.id)) return;
    const s = this.states.get(channel.id);
    if (s?.timer) clearTimeout(s.timer);
    this.states.delete(channel.id);
    this.#all().delete(channel.id);
    this.repo.delete(channel.id);
  }

  /**
   * Au démarrage : les salons dont le dernier message n'est plus le message épinglé
   * (activité pendant l'arrêt) sont republiés, avec l'anti-rebond habituel.
   * @returns {number} salons rattrapés
   */
  resume() {
    let n = 0;
    for (const row of this.#all().values()) {
      const channel = this.client.channels?.cache?.get(row.channel_id);
      if (!channel?.isTextBased?.()) continue;
      if (row.last_message_id && channel.lastMessageId === row.last_message_id) continue;
      const s = this.#state(row.channel_id);
      s.count = Math.max(s.count, row.threshold);
      s.humans = Math.max(s.humans, 1); // auteurs inconnus pendant l'arrêt : rattrapage
      s.firstAt ??= Date.now();
      this.#schedule(row.channel_id);
      n += 1;
    }
    return n;
  }

  // ------------------------------------------------------------ anti-rebond

  #schedule(channelId) {
    const row = this.get(channelId);
    if (!row || this.stopped) return;
    const s = this.#state(channelId);
    const now = Date.now();
    const earliest = s.lastPostAt + this.minIntervalMs;
    const due = s.count >= row.threshold ? Math.max(now + this.settleMs, earliest) : Math.max((s.firstAt ?? now) + this.idleMs, earliest);
    if (s.timer && s.dueAt <= due) return;
    if (s.timer) clearTimeout(s.timer);
    s.dueAt = due;
    s.timer = setTimeout(() => this.#fire(channelId), Math.max(0, due - now));
    s.timer.unref?.();
  }

  #fire(channelId) {
    const s = this.states.get(channelId);
    if (!s || this.stopped) return;
    s.timer = null;
    if (s.running) {
      // Republication en cours : on retentera après elle (l'activité reste comptée).
      s.running.finally(() => s.count > 0 && s.humans > 0 && this.#schedule(channelId));
      return;
    }
    if (s.count > 0 && s.humans > 0) this.repost(channelId);
  }

  /**
   * Publie le message épinglé en bas du salon, puis supprime le précédent.
   * Sérialisé par salon. @returns {Promise<import('discord.js').Message|null>}
   */
  repost(channelId) {
    const s = this.#state(channelId);
    if (s.running) return s.running.then(() => this.repost(channelId));
    s.running = this.#post(channelId)
      .catch((err) => {
        logger.warn(`Message épinglé non republié (${channelId}) :`, err?.message);
        return null;
      })
      .finally(() => {
        s.running = null;
      });
    return s.running;
  }

  async #post(channelId) {
    const row = this.get(channelId);
    const channel = this.client.channels?.cache?.get(channelId);
    if (!row || this.stopped || !channel?.isTextBased?.() || !channel.send) return null;
    const me = channel.guild?.members?.me;
    const perms = me && channel.permissionsFor?.(me);
    if (perms && !perms.has(SEND_PERMS)) {
      logger.debug(`Salon ${channelId} : permissions insuffisantes pour le message épinglé.`);
      return null;
    }
    const s = this.#state(channelId);
    s.posting = true;
    let sent;
    try {
      sent = await channel.send(this.render(row));
    } finally {
      s.posting = false;
    }
    // Retiré pendant l'envoi (/sticky retirer) : on ne laisse rien derrière.
    if (this.get(channelId) !== row) {
      await sent.delete().catch(() => {});
      return null;
    }
    const previous = row.last_message_id;
    row.last_message_id = sent.id;
    this.repo.setLastMessage(channelId, sent.id);
    s.count = 0;
    s.humans = 0;
    s.firstAt = null;
    s.lastPostAt = Date.now();
    if (previous && previous !== sent.id) {
      // Suppression par le bot : pas de « Message supprimé » dans les logs (message hors cache).
      this.client.services?.logging?.suppressMessage?.(previous);
      await channel.messages.delete(previous).catch((err) => {
        if (!UNKNOWN.has(err?.code)) logger.debug(`Ancien message épinglé ${previous} non supprimé :`, err?.message);
      });
    }
    return sent;
  }

  /** Embed du message épinglé. */
  render(row) {
    return {
      embeds: fitEmbeds([
        card({
          tone: 'info',
          section: { emoji: '📌', label: 'Message épinglé' },
          title: row.title || undefined,
          description: row.content,
          footer: 'Message épinglé automatiquement',
          timestamp: false,
        }),
      ]),
      allowedMentions: { parse: [] },
    };
  }

  /** Arrêt propre : minuteurs annulés, republications en cours attendues. */
  async stop() {
    this.stopped = true;
    const running = [];
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      if (s.running) running.push(s.running);
    }
    await Promise.allSettled(running);
  }
}

module.exports = { StickyService, MAX_STICKIES, MAX_CONTENT, MAX_TITLE, MIN_THRESHOLD, MAX_THRESHOLD, MIN_INTERVAL_MS };
