'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { card, subtext, fitEmbeds } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { findBadWord } = require('../utils/automod/words');
const { extractLinks, extractInvites } = require('../utils/automod/links');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('afk');

const AFK_PREFIX = '[AFK] ';
/** Longueur maximale d'un pseudo Discord. */
const NICK_MAX = 32;
const MAX_REASON = 150;
/** Délai avant la réponse à une mention : laisse à l'AutoMod le temps de supprimer le message. */
const NOTICE_DELAY_MS = 1_000;
/** Durée d'affichage des réponses du bot (absence, retour). */
const NOTICE_TTL_MS = 10_000;
/** Au plus une réponse par membre absent et par salon sur cette durée. */
const NOTICE_COOLDOWN_MS = 30_000;
/** Membres absents cités au plus dans une même réponse. */
const MAX_NOTICE_MEMBERS = 5;
const PENDING_MAX = 200;
const DELETED_TTL_MS = 60_000;
const DELETED_MAX = 2_000;
const PRUNE_AT = 5_000;
const SECTION = { emoji: '💤', label: 'Absences' };

/**
 * Pseudo « [AFK] nom » de 32 caractères au plus : le nom est raccourci (« … ») au besoin.
 * Mesuré en unités UTF-16 (au moins aussi strict que la limite de Discord), sans couper un emoji. Pur.
 */
function afkNickname(base, max = NICK_MAX) {
  const name = String(base ?? '').trim() || 'membre';
  const room = max - AFK_PREFIX.length;
  if (name.length <= room) return `${AFK_PREFIX}${name}`;
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > room - 1) break;
    out += ch;
  }
  return `${AFK_PREFIX}${out.trimEnd()}…`;
}

/**
 * Raison d'absence : une ligne, 150 caractères au plus, sans @everyone/@here ni mention
 * de rôle, et — si l'AutoMod et le filtre correspondant sont actifs — sans mot interdit, lien
 * non autorisé ni invitation vers un autre serveur (le bot l'affiche : elle ne doit pas
 * contourner les filtres qu'un message ordinaire subit). Pur.
 * @param {string|null} raw
 * @param {object} [automod] configuration `automod` du serveur
 * @param {import('discord.js').Guild|null} [guild] serveur (invitation personnalisée tolérée)
 * @returns {string|null}
 */
function parseReason(raw, automod = {}, guild = null) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if ([...text].length > MAX_REASON) throw new UserError(`Raison : ${MAX_REASON} caractères au plus.`);
  if (/@(everyone|here)\b/i.test(text) || /<@&\d{17,20}>/.test(text)) throw new UserError('Raison : les mentions @everyone, @here et de rôle ne sont pas autorisées.');
  if (!automod?.enabled) return text;
  const filters = automod.filters ?? {};
  if (filters.badWords?.enabled && findBadWord(text, filters.badWords.words)) throw new UserError('Raison : elle contient un mot interdit sur ce serveur.');
  // Chargé à la demande : AutoModService dépend lui-même des services de logs et de modération.
  const { blockedLinks, blockedInvites } = require('./AutoModService');
  if (filters.antiLink?.enabled && blockedLinks(extractLinks(text), filters.antiLink).length) throw new UserError('Raison : les liens ne sont pas autorisés sur ce serveur.');
  if (filters.antiInvite?.enabled && blockedInvites(extractInvites(text), filters.antiInvite, guild).length) {
    throw new UserError('Raison : les invitations vers d\'autres serveurs ne sont pas autorisées sur ce serveur.');
  }
  return text;
}

/**
 * Raison affichée par le bot : tronquée, liens masqués « [texte](url) » neutralisés (crochets
 * échappés : le texte et l'adresse s'affichent tels quels, jamais un lien déguisé). Pur.
 */
function displayReason(reason, max = MAX_REASON) {
  return truncate(String(reason ?? ''), max).replace(/[[\]]/g, '\\$&');
}

/**
 * Le bot peut-il renommer ce membre ? null si oui, sinon la raison :
 * 'owner' (propriétaire du serveur), 'permission' (« Gérer les pseudos » manquante), 'hierarchy'.
 */
function nickBlocker(member) {
  const guild = member?.guild;
  if (!guild || !member.user) return 'hierarchy';
  if (member.id === guild.ownerId) return 'owner';
  const me = guild.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageNicknames)) return 'permission';
  if (member.id === me.id || !member.manageable) return 'hierarchy';
  return null;
}

/** Ligne d'un membre absent dans une réponse. */
function absenceLine(row) {
  return [`<@${row.user_id}> est **AFK** depuis ${discordTimestamp(row.since, 'R')}.`, row.reason ? `> ${displayReason(row.reason)}` : subtext('Aucune raison donnée.')].join('\n');
}

/**
 * Absences (/afk) : préfixe « [AFK] » sur le pseudo (si la hiérarchie le permet, restauré
 * au retour), réponse courte quand on mentionne un membre absent (1 fois / 30 s par membre
 * et par salon, supprimée après 10 s), retour automatique au premier message du membre.
 * Désactiver la fonction n'enferme personne : un membre encore absent revient toujours en écrivant.
 */
class AfkService {
  /**
   * @param {{ client?: object, afk: import('../database/repositories/AfkRepository').AfkRepository,
   *   config: import('./ConfigService').ConfigService, delayMs?: number, ttlMs?: number, cooldownMs?: number }} deps
   */
  constructor({ client, afk, config, delayMs = NOTICE_DELAY_MS, ttlMs = NOTICE_TTL_MS, cooldownMs = NOTICE_COOLDOWN_MS }) {
    this.client = client;
    this.repo = afk;
    this.config = config;
    this.delayMs = delayMs;
    this.ttlMs = ttlMs;
    this.cooldownMs = cooldownMs;
    /** Membres absents par serveur (chargés à la première utilisation) : guildId → Set. */
    this.users = new Map();
    /** Fin du cooldown : `${channelId}:${userId}` → ms. */
    this.cooldowns = new Map();
    this.deleted = new Map();
    /** Réponses en attente (délai post-AutoMod). */
    this.pending = new Set();
    /** Messages du bot à supprimer : minuteur → message. */
    this.expiring = new Map();
    this.stopped = false;
  }

  cfg(guildId) {
    return this.config.get(guildId).memberTools?.afk ?? {};
  }

  enabled(guildId) {
    return this.cfg(guildId).enabled !== false;
  }

  #absent(guildId) {
    let set = this.users.get(guildId);
    if (!set) this.users.set(guildId, (set = new Set(this.repo.userIds(guildId))));
    return set;
  }

  isAfk(guildId, userId) {
    return this.#absent(guildId).has(userId);
  }

  /** Raison validée selon l'AutoMod du serveur. */
  parseReason(guildId, raw) {
    return parseReason(raw, this.config.get(guildId).automod, this.client?.guilds?.cache?.get?.(guildId) ?? null);
  }

  /**
   * Marque le membre absent (ou met à jour sa raison s'il l'est déjà) et pose le préfixe.
   * @returns {Promise<{ row: object, updated: boolean, nick: 'set'|'kept'|'disabled'|'owner'|'permission'|'hierarchy'|'failed' }>}
   */
  async set(member, reason) {
    const guildId = member.guild.id;
    const existing = this.repo.get(guildId, member.id);
    if (existing) {
      this.repo.setReason(guildId, member.id, reason);
      this.#absent(guildId).add(member.id);
      return { row: this.repo.get(guildId, member.id), updated: true, nick: existing.afk_nick ? 'set' : 'kept' };
    }
    const row = this.repo.set({ guildId, userId: member.id, reason, since: Date.now(), oldNick: member.nickname ?? null });
    this.#absent(guildId).add(member.id);
    const nick = await this.#applyNick(member, row);
    return { row: this.repo.get(guildId, member.id) ?? row, updated: false, nick };
  }

  async #applyNick(member, row) {
    if (this.cfg(member.guild.id).nickname === false) return 'disabled';
    const blocker = nickBlocker(member);
    if (blocker) return blocker;
    const current = member.displayName ?? member.user?.username ?? '';
    if (current.startsWith(AFK_PREFIX.trim())) return 'kept';
    const nick = afkNickname(current);
    // Renommage du bot : le filtre des pseudos de l'AutoMod ne le prend pas pour un « dehoist ».
    this.#allowName(member, nick);
    try {
      await member.setNickname(nick, 'Absence (/afk)');
    } catch (err) {
      logger.debug(`Préfixe AFK impossible (${member.id}) :`, err?.message);
      return 'failed';
    }
    if (this.repo.setAfkNick(member.guild.id, member.id, nick)) return 'set';
    // Revenu entre-temps (message envoyé pendant le renommage) : pseudo d'origine rétabli.
    this.#allowName(member, row.old_nick ?? null);
    await member.setNickname(row.old_nick ?? null, 'Retour d\'absence').catch(() => {});
    return 'failed';
  }

  /** Signale à l'AutoMod (filtre des pseudos) un pseudo posé par le bot lui-même. */
  #allowName(member, nick) {
    this.client?.services?.automod?.allowName?.(member.guild.id, member.id, nick);
  }

  /** Pseudo « [AFK] … » posé par le bot pour un membre absent (null : aucun). */
  afkNickOf(guildId, userId) {
    if (!this.isAfk(guildId, userId)) return null;
    return this.repo.get(guildId, userId)?.afk_nick ?? null;
  }

  /**
   * Nom à vérifier par le filtre des pseudos de l'AutoMod : sans le préfixe « [AFK] » tant que
   * le pseudo est exactement celui posé par /afk (le préfixe n'est pas un « dehoist »).
   */
  nameWithoutPrefix(member, name) {
    const afkNick = member?.nickname ? this.afkNickOf(member.guild.id, member.id) : null;
    return afkNick && afkNick === member.nickname && name.startsWith(AFK_PREFIX) ? name.slice(AFK_PREFIX.length) : name;
  }

  /** Fin d'absence (synchrone : un second message du membre ne la termine pas deux fois). @returns {object|null} la ligne supprimée */
  #take(guildId, userId) {
    this.#absent(guildId).delete(userId);
    return this.repo.delete(guildId, userId);
  }

  async #restoreNick(member, row) {
    if (!row?.afk_nick || !member || (member.nickname ?? null) !== row.afk_nick || nickBlocker(member)) return false;
    this.#allowName(member, row.old_nick ?? null);
    try {
      await member.setNickname(row.old_nick ?? null, 'Retour d\'absence');
      return true;
    } catch (err) {
      logger.debug(`Pseudo non rétabli (${member.id}) :`, err?.message);
      return false;
    }
  }

  /** Départ du serveur : l'absence est oubliée (le pseudo de serveur disparaît avec le membre). */
  forget(guildId, userId) {
    return Boolean(this.#take(guildId, userId));
  }

  /** Nombre de membres absents (tableau de bord). */
  count(guildId) {
    return this.repo.count(guildId);
  }

  // ------------------------------------------------------------ messages

  /**
   * Point d'entrée messageCreate : retour automatique de l'auteur absent, puis réponse
   * (différée) aux mentions de membres absents.
   */
  handleMessage(message) {
    if (this.stopped || !message?.guild || !message.author || message.author.bot || message.webhookId || message.system) return;
    const guildId = message.guild.id;
    const absent = this.#absent(guildId);
    if (absent.has(message.author.id)) {
      const row = this.#take(guildId, message.author.id);
      if (row) {
        const member = message.member ?? message.guild.members.cache.get(message.author.id);
        this.#restoreNick(member, row).catch((err) => logger.debug(`Pseudo au retour (${guildId}) :`, err?.message));
        // « De retour » : même délai que les réponses aux mentions (message filtré par l'AutoMod : rien).
        this.#later(() => this.#welcomeBack(message, row).catch((err) => logger.debug(`Retour d'absence (${guildId}) :`, err?.message)));
      }
    }
    if (!absent.size || !this.enabled(guildId)) return;
    const targets = [...(message.mentions?.users?.values?.() ?? [])].filter((u) => !u.bot && u.id !== message.author.id && absent.has(u.id)).map((u) => u.id);
    if (!targets.length) return;
    this.#later(() => this.notice(message, targets).catch((err) => logger.debug(`Réponse d'absence (${guildId}) :`, err?.message)));
  }

  /** Exécute `fn` après le délai post-AutoMod (minuteur unref, annulé à l'arrêt ; borné). */
  #later(fn) {
    if (this.pending.size >= PENDING_MAX) return;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      fn();
    }, this.delayMs);
    timer.unref?.();
    this.pending.add(timer);
  }

  async #welcomeBack(message, row) {
    if (this.stopped || this.wasDeleted(message.id) || !this.enabled(message.guild.id)) return;
    const embed = card({
      tone: 'success',
      section: SECTION,
      icon: '👋',
      title: 'De retour',
      description: [`Bon retour ${message.author} : vous n'êtes plus AFK.`, subtext(`Absent depuis ${discordTimestamp(row.since, 'R')}.`)],
      timestamp: false,
    });
    await this.#post(message, embed);
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

  /** Réponse aux mentions de membres absents (cooldown par membre et par salon). @returns {Promise<string[]>} membres cités */
  async notice(message, userIds) {
    if (this.stopped || this.wasDeleted(message.id) || !this.enabled(message.guild.id)) return [];
    const now = Date.now();
    const rows = [];
    for (const userId of userIds) {
      const key = `${message.channelId}:${userId}`;
      if ((this.cooldowns.get(key) ?? 0) > now) continue;
      const row = this.repo.get(message.guild.id, userId);
      if (!row) continue;
      this.cooldowns.set(key, now + this.cooldownMs);
      rows.push(row);
      if (rows.length >= MAX_NOTICE_MEMBERS) break;
    }
    if (this.cooldowns.size > PRUNE_AT) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);
    if (!rows.length) return [];
    const embed = card({
      tone: 'neutral',
      section: SECTION,
      icon: '💤',
      title: rows.length > 1 ? 'Membres absents' : 'Membre absent',
      description: rows.map(absenceLine).join('\n\n'),
      timestamp: false,
    });
    await this.#post(message, embed);
    return rows.map((r) => r.user_id);
  }

  /** Réponse courte au message (sans notification), supprimée après `ttlMs`. */
  async #post(message, embed) {
    const channel = message.channel;
    const me = message.guild?.members?.me;
    const perms = me && channel?.permissionsFor?.(me);
    const send = channel?.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (!channel?.send || (perms && !perms.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.EmbedLinks]))) return null;
    const payload = { embeds: fitEmbeds([embed]), allowedMentions: { parse: [], repliedUser: false } };
    if (!perms || perms.has(PermissionFlagsBits.ReadMessageHistory)) payload.reply = { messageReference: message.id, failIfNotExists: false };
    const sent = await channel.send(payload).catch((err) => logger.debug(`Réponse d'absence non envoyée (${channel.id}) :`, err?.message));
    if (!sent) return null;
    if (this.stopped) {
      await sent.delete().catch(() => {});
      return sent;
    }
    const timer = setTimeout(() => {
      this.expiring.delete(timer);
      sent.delete().catch(() => {});
    }, this.ttlMs);
    timer.unref?.();
    this.expiring.set(timer, sent);
    return sent;
  }

  /** Arrêt : réponses en attente annulées, réponses affichées supprimées tout de suite. */
  async stop() {
    this.stopped = true;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    const messages = [...this.expiring.values()];
    for (const t of this.expiring.keys()) clearTimeout(t);
    this.expiring.clear();
    await Promise.allSettled(messages.map((m) => m.delete()));
  }
}

module.exports = { AfkService, afkNickname, parseReason, displayReason, nickBlocker, AFK_PREFIX, MAX_REASON, NOTICE_TTL_MS, NOTICE_COOLDOWN_MS };
