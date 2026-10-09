'use strict';

const { ChannelType, MessageType, MessageFlags, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { createLogger } = require('../core/logger');
const { applyRoles } = require('../utils/memberRoles');
const { card, fitEmbeds, field, ICONS } = require('../utils/ui');
const { discordTimestamp } = require('../utils/time');
const { hasForbiddenPermissions } = require('../commands/roles/rolemenu');
const { escapeMassMentions } = require('./WelcomeService');
const { channelIssue } = require('./AnnouncementService');
const { logCard } = require('./LoggingService');

const logger = createLogger('automations');

/** Délai avant d'agir sur un message : laisse à l'AutoMod le temps de le supprimer. */
const DELAY_MS = 1_500;
/** Limite de Discord : 10 publications (crosspost) par heure et par salon. */
const CROSSPOST_LIMIT = 10;
const CROSSPOST_WINDOW_MS = 3_600_000;
/** Messages en attente de publication au plus, par salon. */
const CROSSPOST_QUEUE_MAX = 25;
/** Un même avertissement (permission, file pleine) au plus une fois par heure et par salon. */
const WARN_EVERY_MS = 3_600_000;
const BOOST_DEDUP_MS = 10 * 60_000;
/** Fils automatiques : créations en attente au plus par salon, puis un fil par membre et par salon toutes les 30 s. */
const THREAD_PENDING_MAX = 5;
const THREAD_COOLDOWN_MS = 30_000;
/**
 * Rôle vocal : discord.js ne met PAS à jour le membre en cache après un PUT / DELETE de rôle
 * (seulement à la réception de GUILD_MEMBER_UPDATE). Dans les 15 s qui suivent l'un de nos
 * changements, les rôles du membre sont donc relus auprès de Discord (fetch forcé) avant de
 * décider : sans cela, une connexion puis une déconnexion rapides laissaient le rôle (et
 * l'inverse le retirait).
 */
const VOICE_FRESH_MS = 15_000;
/** Rattrapage périodique du rôle vocal (étape du scheduler), et délai minimal entre deux rattrapages déclenchés par un événement. */
const VOICE_RECONCILE_EVERY_MS = 15 * 60_000;
const VOICE_RECONCILE_DEBOUNCE_MS = 60_000;
/** Serveurs rattrapés au plus par passage du scheduler. */
const VOICE_RECONCILE_PER_TICK = 5;
const MAX_CHANNELS = 25;
const MAX_VOICE_LINKS = 10;
const MAX_TEMPLATE = 100;
const MAX_BOOST_MESSAGE = 1000;
const TEXT_TYPES = Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const VOICE_TYPES = Object.freeze([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const ARCHIVE_DURATIONS = Object.freeze({ 60: '1 heure', 1440: '24 heures', 4320: '3 jours', 10080: '1 semaine' });
const THREAD_MODES = Object.freeze({ all: 'Tous les messages', media: 'Messages avec image ou lien' });
const DEFAULT_THREAD_NAME = 'Discussion de {pseudo}';
const DEFAULT_BOOST_MESSAGE = '💎 Merci {membre} pour ce boost ! **{serveur}** compte désormais **{boosts}** boost(s).';
const BOOST_VARIABLES = Object.freeze({ membre: 'mention du membre', serveur: 'nom du serveur', boosts: 'nombre de boosts' });

// ---------------------------------------------------------------- fonctions pures

/**
 * Changement de boost d'un membre (premiumSince) : 'start', 'end' ou null. Ancien état
 * inconnu (membre partiel) : null. Source unique pour le log de boost et le remerciement.
 */
function boostChange(oldMember, newMember) {
  if (!oldMember || !newMember || oldMember.partial) return null;
  const before = Boolean(oldMember.premiumSince ?? oldMember.premiumSinceTimestamp);
  const after = Boolean(newMember.premiumSince ?? newMember.premiumSinceTimestamp);
  if (!before && after) return 'start';
  if (before && !after) return 'end';
  return null;
}

/** Nom de fil : {pseudo} et {n}, une ligne, 100 caractères au plus. Pur. */
function renderThreadName(template, { pseudo, n }) {
  const raw = String(template || DEFAULT_THREAD_NAME)
    .replace(/\{pseudo\}/gi, String(pseudo ?? 'membre'))
    .replace(/\{n\}/gi, String(n ?? 1));
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || `Discussion ${n ?? 1}`).slice(0, 100);
}

/** Variables inconnues d'un modèle (parmi `allowed`). Pur. */
function unknownVariables(template, allowed) {
  const found = [...String(template ?? '').matchAll(/\{([\p{L}\w]{1,30})\}/gu)].map((m) => m[1].toLowerCase());
  return [...new Set(found.filter((k) => !allowed.includes(k)))];
}

const LINK_RE = /https?:\/\/\S/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov)(\?|$)/i;

/** Le message contient-il une image / vidéo ou un lien ? Pur. */
function hasMediaOrLink(message) {
  if (LINK_RE.test(message?.content ?? '')) return true;
  for (const a of message?.attachments?.values?.() ?? []) {
    if (/^(image|video)\//i.test(a.contentType ?? '') || MEDIA_EXT.test(a.name ?? a.url ?? '')) return true;
  }
  return (message?.embeds ?? []).some((e) => e?.image || e?.thumbnail || e?.video);
}

/**
 * Message du bot à NE PAS publier : avertissement adressé à un membre (AutoMod, niveau,
 * rappel… : contenu qui mentionne un utilisateur) ou message épinglé automatiquement (/sticky,
 * republié à chaque activité). Les publications voulues (flux, annonces) sont publiées.
 */
function isTransientOwnMessage(message, client) {
  if (message?.author?.id !== client?.user?.id) return false;
  if (/<@!?\d{17,20}>/.test(message.content ?? '')) return true;
  return client?.services?.sticky?.get?.(message.channelId)?.last_message_id === message.id;
}

/** Rôles « vocaux » gérés par la configuration (global + par salon). Pur. */
function managedVoiceRoles(cfg) {
  return [...new Set([cfg?.roleId, ...(cfg?.channels ?? []).map((l) => l.roleId)].filter(Boolean))];
}

/** Rôles voulus pour un membre dans `channelId` (null : hors vocal). Pur. */
function desiredVoiceRoles(cfg, channelId) {
  if (!channelId || !cfg?.enabled) return [];
  const out = [];
  if (cfg.roleId) out.push(cfg.roleId);
  const link = (cfg.channels ?? []).find((l) => l.channelId === channelId);
  if (link?.roleId) out.push(link.roleId);
  return [...new Set(out)];
}

/** Message de remerciement : {membre} {serveur} {boosts} ; @everyone/@here neutralisés. Pur. */
function renderBoostMessage(template, { id, server, boosts }) {
  const text = String(template || DEFAULT_BOOST_MESSAGE)
    .replace(/\{membre\}/gi, id ? `<@${id}>` : 'membre')
    .replace(/\{serveur\}/gi, escapeMarkdown(String(server ?? 'le serveur')))
    .replace(/\{boosts\}/gi, String(boosts ?? 0));
  return escapeMassMentions(text).slice(0, 2000);
}

/** Carte publiée pour un boost. Pur. */
function boostPayload(text, { userId, avatar = null } = {}) {
  return {
    content: userId ? `<@${userId}>` : undefined,
    embeds: fitEmbeds([card({ tone: 'celebrate', icon: ICONS.boost, title: 'Merci pour le boost !', description: text, thumbnail: avatar })]),
    allowedMentions: { parse: [], users: userId ? [userId] : [] },
  };
}

/** Le bot peut-il gérer ce rôle ? (« Gérer les rôles » et hiérarchie) Message, ou null. Pur. */
function botRoleIssue(guild, role) {
  const me = guild.members?.me;
  if (me && !me.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return 'il me faut la permission **Gérer les rôles**';
  if (me && role.position >= me.roles.highest.position) return `le rôle ${role.name} est au-dessus (ou au niveau) de mon rôle le plus haut`;
  return null;
}

/**
 * Rôle attribuable automatiquement ? Refuse @everyone, les rôles gérés par une intégration,
 * les rôles sensibles (modération / administration), et vérifie la hiérarchie du bot ET de
 * l'auteur (sauf propriétaire du serveur). Message, ou null. Pur.
 */
function assignableRoleIssue(guild, role, actor = null) {
  if (!role) return 'Ce rôle n\'existe plus.';
  if (role.id === guild.id) return 'Le rôle @everyone ne peut pas être attribué.';
  if (role.managed) return `Le rôle ${role.name} est géré par une intégration (bot, boost…) : choisissez un autre rôle.`;
  if (hasForbiddenPermissions(role)) return `Le rôle ${role.name} donne des permissions de modération ou d'administration : il ne peut pas être attribué automatiquement.`;
  const bot = botRoleIssue(guild, role);
  if (bot) return `Je ne peux pas attribuer ${role.name} : ${bot}.`;
  if (actor && actor.id !== guild.ownerId && role.position >= (actor.roles?.highest?.position ?? 0)) {
    return `Le rôle ${role.name} est au-dessus (ou au niveau) de votre rôle le plus haut.`;
  }
  return null;
}

/** Rôles utilisables sans erreur parmi `ids` (existants, attribuables par le bot). */
function usableRoles(guild, ids) {
  return ids.filter((id) => {
    const role = guild.roles?.cache?.get(id);
    return role && role.id !== guild.id && !role.managed && !hasForbiddenPermissions(role) && !botRoleIssue(guild, role);
  });
}

// ---------------------------------------------------------------- service

/**
 * Automatisations (/automatisations) :
 *  - publication automatique (crosspost) des messages des salons d'annonces choisis, avec file
 *    d'attente respectant la limite de Discord (10 par heure et par salon) ;
 *  - fil automatique sous chaque message (ou chaque message avec image / lien) ;
 *  - rôle vocal porté tant qu'un membre est en vocal (global ou par salon), rattrapé au démarrage ;
 *  - remerciement de boost (message + rôle facultatif), détecté sur guildMemberUpdate.
 * La présence du bot (statuts tournants) est globale : voir utils/presence.js.
 */
class AutomationService {
  /**
   * @param {{ client: import('discord.js').Client, config: import('./ConfigService').ConfigService, counters: import('../database/repositories/AutoThreadCounterRepository').AutoThreadCounterRepository, delayMs?: number }} deps
   */
  constructor({ client, config, counters, delayMs = DELAY_MS }) {
    this.client = client;
    this.config = config;
    this.counters = counters;
    this.delayMs = delayMs;
    this.crosspostLimit = CROSSPOST_LIMIT;
    this.crosspostWindowMs = CROSSPOST_WINDOW_MS;
    /** Salon → { sent: number[], items: Message[], timer, warnedAt } */
    this.queues = new Map();
    /** Avertissements déjà émis : clé → date. */
    this.warned = new Map();
    /** Changements de rôles vocaux sérialisés par membre. */
    this.voiceChains = new Map();
    this.boostSeen = new Map();
    /** Dernier changement de rôle vocal fait par nous : `<serveur>:<membre>` → date. */
    this.voiceChangedAt = new Map();
    /** Dernier rattrapage du rôle vocal par serveur (et dernière demande déclenchée par un événement). */
    this.voiceReconciledAt = new Map();
    this.voiceRequestedAt = new Map();
    this.startedAt = Date.now();
    /** Fils automatiques : créations en attente par salon, et prochain fil permis par `<salon>:<membre>`. */
    this.threadPending = new Map();
    this.threadCooldowns = new Map();
    this.threadCooldownMs = THREAD_COOLDOWN_MS;
    this.timers = new Set();
    this.background = new Set();
    this.stopped = false;
  }

  settings(guildId) {
    return this.config.get(guildId).automations ?? {};
  }

  // ------------------------------------------------------------ messages

  /** Point d'entrée messageCreate : rien n'est fait tout de suite (AutoMod d'abord). */
  handleMessage(message) {
    if (this.stopped || !message?.guild || message.system) return false;
    const cfg = this.settings(message.guildId);
    const type = message.channel?.type;
    const crosspost = Boolean(
      cfg.crosspost?.enabled
      && type === ChannelType.GuildAnnouncement
      && (cfg.crosspost.channels ?? []).includes(message.channelId)
      && message.type === MessageType.Default,
    );
    const thread = Boolean(
      cfg.autoThreads?.enabled
      && TEXT_TYPES.includes(type)
      && (cfg.autoThreads.channels ?? []).includes(message.channelId)
      && !message.author?.bot
      && !message.webhookId
      && (message.type === MessageType.Default || message.type === MessageType.Reply)
      && (cfg.autoThreads.mode !== 'media' || hasMediaOrLink(message))
      && this.#reserveThread(message),
    );
    if (!crosspost && !thread) return false;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped || this.#wasDeleted(message.id)) {
        if (thread) this.#releaseThread(message.channelId);
        return;
      }
      if (thread) this.#track(this.#openThread(message).finally(() => this.#releaseThread(message.channelId)));
      if (crosspost && !isTransientOwnMessage(message, this.client)) this.#queueCrosspost(message);
    }, this.delayMs);
    timer.unref?.();
    this.timers.add(timer);
    return true;
  }

  /**
   * Fil automatique permis pour ce message ? Au plus THREAD_PENDING_MAX créations en attente
   * par salon, et un fil par membre et par salon toutes les 30 s (un spam n'ouvre plus un fil
   * — ni un minuteur, ni une requête — par message). Réserve la place si oui.
   */
  #reserveThread(message) {
    const channelId = message.channelId;
    const pending = this.threadPending.get(channelId) ?? 0;
    if (pending >= THREAD_PENDING_MAX) return false;
    const key = `${channelId}:${message.author?.id}`;
    const now = Date.now();
    if ((this.threadCooldowns.get(key) ?? 0) > now) return false;
    if (this.threadCooldownMs > 0) this.threadCooldowns.set(key, now + this.threadCooldownMs);
    if (this.threadCooldowns.size > 5_000) for (const [k, until] of this.threadCooldowns) if (until <= now) this.threadCooldowns.delete(k);
    this.threadPending.set(channelId, pending + 1);
    return true;
  }

  #releaseThread(channelId) {
    const left = (this.threadPending.get(channelId) ?? 1) - 1;
    if (left > 0) this.threadPending.set(channelId, left);
    else this.threadPending.delete(channelId);
  }

  /** Supprimé par un modérateur ou filtré par l'AutoMod ? (marques tenues par les réponses automatiques et les logs) */
  #wasDeleted(messageId) {
    return Boolean(this.client?.services?.autoResponses?.wasDeleted?.(messageId));
  }

  #track(promise) {
    const p = Promise.resolve(promise).catch((err) => logger.warn('Automatisation en échec :', err?.message ?? err));
    this.background.add(p);
    p.finally(() => this.background.delete(p));
    return p;
  }

  /** Avertissement (log du serveur) au plus une fois par heure pour une même clé. */
  async #warn(guild, key, { title, description, fields = [] }) {
    const now = Date.now();
    if (now - (this.warned.get(key) ?? 0) < WARN_EVERY_MS) return;
    this.warned.set(key, now);
    if (this.warned.size > 2_000) for (const [k, at] of this.warned) if (now - at >= WARN_EVERY_MS) this.warned.delete(k);
    logger.info(`${title} (serveur ${guild.id}) : ${description.replace(/\*/g, '')}`);
    const embed = logCard({ category: 'server', tone: 'warning', icon: ICONS.warning, title, description, fields });
    await this.client.services?.logging?.send(guild.id, 'server', embed, undefined, { event: 'automations' }).catch(() => {});
  }

  // ------------------------------------------------------------ publication automatique

  /** Messages en attente de publication dans un salon (file vidée si le salon n'est plus publié). */
  queueSize(channelId) {
    const q = this.queues.get(channelId);
    if (q && !this.#crosspostConfigured(q.guildId, channelId)) this.#clearQueue(channelId);
    return this.queues.get(channelId)?.items.length ?? 0;
  }

  /** Le salon est-il (encore) publié automatiquement d'après la configuration ? */
  #crosspostConfigured(guildId, channelId) {
    const cp = this.settings(guildId).crosspost ?? {};
    return Boolean(cp.enabled && (cp.channels ?? []).includes(channelId));
  }

  /**
   * Configuration de la publication modifiée (tableau de bord) : les files des salons qui ne
   * sont plus publiés sont vidées tout de suite (sinon elles le sont à leur prochain passage).
   */
  refreshCrosspost(guildId) {
    for (const [channelId, q] of [...this.queues]) {
      if (q.guildId === guildId && !this.#crosspostConfigured(guildId, channelId)) this.#clearQueue(channelId);
    }
  }

  /** Vide une file (l'historique des publications reste : la limite de Discord court toujours). */
  #clearQueue(channelId) {
    const q = this.queues.get(channelId);
    if (!q) return;
    q.items.length = 0;
    if (q.timer) {
      clearTimeout(q.timer);
      this.timers.delete(q.timer);
      q.timer = null;
    }
    const now = Date.now();
    q.sent = q.sent.filter((t) => now - t < this.crosspostWindowMs);
    if (!q.sent.length) this.queues.delete(channelId);
  }

  #queueCrosspost(message) {
    const key = message.channelId;
    let q = this.queues.get(key);
    if (!q) {
      q = { guildId: message.guildId, sent: [], items: [], timer: null, warnedAt: 0 };
      this.queues.set(key, q);
    }
    if (q.items.length >= CROSSPOST_QUEUE_MAX) {
      this.#track(this.#warn(message.guild, `cpfull:${key}`, {
        title: 'Publication automatique : file pleine',
        description: `Plus de **${CROSSPOST_QUEUE_MAX}** messages attendent leur publication dans <#${key}> (limite de Discord : **${this.crosspostLimit}** par heure). Les nouveaux messages ne sont plus publiés automatiquement pour l'instant.`,
      }));
      return;
    }
    q.items.push(message);
    this.#drain(message.guild, key);
  }

  #drain(guild, key) {
    const q = this.queues.get(key);
    if (!q || this.stopped) return;
    // Publication désactivée ou salon retiré depuis la mise en file : plus rien n'est publié.
    if (!this.#crosspostConfigured(guild.id, key)) {
      this.#clearQueue(key);
      return;
    }
    const now = Date.now();
    q.sent = q.sent.filter((t) => now - t < this.crosspostWindowMs);
    while (q.items.length && q.sent.length < this.crosspostLimit) {
      const message = q.items.shift();
      // Seules les publications réellement envoyées à Discord comptent dans la limite.
      if (!this.#crosspostAllowed(message)) continue;
      q.sent.push(now);
      this.#track(this.#crosspost(message));
    }
    if (q.items.length && !q.timer) {
      // Petite marge (horloges) : la plus ancienne publication sort de la fenêtre d'une heure.
      const at = q.sent[0] + this.crosspostWindowMs + Math.min(250, Math.round(this.crosspostWindowMs / 20));
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        q.timer = null;
        this.#drain(guild, key);
      }, Math.max(50, at - now));
      timer.unref?.();
      q.timer = timer;
      this.timers.add(timer);
      this.#track(this.#warn(guild, `cpwait:${key}`, {
        title: 'Publication automatique en attente',
        description: `Limite de Discord atteinte dans <#${key}> : **${this.crosspostLimit}** publications par heure. **${q.items.length}** message(s) seront publiés ${discordTimestamp(at, 'R')}.`,
        fields: [field(ICONS.channel, 'Salon', `<#${key}>`), field(ICONS.count, 'En attente', `${q.items.length}`)],
      }));
    }
    if (!q.items.length && !q.sent.length && !q.timer) this.queues.delete(key);
  }

  /**
   * Vérifications SYNCHRONES avant de publier (configuration relue, message supprimé ou déjà
   * publié, message transitoire du bot, permissions — alerte au besoin).
   */
  #crosspostAllowed(message) {
    if (this.stopped || this.#wasDeleted(message.id)) return false;
    if (!this.#crosspostConfigured(message.guildId, message.channelId)) return false;
    if (message.flags?.has?.(MessageFlags.Crossposted) || message.flags?.has?.(MessageFlags.IsCrosspost)) return false;
    if (isTransientOwnMessage(message, this.client)) return false;
    const { guild, channel } = message;
    const me = guild.members?.me;
    const perms = me && channel?.permissionsFor?.(me);
    const own = message.author?.id === this.client.user?.id;
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, ...(own ? [] : [PermissionFlagsBits.ManageMessages])];
    if (perms && !perms.has(needed)) {
      this.#track(this.#warn(guild, `cpperm:${channel.id}`, {
        title: 'Publication automatique impossible',
        description: `Je ne peux pas publier les messages de <#${channel.id}> : il me faut **Voir le salon**, **Envoyer des messages** et **Gérer les messages**.`,
      }));
      return false;
    }
    return true;
  }

  async #crosspost(message) {
    const { guild, channel } = message;
    try {
      await message.crosspost();
      return true;
    } catch (err) {
      // 10008 : message supprimé ; 40033 : déjà publié.
      if (err?.code === 10008 || err?.code === 40033) return false;
      if (err?.code === 50013 || err?.code === 50001) {
        await this.#warn(guild, `cpperm:${channel.id}`, { title: 'Publication automatique impossible', description: `Discord a refusé la publication dans <#${channel.id}> (permission manquante).` });
        return false;
      }
      logger.warn(`Publication automatique impossible (salon ${channel?.id}) :`, err?.message ?? err);
      return false;
    }
  }

  // ------------------------------------------------------------ fils automatiques

  async #openThread(message) {
    const cfg = this.settings(message.guildId).autoThreads ?? {};
    if (!cfg.enabled || message.hasThread || this.#wasDeleted(message.id)) return null;
    const { guild, channel } = message;
    const me = guild.members?.me;
    const perms = me && channel?.permissionsFor?.(me);
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.ReadMessageHistory])) {
      await this.#warn(guild, `thperm:${channel.id}`, {
        title: 'Fils automatiques impossibles',
        description: `Je ne peux pas créer de fil dans <#${channel.id}> : il me faut **Voir le salon**, **Lire l'historique** et **Créer des fils publics**.`,
      });
      return null;
    }
    const n = this.counters.next(guild.id, channel.id);
    const pseudo = message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? 'membre';
    const name = renderThreadName(cfg.nameTemplate, { pseudo, n });
    const duration = Object.hasOwn(ARCHIVE_DURATIONS, String(cfg.archiveMinutes)) ? Number(cfg.archiveMinutes) : 1440;
    try {
      return await message.startThread({ name, autoArchiveDuration: duration, reason: 'Fil automatique (/automatisations)' });
    } catch (err) {
      // 160004 : un fil existe déjà ; 10008 : message supprimé.
      if (err?.code === 160004 || err?.code === 10008) return null;
      if (err?.code === 50013 || err?.code === 50001) {
        await this.#warn(guild, `thperm:${channel.id}`, { title: 'Fils automatiques impossibles', description: `Discord a refusé la création d'un fil dans <#${channel.id}> (permission manquante).` });
        return null;
      }
      logger.warn(`Fil automatique impossible (salon ${channel.id}) :`, err?.message ?? err);
      return null;
    }
  }

  // ------------------------------------------------------------ rôle vocal

  /** Point d'entrée voiceStateUpdate (connexion, déplacement, déconnexion). */
  handleVoiceUpdate(oldState, newState) {
    if (this.stopped || oldState?.channelId === newState?.channelId) return null;
    const guild = newState?.guild ?? oldState?.guild;
    const member = newState?.member ?? oldState?.member;
    if (!guild || !member || member.user?.bot) return null;
    if (!this.settings(guild.id).voiceRole?.enabled) return null;
    return this.syncMember(guild, member.id);
  }

  /** Aligne les rôles vocaux d'un membre sur son état vocal ACTUEL (sérialisé par membre). */
  syncMember(guild, userId) {
    const key = `${guild.id}:${userId}`;
    const previous = this.voiceChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.#applyVoice(guild, userId)).catch((err) => logger.debug(`Rôle vocal (serveur ${guild.id}, membre ${userId}) :`, err?.message));
    this.voiceChains.set(key, next);
    next.finally(() => {
      if (this.voiceChains.get(key) === next) this.voiceChains.delete(key);
    });
    return this.#track(next);
  }

  async #applyVoice(guild, userId) {
    if (this.stopped) return;
    const cfg = this.settings(guild.id).voiceRole ?? {};
    const managed = usableRoles(guild, managedVoiceRoles(cfg));
    if (!managed.length) return;
    const key = `${guild.id}:${userId}`;
    const cached = guild.members.cache.get(userId);
    // Changement récent de notre part : le cache peut ne pas encore le refléter → relu chez Discord.
    const fresh = Date.now() - (this.voiceChangedAt.get(key) ?? 0) < VOICE_FRESH_MS;
    const member = fresh || !cached
      ? (await guild.members.fetch({ user: userId, force: true }).catch(() => null)) ?? cached
      : cached;
    if (!member || member.user?.bot) return;
    const desired = new Set(desiredVoiceRoles(cfg, guild.voiceStates?.cache?.get(userId)?.channelId ?? null));
    const add = managed.filter((r) => desired.has(r) && !member.roles.cache.has(r));
    const remove = managed.filter((r) => !desired.has(r) && member.roles.cache.has(r));
    if (!add.length && !remove.length) return;
    const res = await applyRoles(member, { add, remove }, 'Rôle vocal automatique', (id, err) => logger.debug(`Rôle vocal ${id} (membre ${userId}) :`, err?.message));
    this.#voiceChanged(guild.id, userId, res);
  }

  /** Note nos changements effectifs (les rôles de ce membre seront relus pendant 15 s). */
  #voiceChanged(guildId, userId, { added = [], removed = [] } = {}) {
    if (!added.length && !removed.length) return;
    const now = Date.now();
    this.voiceChangedAt.set(`${guildId}:${userId}`, now);
    if (this.voiceChangedAt.size > 2_000) for (const [k, at] of this.voiceChangedAt) if (now - at >= VOICE_FRESH_MS) this.voiceChangedAt.delete(k);
  }

  /**
   * Rattrapage (démarrage, activation, bouton « Resynchroniser ») : rôle donné aux membres
   * déjà en vocal, retiré à ceux qui ne le sont plus.
   * @returns {Promise<number>} membres examinés
   */
  async reconcileGuild(guild, { fetchMembers = true, isStopping = () => false, now = Date.now() } = {}) {
    const cfg = this.settings(guild.id).voiceRole ?? {};
    if (!cfg.enabled || this.stopped || !guild.available) return 0;
    this.voiceReconciledAt.set(guild.id, now);
    const managed = usableRoles(guild, managedVoiceRoles(cfg));
    if (!managed.length) return 0;
    // Cache des membres incomplet : les porteurs du rôle hors cache ne seraient pas vus.
    if (fetchMembers && guild.members.cache.size < (guild.memberCount ?? 0) && guild.memberCount <= 10_000) {
      await guild.members.fetch({ time: 15_000 }).catch((err) => logger.debug(`Membres de ${guild.id} non récupérés :`, err?.message));
    }
    const ids = new Set();
    for (const [id, state] of guild.voiceStates?.cache ?? []) if (state.channelId) ids.add(id);
    for (const roleId of managed) for (const id of guild.roles.cache.get(roleId)?.members?.keys() ?? []) ids.add(id);
    for (const id of ids) {
      if (this.stopped || isStopping()) break;
      await this.syncMember(guild, id);
    }
    return ids.size;
  }

  /**
   * Rattrapage demandé par un événement (serveur redevenu disponible, session reprise ou
   * rouverte) : en arrière-plan, au plus une fois par minute et par serveur.
   */
  requestReconcile(guild) {
    if (this.stopped || !guild?.available || !this.settings(guild.id).voiceRole?.enabled) return null;
    const now = Date.now();
    if (now - (this.voiceRequestedAt.get(guild.id) ?? 0) < VOICE_RECONCILE_DEBOUNCE_MS) return null;
    this.voiceRequestedAt.set(guild.id, now);
    return this.#track(this.reconcileGuild(guild, { fetchMembers: false }));
  }

  /**
   * Étape « voiceroles » du SchedulerService : rattrapage léger (cache seul) des serveurs au
   * rôle vocal actif, toutes les 15 min, VOICE_RECONCILE_PER_TICK serveurs au plus par passage
   * (rattrape un événement vocal manqué : coupure, reconnexion).
   * @returns {Promise<number>} serveurs rattrapés
   */
  async processDue({ isStopping = () => false, now = Date.now() } = {}) {
    if (this.stopped) return 0;
    let done = 0;
    for (const guild of this.client.guilds?.cache?.values?.() ?? []) {
      if (done >= VOICE_RECONCILE_PER_TICK || this.stopped || isStopping()) break;
      if (!guild.available || !this.settings(guild.id).voiceRole?.enabled) continue;
      if (now - (this.voiceReconciledAt.get(guild.id) ?? this.startedAt) < VOICE_RECONCILE_EVERY_MS) continue;
      done += 1;
      await this.reconcileGuild(guild, { fetchMembers: false, isStopping, now }).catch((err) => logger.debug(`Rattrapage du rôle vocal (serveur ${guild.id}) :`, err?.message));
    }
    return done;
  }

  /** Retire des rôles (anciennement « vocaux ») à tous les membres en cache qui les portent. */
  async releaseRoles(guild, roleIds) {
    let removed = 0;
    for (const roleId of usableRoles(guild, roleIds)) {
      for (const member of [...(guild.roles.cache.get(roleId)?.members?.values() ?? [])]) {
        if (this.stopped) return removed;
        if (member.user?.bot) continue;
        const { removed: done } = await applyRoles(member, { remove: [roleId] }, 'Rôle vocal retiré (configuration modifiée)', (id, err) => logger.debug(`Retrait du rôle vocal ${id} :`, err?.message));
        this.#voiceChanged(guild.id, member.id, { removed: done });
        removed += done.length;
      }
    }
    return removed;
  }

  /** Lance une tâche de fond suivie (attendue à l'arrêt). */
  runInBackground(promise) {
    return this.#track(promise);
  }

  // ------------------------------------------------------------ boosts

  /** Point d'entrée guildMemberUpdate : remerciement au début d'un boost, rôle retiré à la fin. */
  async handleMemberUpdate(oldMember, newMember) {
    const change = boostChange(oldMember, newMember);
    if (!change || this.stopped) return null;
    const guild = newMember.guild;
    const cfg = this.settings(guild.id).boost ?? {};
    if (!cfg.enabled) return null;
    const [roleId] = cfg.roleId ? usableRoles(guild, [cfg.roleId]) : [];
    if (change === 'end') {
      if (roleId && newMember.roles.cache.has(roleId)) await applyRoles(newMember, { remove: [roleId] }, 'Fin du boost', (id, err) => logger.debug(`Rôle de boost ${id} :`, err?.message));
      return 'end';
    }
    const key = `${guild.id}:${newMember.id}`;
    const now = Date.now();
    if (now - (this.boostSeen.get(key) ?? 0) < BOOST_DEDUP_MS) return null;
    this.boostSeen.set(key, now);
    if (this.boostSeen.size > 1_000) for (const [k, at] of this.boostSeen) if (now - at >= BOOST_DEDUP_MS) this.boostSeen.delete(k);
    if (roleId && !newMember.roles.cache.has(roleId)) await applyRoles(newMember, { add: [roleId] }, 'Merci pour le boost', (id, err) => logger.debug(`Rôle de boost ${id} :`, err?.message));
    if (!cfg.channelId) return 'start';
    const issue = channelIssue(guild, cfg.channelId);
    if (issue) {
      await this.#warn(guild, `boost:${cfg.channelId}`, { title: 'Remerciement de boost non publié', description: `Je ne peux pas publier dans <#${cfg.channelId}> : ${issue}.` });
      return 'start';
    }
    const text = renderBoostMessage(cfg.message, { id: newMember.id, server: guild.name, boosts: guild.premiumSubscriptionCount ?? 0 });
    await guild.channels.cache.get(cfg.channelId).send(boostPayload(text, { userId: newMember.id, avatar: newMember.displayAvatarURL?.() ?? null }))
      .catch((err) => logger.warn(`Remerciement de boost non envoyé (serveur ${guild.id}) :`, err?.message ?? err));
    return 'start';
  }

  // ------------------------------------------------------------ arrêt

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const q of this.queues.values()) q.items.length = 0;
    await Promise.allSettled([...this.background]);
  }
}

module.exports = {
  AutomationService,
  boostChange,
  isTransientOwnMessage,
  renderThreadName,
  unknownVariables,
  hasMediaOrLink,
  managedVoiceRoles,
  desiredVoiceRoles,
  renderBoostMessage,
  boostPayload,
  assignableRoleIssue,
  botRoleIssue,
  usableRoles,
  ARCHIVE_DURATIONS,
  THREAD_MODES,
  DEFAULT_THREAD_NAME,
  DEFAULT_BOOST_MESSAGE,
  BOOST_VARIABLES,
  TEXT_TYPES,
  VOICE_TYPES,
  MAX_CHANNELS,
  MAX_VOICE_LINKS,
  MAX_TEMPLATE,
  MAX_BOOST_MESSAGE,
  CROSSPOST_LIMIT,
  CROSSPOST_QUEUE_MAX,
  THREAD_PENDING_MAX,
  THREAD_COOLDOWN_MS,
  VOICE_RECONCILE_EVERY_MS,
};
