'use strict';

const { card, field, ICONS, userLine, subtext, linkButton, buttonRows, fitEmbeds } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { buildIndex, findMatches, keywordKey, quoteExcerpt, MIN_KEYWORD, MAX_KEYWORD, MAX_KEYWORDS } = require('../utils/highlights');
const { isNsfwChannel } = require('../utils/community');
const { canRead, canReadCached } = require('../utils/channelAccess');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('highlights');

/** Délai avant les MP : laisse à l'AutoMod le temps de supprimer le message (cf. AutoResponderService). */
const ALERT_DELAY_MS = 1_500;
/** Au plus une alerte par (membre, salon) sur cette durée. */
const COOLDOWN_MS = 5 * 60_000;
/** Pas d'alerte si le membre a écrit dans le salon depuis moins de cette durée (il suit la conversation). */
const ACTIVITY_MS = 5 * 60_000;
/** Échecs d'envoi en MP d'affilée avant la pause automatique. */
const MAX_DM_FAILURES = 3;
/** Garde-fou : MP envoyés au plus pour un même message. */
const MAX_DMS_PER_MESSAGE = 20;
/** Garde-fou : membres hors cache récupérés au plus pour un même message (requêtes à Discord). */
const MAX_FETCHES_PER_MESSAGE = 10;
/** Salons et membres bloqués au plus (par membre). */
const MAX_BLOCKED = 25;
const PENDING_MAX = 500;
const DELETED_TTL_MS = 60_000;
const DELETED_MAX = 2_000;
const PRUNE_AT = 5_000;
/** paused : 0 actives · 1 en pause (membre) · 2 en pause automatique (MP fermés). */
const PAUSE = Object.freeze({ active: 0, manual: 1, auto: 2 });
const SECTION = { emoji: '🔔', label: 'Alertes' };

/**
 * Valide un mot-clé saisi : 3 à 40 caractères, au moins 3 lettres ou chiffres. Pur.
 * @returns {{ display: string, key: string }}
 */
function parseKeyword(raw) {
  const display = String(raw ?? '').trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(display)) throw new UserError('Mot-clé : caractères invalides.');
  if ([...display].length < MIN_KEYWORD || [...display].length > MAX_KEYWORD) throw new UserError(`Mot-clé : de ${MIN_KEYWORD} à ${MAX_KEYWORD} caractères.`);
  const key = keywordKey(display);
  if (key.replace(/ /g, '').length < MIN_KEYWORD) throw new UserError(`Mot-clé : au moins ${MIN_KEYWORD} lettres ou chiffres.`);
  return { display, key };
}

/** Le membre peut-il lire ce salon d'après le cache (fils : salon parent ; fil privé : membre du fil) ? */
const canSee = (channel, member) => canReadCached(channel, member);

/** Salon (ou son parent / sa catégorie) dans un ensemble d'identifiants ? */
const inChannelSet = (channel, set) => Boolean(set.size) && [channel?.id, channel?.parentId, channel?.parent?.parentId].some((id) => id && set.has(id));

/** Carte envoyée en MP au membre alerté. */
function alertCard(message, words) {
  const files = message.attachments?.size ?? 0;
  const label = words.map((w) => `« ${w} »`).join(', ');
  return card({
    tone: 'info',
    section: SECTION,
    icon: '🔔',
    title: truncate(words.length > 1 ? `Mots-clés mentionnés : ${label}` : `Mot-clé mentionné : ${label}`, 200),
    url: message.url,
    description: [
      quoteExcerpt(message.content) || '*Message sans texte*',
      files ? subtext(`📎 ${files} pièce(s) jointe(s)`) : null,
    ],
    fields: [
      field(ICONS.user, 'Auteur', userLine(message.author)),
      field(ICONS.channel, 'Salon', `${message.channel}`),
      field(ICONS.server, 'Serveur', truncate(message.guild?.name ?? '—', 100)),
    ],
    thumbnail: message.author?.displayAvatarURL?.() ?? null,
    footer: 'Gérer vos alertes : /alertes liste',
    timestamp: message.createdTimestamp ?? true,
  });
}

/**
 * Alertes de mots-clés : un membre reçoit un MP quand un AUTRE membre écrit l'un de ses
 * mots-clés dans un salon qu'il peut lire. Index en mémoire par serveur (mot → membres),
 * reconstruit à chaque modification. Délai post-AutoMod, cooldown par (membre, salon),
 * silence si le membre participe déjà à la conversation, pause automatique si ses MP
 * sont fermés.
 */
class HighlightService {
  /**
   * @param {{ client?: object, highlights: import('../database/repositories/HighlightRepository').HighlightRepository,
   *   config: import('./ConfigService').ConfigService, delayMs?: number, cooldownMs?: number, activityMs?: number, maxDms?: number }} deps
   */
  constructor({ client, highlights, config, delayMs = ALERT_DELAY_MS, cooldownMs = COOLDOWN_MS, activityMs = ACTIVITY_MS, maxDms = MAX_DMS_PER_MESSAGE }) {
    this.client = client;
    this.repo = highlights;
    this.config = config;
    this.delayMs = delayMs;
    this.cooldownMs = cooldownMs;
    this.activityMs = activityMs;
    this.maxDms = maxDms;
    /** Index par serveur. */
    this.indexes = new Map();
    /** Fin du cooldown : `${guildId}:${userId}:${channelId}` → ms. */
    this.cooldowns = new Map();
    /** Dernier message d'un membre (ayant des alertes) dans un salon : `${channelId}:${userId}` → ms. */
    this.activity = new Map();
    this.deleted = new Map();
    this.pending = new Set();
    this.stopped = false;
  }

  enabled(guildId) {
    return this.config.get(guildId).memberTools?.highlights?.enabled !== false;
  }

  // ------------------------------------------------------------ index

  /** Index du serveur (construit à la première utilisation). */
  index(guildId) {
    return this.indexes.get(guildId) ?? this.rebuild(guildId);
  }

  /** Reconstruit l'index d'un serveur depuis la base. */
  rebuild(guildId) {
    const index = buildIndex(this.repo.listByGuild(guildId));
    this.indexes.set(guildId, index);
    return index;
  }

  // ------------------------------------------------------------ gestion (commande /alertes)

  /** Entrée d'un membre (vide s'il n'en a pas). */
  entry(guildId, userId) {
    return this.repo.get(guildId, userId) ?? { guildId, userId, words: [], blockedChannels: [], blockedUsers: [], paused: PAUSE.active, dmFailures: 0 };
  }

  #save(entry) {
    const saved = this.repo.save(entry);
    this.rebuild(entry.guildId);
    return saved;
  }

  /** @returns {{ entry: object, word: string }} */
  addWord(guildId, userId, raw) {
    const { display, key } = parseKeyword(raw);
    const entry = this.entry(guildId, userId);
    if (entry.words.some((w) => keywordKey(w) === key)) throw new UserError(`« ${display} » figure déjà dans vos alertes.`);
    if (entry.words.length >= MAX_KEYWORDS) throw new UserError(`${MAX_KEYWORDS} mots-clés au plus : retirez-en un d'abord.`);
    return { entry: this.#save({ ...entry, words: [...entry.words, display] }), word: display };
  }

  /** @returns {{ entry: object, word: string }} */
  removeWord(guildId, userId, raw) {
    const entry = this.entry(guildId, userId);
    const text = String(raw ?? '').trim();
    const key = keywordKey(text);
    const word = entry.words.find((w) => w === text) ?? entry.words.find((w) => key && keywordKey(w) === key);
    if (!word) throw new UserError('Ce mot-clé ne figure pas dans vos alertes.');
    return { entry: this.#save({ ...entry, words: entry.words.filter((w) => w !== word) }), word };
  }

  /** Pause manuelle (true) ou reprise (false, remet aussi le compteur d'échecs à zéro). */
  setPaused(guildId, userId, paused) {
    const entry = this.entry(guildId, userId);
    return this.#save({ ...entry, paused: paused ? PAUSE.manual : PAUSE.active, dmFailures: 0 });
  }

  /** Bloque ou débloque un salon (bascule). @returns {{ entry: object, blocked: boolean }} */
  toggleChannel(guildId, userId, channelId) {
    const entry = this.entry(guildId, userId);
    const blocked = !entry.blockedChannels.includes(channelId);
    if (blocked && entry.blockedChannels.length >= MAX_BLOCKED) throw new UserError(`${MAX_BLOCKED} salons bloqués au plus.`);
    const blockedChannels = blocked ? [...entry.blockedChannels, channelId] : entry.blockedChannels.filter((id) => id !== channelId);
    return { entry: this.#save({ ...entry, blockedChannels }), blocked };
  }

  /** Bloque ou débloque un membre (bascule). @returns {{ entry: object, blocked: boolean }} */
  toggleUser(guildId, userId, targetId) {
    const entry = this.entry(guildId, userId);
    const blocked = !entry.blockedUsers.includes(targetId);
    if (blocked && entry.blockedUsers.length >= MAX_BLOCKED) throw new UserError(`${MAX_BLOCKED} membres bloqués au plus.`);
    const blockedUsers = blocked ? [...entry.blockedUsers, targetId] : entry.blockedUsers.filter((id) => id !== targetId);
    return { entry: this.#save({ ...entry, blockedUsers }), blocked };
  }

  /** Remplace la liste des salons bloqués (menu de la vue « liste »). */
  setBlockedChannels(guildId, userId, ids) {
    return this.#save({ ...this.entry(guildId, userId), blockedChannels: [...new Set(ids)].slice(0, MAX_BLOCKED) });
  }

  /** Remplace la liste des membres bloqués (menu de la vue « liste »). */
  setBlockedUsers(guildId, userId, ids) {
    return this.#save({ ...this.entry(guildId, userId), blockedUsers: [...new Set(ids)].filter((id) => id !== userId).slice(0, MAX_BLOCKED) });
  }

  /** Départ du serveur : les alertes du membre sont effacées. */
  forget(guildId, userId) {
    if (!this.repo.delete(guildId, userId)) return false;
    this.rebuild(guildId);
    return true;
  }

  /** Statistiques du serveur (tableau de bord). */
  stats(guildId) {
    const entries = this.repo.listByGuild(guildId).filter((e) => e.words.length);
    return { members: entries.length, words: entries.reduce((n, e) => n + e.words.length, 0), paused: entries.filter((e) => e.paused).length };
  }

  // ------------------------------------------------------------ messages

  /**
   * Point d'entrée messageCreate (synchrone) : suit l'activité des membres alertables et
   * programme les MP `delayMs` plus tard (abandonnés si le message est supprimé entre-temps).
   * @returns {boolean} des alertes ont été programmées
   */
  handleMessage(message) {
    if (this.stopped || !message?.guild || !message.author || message.author.bot || message.webhookId || message.system) return false;
    const guildId = message.guild.id;
    if (!this.enabled(guildId)) return false;
    const index = this.index(guildId);
    if (!index.members.size) return false;
    const now = Date.now();
    if (index.members.has(message.author.id)) this.#touch(message.channelId, message.author.id, now);
    if (!message.content || this.pending.size >= PENDING_MAX) return false;
    const hits = findMatches(index, message.content);
    hits.delete(message.author.id);
    if (!hits.size) return false;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      this.process(message, hits).catch((err) => logger.warn(`Alertes impossibles (${guildId}) :`, err?.message));
    }, this.delayMs);
    timer.unref?.();
    this.pending.add(timer);
    return true;
  }

  #touch(channelId, userId, now) {
    this.activity.set(`${channelId}:${userId}`, now);
    if (this.activity.size > PRUNE_AT) for (const [k, at] of this.activity) if (at <= now - this.activityMs) this.activity.delete(k);
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

  /**
   * Après le délai : revérifie chaque membre (pause, blocages, cooldown, activité, accès au
   * salon) puis envoie les MP. @returns {Promise<number>} MP envoyés
   */
  async process(message, hits) {
    const guild = message.guild;
    const channel = message.channel;
    if (this.stopped || !guild || !channel || this.wasDeleted(message.id) || !this.enabled(guild.id)) return 0;
    // Le contenu d'un salon NSFW ne part jamais en MP.
    if (isNsfwChannel(channel)) return 0;
    const index = this.index(guild.id); // relu : pauses et blocages récents pris en compte
    let sent = 0;
    let fetches = 0;
    for (const [userId, keys] of hits) {
      if (this.stopped || sent >= this.maxDms) break;
      const settings = index.members.get(userId);
      if (!settings || userId === message.author.id) continue;
      // Mots-clés retirés pendant le délai : ignorés.
      const words = [...keys].filter((k) => settings.words.has(k)).map((k) => settings.words.get(k));
      if (!words.length) continue;
      if (settings.blockedUsers.has(message.author.id) || inChannelSet(channel, settings.blockedChannels)) continue;
      const now = Date.now();
      const coolKey = `${guild.id}:${userId}:${channel.id}`;
      if ((this.cooldowns.get(coolKey) ?? 0) > now) continue;
      if ((this.activity.get(`${channel.id}:${userId}`) ?? 0) > now - this.activityMs) continue;
      let member = guild.members.cache.get(userId);
      if (!member && fetches < MAX_FETCHES_PER_MESSAGE) {
        fetches += 1;
        member = await guild.members.fetch(userId).catch(() => null);
      }
      // Fil privé : appartenance vérifiée auprès de Discord si le cache des membres du fil l'ignore.
      if (!member || member.user?.bot || !(await canRead(channel, member))) continue;
      this.cooldowns.set(coolKey, now + this.cooldownMs);
      if (await this.notify(member, message, words)) sent += 1;
    }
    const now = Date.now();
    if (this.cooldowns.size > PRUNE_AT) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);
    return sent;
  }

  /** MP d'alerte. Trois échecs d'affilée (MP fermés) mettent les alertes du membre en pause. */
  async notify(member, message, words) {
    const guildId = message.guild.id;
    try {
      await member.send({
        embeds: fitEmbeds([alertCard(message, words)]),
        components: buttonRows(linkButton('Aller au message', message.url, ICONS.link)),
        allowedMentions: { parse: [] },
      });
      this.repo.resetFailures(guildId, member.id);
      return true;
    } catch (err) {
      if (err?.code === 50007) {
        const failures = this.repo.recordFailure(guildId, member.id);
        if (failures >= MAX_DM_FAILURES) {
          this.repo.setPaused(guildId, member.id, PAUSE.auto);
          this.rebuild(guildId);
          logger.info(`Alertes de ${member.id} mises en pause sur ${guildId} : MP fermés (${failures} échecs).`);
        }
      } else {
        logger.debug(`Alerte non envoyée à ${member.id} :`, err?.message);
      }
      return false;
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}

module.exports = { HighlightService, parseKeyword, canSee, alertCard, PAUSE, MAX_BLOCKED, MAX_DM_FAILURES, ALERT_DELAY_MS, COOLDOWN_MS, ACTIVITY_MS };
