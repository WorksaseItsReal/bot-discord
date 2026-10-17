'use strict';

/** Durée de conservation en mémoire d'un message supprimé / modifié. */
const SNIPE_TTL_MS = 10 * 60_000;
/** Salons suivis au plus (les plus anciens sont oubliés au-delà). */
const MAX_CHANNELS = 2_000;
/** Texte conservé au plus (un message Nitro fait 4000 caractères). */
const MAX_CONTENT = 4_000;
/** Pièces jointes retenues au plus (noms seulement). */
const MAX_FILES = 10;

/** Salon (ou son parent / sa catégorie) ignoré par les logs de messages ? Pur. */
function isLogIgnored(cfg, channel) {
  const ignored = cfg?.logs?.ignoredChannels ?? [];
  if (!ignored.length || !channel) return false;
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && ignored.includes(id));
}

/** Message d'un membre (ni bot, ni webhook, ni message système) dont le contenu est connu ? */
function isEligible(message) {
  return Boolean(message?.guildId && !message.partial && message.author && !message.author.bot && !message.webhookId && !message.system);
}

/** Données conservées d'un message (texte, noms des pièces jointes, auteur). Pur. */
function snapshot(message) {
  const files = [...(message.attachments?.values?.() ?? [])].map((a) => String(a?.name ?? 'fichier')).slice(0, MAX_FILES);
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.author.username ?? message.author.tag ?? message.author.id,
    authorAvatar: message.author.displayAvatarURL?.() ?? null,
    content: String(message.content ?? '').slice(0, MAX_CONTENT),
    files,
    filesCount: message.attachments?.size ?? files.length,
    createdAt: message.createdTimestamp ?? null,
    url: message.url ?? null,
  };
}

/**
 * Snipe (/snipe) : dernier message supprimé et dernière modification de chaque salon,
 * gardés EN MÉMOIRE seulement (10 min, un de chaque par salon). Jamais : messages de
 * bots ou de webhooks, messages supprimés par l'AutoMod (marque `suppressed` du service
 * de logs lue sans être consommée), salons ignorés par les logs, serveurs où la fonction
 * est désactivée. Les suppressions groupées (purges) ne sont pas retenues.
 */
class SnipeService {
  /** @param {{ config: import('./ConfigService').ConfigService, client?: object, ttlMs?: number, maxChannels?: number }} deps */
  constructor({ client, config, ttlMs = SNIPE_TTL_MS, maxChannels = MAX_CHANNELS }) {
    this.client = client;
    this.config = config;
    this.ttlMs = ttlMs;
    this.maxChannels = maxChannels;
    /** channelId → { deleted?, edited? } (ordre d'insertion = ancienneté). */
    this.store = new Map();
  }

  enabled(guildId) {
    return this.config.get(guildId).memberTools?.snipe?.enabled !== false;
  }

  /** Supprimé par l'AutoMod ? (lecture SANS consommer : messageDelete.js en a besoin pour les logs) */
  suppressed(messageId) {
    const marks = this.client?.services?.logging?.suppressed;
    return Boolean(marks?.get?.(messageId) > Date.now());
  }

  #accepts(message) {
    if (!isEligible(message) || !this.enabled(message.guildId)) return false;
    return !isLogIgnored(this.config.get(message.guildId), message.channel);
  }

  #put(channelId, kind, entry) {
    const slot = this.store.get(channelId) ?? {};
    this.store.delete(channelId); // réinsertion : le salon devient le plus récent
    this.store.set(channelId, { ...slot, [kind]: { ...entry, kind, at: Date.now(), expiresAt: Date.now() + this.ttlMs } });
    if (this.store.size > this.maxChannels) this.prune();
  }

  /** Oublie les entrées expirées, puis les salons les plus anciens au-delà du plafond. */
  prune(now = Date.now()) {
    for (const [channelId, slot] of this.store) {
      for (const kind of ['deleted', 'edited']) if (slot[kind] && slot[kind].expiresAt <= now) delete slot[kind];
      if (!slot.deleted && !slot.edited) this.store.delete(channelId);
    }
    for (const channelId of this.store.keys()) {
      if (this.store.size <= this.maxChannels) break;
      this.store.delete(channelId);
    }
  }

  /** Retire toute trace d'un message (supprimé par l'AutoMod). */
  #drop(channelId, messageId) {
    const slot = this.store.get(channelId);
    if (!slot) return;
    for (const kind of ['deleted', 'edited']) if (slot[kind]?.messageId === messageId) delete slot[kind];
    if (!slot.deleted && !slot.edited) this.store.delete(channelId);
  }

  /** messageDelete. @returns {boolean} le message a été retenu */
  recordDelete(message) {
    if (!message?.guildId) return false;
    if (this.suppressed(message.id)) {
      this.#drop(message.channelId, message.id);
      return false;
    }
    if (!this.#accepts(message)) return false;
    const entry = snapshot(message);
    if (!entry.content && !entry.files.length) return false;
    this.#put(message.channelId, 'deleted', entry);
    return true;
  }

  /** messageUpdate (texte modifié seulement ; ancien contenu connu). @returns {boolean} */
  recordEdit(oldMessage, newMessage) {
    if (!oldMessage || oldMessage.partial || !this.#accepts(newMessage)) return false;
    const before = String(oldMessage.content ?? '');
    const after = String(newMessage.content ?? '');
    if (before === after) return false;
    this.#put(newMessage.channelId, 'edited', { ...snapshot(newMessage), before: before.slice(0, MAX_CONTENT), after: after.slice(0, MAX_CONTENT) });
    return true;
  }

  /**
   * Dernier message supprimé (`deleted`) ou modifié (`edited`) d'un salon, ou null.
   * @param {string} channelId
   * @param {'deleted'|'edited'} kind
   */
  get(channelId, kind = 'deleted') {
    const slot = this.store.get(channelId);
    const entry = slot?.[kind];
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      delete slot[kind];
      if (!slot.deleted && !slot.edited) this.store.delete(channelId);
      return null;
    }
    return entry;
  }

  /** Fonction désactivée sur un serveur : sa mémoire est vidée. @returns {number} salons oubliés */
  clearGuild(guildId) {
    let n = 0;
    for (const [channelId, slot] of this.store) {
      if ((slot.deleted ?? slot.edited)?.guildId === guildId) {
        this.store.delete(channelId);
        n += 1;
      }
    }
    return n;
  }

  clearChannel(channelId) {
    return this.store.delete(channelId);
  }

  stop() {
    this.store.clear();
  }
}

module.exports = { SnipeService, isLogIgnored, isEligible, snapshot, SNIPE_TTL_MS };
