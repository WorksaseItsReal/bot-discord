'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { card, field, ICONS } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { MAX_XP } = require('../database/repositories/LevelRepository');
const { createLogger } = require('../core/logger');
const { applyRoles } = require('../utils/memberRoles');

const logger = createLogger('levels');

/** Niveau maximal (garde-fou : l'XP est bornée à MAX_XP, soit un niveau < 1000). */
const MAX_LEVEL = 1000;
/**
 * Délai avant d'accorder l'XP d'un message : laisse à l'AutoMod (et aux modérateurs
 * pressés) le temps de supprimer le message. Voir LevelService#handleMessage.
 */
const GRANT_DELAY_MS = 2_000;
/** Intervalle du suivi vocal. */
const VOICE_TICK_MS = 60_000;
/** Tolérance de dérive du minuteur : 59,9 s comptent pour une minute. */
const VOICE_TOLERANCE_MS = 2_000;
/** Messages supprimés retenus (pour ne pas accorder d'XP) : durée et taille. */
const DELETED_TTL_MS = 60_000;
const DELETED_MAX = 2_000;
const COOLDOWN_PRUNE_AT = 5_000;
const DAY_MS = 86_400_000;
/** Purge des membres partis : ancienneté maximale du départ (jours). */
const MAX_LEFT_DAYS = 3650;

/** Le membre est-il (encore) sur le serveur ? Les membres présents sont en cache (intent GuildMembers). */
function isPresent(guild, userId) {
  return guild?.members?.cache?.has?.(userId) === true;
}

/** Message d'annonce par défaut. */
const DEFAULT_ANNOUNCE = 'Bravo {membre}, vous passez au **niveau {niveau}** ! 🎉';
const ANNOUNCE_MODES = Object.freeze({
  off: 'Désactivées',
  same: 'Dans le salon du message',
  channel: 'Dans un salon dédié',
  dm: 'En message privé',
});

// ---------------------------------------------------------------- formule (pure)

/** XP nécessaire pour passer du niveau n au niveau n+1 : 5n² + 50n + 100. Pur. */
function xpForLevel(n) {
  const l = Math.max(0, Math.floor(n));
  return 5 * l * l + 50 * l + 100;
}

/** XP cumulée nécessaire pour atteindre le niveau n (somme des paliers 0…n-1). Pur. */
function totalXpForLevel(n) {
  const l = Math.max(0, Math.floor(n));
  // Σ 5k² + 50k + 100 pour k = 0…l-1
  return (5 * (l - 1) * l * (2 * l - 1)) / 6 + 25 * l * (l - 1) + 100 * l;
}

/** Niveau atteint avec `xp` points. Pur. */
function levelFromXp(xp) {
  const x = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 0;
  while (level < MAX_LEVEL && x >= totalXpForLevel(level + 1)) level += 1;
  return level;
}

/** Progression dans le niveau courant. Pur. */
function progressOf(xp) {
  const x = Math.max(0, Math.floor(Number(xp) || 0));
  const level = levelFromXp(x);
  const current = x - totalXpForLevel(level);
  const needed = xpForLevel(level);
  return { level, current, needed, remaining: needed - current, ratio: needed ? current / needed : 0 };
}

/** Gain aléatoire entre min et max (inclus). Pur si `rng` l'est. */
function randomXp(min, max, rng = Math.random) {
  const lo = Math.max(0, Math.floor(Math.min(min, max)));
  const hi = Math.max(0, Math.floor(Math.max(min, max)));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Multiplicateur le plus élevé parmi les rôles du membre (1 sans rôle concerné). Pur. */
function multiplierFor(roleIds, multipliers = []) {
  const owned = new Set(roleIds);
  let best = null;
  for (const m of multipliers) {
    if (owned.has(m.roleId) && Number.isFinite(m.multiplier) && (best == null || m.multiplier > best)) best = m.multiplier;
  }
  return best ?? 1;
}

/**
 * Rôles de récompense auxquels un niveau donne droit. Pur.
 * Cumulatifs : toutes les récompenses ≤ niveau ; sinon seulement celles du palier le plus haut atteint.
 * @returns {{ eligible: string[], ineligible: string[], lower: string[] }}
 */
function rewardPlan(level, rewards = [], stack = true) {
  const reached = rewards.filter((r) => r.level <= level);
  const top = reached.reduce((m, r) => Math.max(m, r.level), -1);
  const eligible = new Set((stack ? reached : reached.filter((r) => r.level === top)).map((r) => r.roleId));
  const ineligible = [...new Set(rewards.map((r) => r.roleId))].filter((id) => !eligible.has(id));
  const lower = ineligible.filter((id) => rewards.some((r) => r.roleId === id && r.level <= level));
  return { eligible: [...eligible], ineligible, lower };
}

/** Remplit le modèle d'annonce ({membre}, {niveau}, {pseudo}, {serveur}). Pur. */
function renderTemplate(template, { member, level, name, server }) {
  const text = String(template || DEFAULT_ANNOUNCE);
  return truncate(
    text
      .replace(/\{(membre|member)\}/gi, member ?? '')
      .replace(/\{(niveau|level)\}/gi, String(level ?? ''))
      .replace(/\{(pseudo|name)\}/gi, name ?? '')
      .replace(/\{(serveur|server)\}/gi, server ?? ''),
    2000,
  );
}

/** Salon (ou son parent / sa catégorie) exclu ? Pur. */
function isIgnoredChannel(channel, ignored = []) {
  if (!channel || !ignored.length) return false;
  const set = new Set(ignored);
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && set.has(id));
}

/** Le membre possède-t-il un rôle exclu ? Pur. */
function hasIgnoredRole(member, ignored = []) {
  if (!ignored.length) return false;
  const roles = member?.roles?.cache;
  return Boolean(roles && ignored.some((id) => roles.has(id)));
}

/**
 * Le membre gagne-t-il de l'XP vocale ? Non muet/sourd, hors salon AFK,
 * et au moins un autre humain dans le salon. Pur.
 */
function isVoiceEligible(state, guild) {
  const channel = state?.channel;
  if (!channel || !state.channelId) return false;
  if (guild?.afkChannelId && state.channelId === guild.afkChannelId) return false;
  if (state.selfMute || state.serverMute || state.selfDeaf || state.serverDeaf) return false;
  const others = [...(channel.members?.values?.() ?? [])].filter((m) => m.id !== state.id && !m.user?.bot);
  return others.length >= 1;
}

const roleIdsOf = (member) => [...(member?.roles?.cache?.keys?.() ?? [])];

// ---------------------------------------------------------------- service

/**
 * Niveaux et XP : gains par message (après l'AutoMod) et en vocal, récompenses
 * de rôle, annonces de passage de niveau. Toute la config vient de `levels`.
 */
class LevelService {
  /**
   * @param {{ client?: object, levels: import('../database/repositories/LevelRepository').LevelRepository,
   *   config: import('./ConfigService').ConfigService, rng?: () => number, grantDelayMs?: number }} deps
   */
  constructor({ client, levels, config, rng = Math.random, grantDelayMs = GRANT_DELAY_MS }) {
    this.client = client;
    this.levels = levels;
    this.config = config;
    this.rng = rng;
    this.grantDelayMs = grantDelayMs;
    /** Fin du cooldown par membre : `${guildId}:${userId}` → ms. */
    this.cooldowns = new Map();
    /** Messages supprimés récemment : id → expiration. */
    this.deleted = new Map();
    /** Gains de messages en attente (délai post-AutoMod). */
    this.pending = new Set();
    /** Suivi vocal : `${guildId}:${userId}` → { guildId, userId, credited }. */
    this.voice = new Map();
    this.timer = null;
    this.currentTick = null;
    this.stopped = false;
  }

  cfg(guildId) {
    return this.config.get(guildId).levels ?? {};
  }

  // ------------------------------------------------------------ cycle de vie

  /** Démarre le suivi vocal (minuteur non bloquant, arrêté par stop()). */
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.currentTick) return; // pas de chevauchement
      this.currentTick = this.voiceTick()
        .catch((err) => logger.warn('Suivi vocal :', err?.message))
        .finally(() => {
          this.currentTick = null;
        });
    }, VOICE_TICK_MS);
    this.timer.unref?.();
  }

  /** Arrêt propre : minuteurs annulés, tick en cours attendu (avant fermeture de la base). */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    if (this.currentTick) await this.currentTick.catch(() => {});
  }

  // ------------------------------------------------------------ messages

  /**
   * Message éligible ? (sans effet de bord). Bots, webhooks, messages système,
   * trop courts, salons et rôles exclus : pas d'XP.
   */
  isEligible(message, cfg) {
    if (!cfg?.enabled || !message?.guild || !message.member) return false;
    if (message.author?.bot || message.webhookId || message.system) return false;
    if (String(message.content ?? '').trim().length < (cfg.minLength ?? 3)) return false;
    if (isIgnoredChannel(message.channel, cfg.ignoredChannels)) return false;
    if (hasIgnoredRole(message.member, cfg.ignoredRoles)) return false;
    return true;
  }

  /**
   * Point d'entrée messageCreate. L'XP est accordée APRÈS l'AutoMod : le gain est
   * programmé `grantDelayMs` plus tard, puis abandonné si le message a été supprimé
   * entre-temps (événement messageDelete, ou marquage de l'AutoMod dans LoggingService,
   * posé de façon synchrone avant même l'appel de suppression).
   * Le cooldown est réservé tout de suite : un seul gain en attente par membre.
   * @returns {boolean} un gain a été programmé
   */
  handleMessage(message) {
    if (this.stopped || !message?.guild) return false;
    const cfg = this.cfg(message.guild.id);
    if (!this.isEligible(message, cfg)) return false;
    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    if ((this.cooldowns.get(key) ?? 0) > now) return false;
    this.cooldowns.set(key, now + Math.max(0, cfg.cooldownSeconds ?? 60) * 1000);
    if (this.cooldowns.size > COOLDOWN_PRUNE_AT) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);

    const timer = setTimeout(() => {
      this.pending.delete(timer);
      this.grantMessage(message).catch((err) => logger.warn(`Gain d'XP impossible (${message.guild.id}) :`, err?.message));
    }, this.grantDelayMs);
    timer.unref?.();
    this.pending.add(timer);
    return true;
  }

  /** Mémorise un message supprimé (aucune XP ne sera accordée pour lui). */
  markDeleted(messageId) {
    if (!messageId) return;
    const now = Date.now();
    this.deleted.set(messageId, now + DELETED_TTL_MS);
    if (this.deleted.size > DELETED_MAX) for (const [id, exp] of this.deleted) if (exp <= now) this.deleted.delete(id);
  }

  /** Le message a-t-il été supprimé (par l'AutoMod ou un modérateur) ? */
  wasDeleted(messageId) {
    if ((this.deleted.get(messageId) ?? 0) > Date.now()) return true;
    // Lecture SANS consommer : isSuppressed() retirerait la marque dont messageDelete a besoin.
    const suppressed = this.client?.services?.logging?.suppressed;
    return Boolean(suppressed?.get?.(messageId) > Date.now());
  }

  /** Accorde l'XP d'un message (appelé après le délai). */
  async grantMessage(message) {
    if (this.stopped || this.wasDeleted(message.id)) return null;
    const cfg = this.cfg(message.guild.id);
    if (!cfg.enabled) return null;
    const base = randomXp(cfg.xpMin ?? 15, cfg.xpMax ?? 25, this.rng);
    const xp = Math.round(base * multiplierFor(roleIdsOf(message.member), cfg.multipliers));
    // Gain différé : le membre a pu partir entre-temps (« bye » puis départ). Il n'est
    // « présent » (marque de départ effacée) que s'il est toujours sur le serveur.
    const present = isPresent(message.guild, message.author.id);
    return this.award(message.guild, message.author.id, { xp, messages: 1, at: Date.now(), present }, { member: message.member, channel: message.channel });
  }

  /**
   * Ajoute de l'XP et gère le passage de niveau (récompenses + annonce).
   * @returns {Promise<{ before: object, after: object, leveledUp: boolean, roles: string[] }>}
   */
  async award(guild, userId, change, { member = null, channel = null } = {}) {
    const { before, after } = this.levels.add(guild.id, userId, change, levelFromXp);
    const leveledUp = after.level > before.level;
    let roles = [];
    if (leveledUp && member && !this.stopped) {
      const cfg = this.cfg(guild.id);
      roles = (await this.syncRewards(member, after.level, cfg).catch(() => ({ added: [] }))).added;
      await this.announce(member, after.level, cfg, { channel, roles, xp: after.xp }).catch((err) => logger.debug('Annonce de niveau :', err?.message));
    }
    return { before, after, leveledUp, roles };
  }

  // ------------------------------------------------------------ récompenses

  /** Rôle attribuable par le bot (existe, pas @everyone ni géré, sous mon rôle le plus haut). */
  static assignable(guild, roleId) {
    const role = guild?.roles?.cache?.get(roleId);
    const me = guild?.members?.me;
    if (!role || role.id === guild.id || role.managed || !me) return false;
    return role.position < (me.roles?.highest?.position ?? 0);
  }

  /**
   * Met les rôles de récompense en accord avec le niveau.
   * Par défaut (passage de niveau) : ajoute les rôles dus et, si les récompenses ne sont
   * pas cumulatives, retire les paliers inférieurs. `full` (changement par un admin) :
   * retire aussi les récompenses des paliers non atteints.
   * @returns {Promise<{ added: string[], removed: string[] }>}
   */
  async syncRewards(member, level, cfg, { full = false } = {}) {
    const guild = member.guild;
    const rewards = cfg.rewards ?? [];
    if (!rewards.length || !guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return { added: [], removed: [] };
    const plan = rewardPlan(level, rewards, cfg.stackRewards !== false);
    const has = (id) => member.roles.cache.has(id);
    const add = plan.eligible.filter((id) => !has(id) && LevelService.assignable(guild, id));
    const drop = (full ? plan.ineligible : cfg.stackRewards === false ? plan.lower : []).filter((id) => has(id) && LevelService.assignable(guild, id));
    // Un rôle à la fois (routes par rôle) : un PATCH de liste pour le retrait annulerait l'ajout.
    const log = (action) => (id, err) => logger.debug(`${action} de la récompense ${id} :`, err?.message);
    const { added } = await applyRoles(member, { add }, `Récompense de niveau ${level}`, log('Ajout'));
    const { removed } = await applyRoles(member, { remove: drop }, `Niveau ${level} : récompense mise à jour`, log('Retrait'));
    return { added, removed };
  }

  // ------------------------------------------------------------ annonces

  /** Carte de passage de niveau. */
  levelUpCard(member, level, cfg, { roles = [], xp } = {}) {
    const text = renderTemplate(cfg.announce?.message, {
      member: `${member}`,
      level,
      name: member.displayName ?? member.user?.username,
      server: member.guild?.name,
    });
    return card({
      tone: 'celebrate',
      section: 'levels',
      icon: '🆙',
      title: 'Niveau supérieur !',
      description: [text, roles.length ? `\n${ICONS.gift} Nouveau rôle : ${roles.map((id) => `<@&${id}>`).join(' ')}` : null],
      fields: [field('📈', 'Niveau', `**${level}**`), xp != null ? field(ICONS.star, 'XP totale', `**${xp.toLocaleString('fr-FR')}**`) : null],
      thumbnail: member.displayAvatarURL?.({ size: 128 }) ?? null,
      footer: member.guild?.name,
    });
  }

  /** Salon d'annonce selon le mode (null si aucun salon utilisable). */
  announceTarget(guild, cfg, channel) {
    const mode = cfg.announce?.mode ?? 'same';
    const target = mode === 'same' ? channel : mode === 'channel' ? guild.channels?.cache?.get(cfg.announce?.channelId) : null;
    if (!target?.isTextBased?.() || typeof target.send !== 'function') return null;
    const me = guild.members?.me;
    const perms = me && target.permissionsFor?.(me);
    const send = target.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.EmbedLinks])) return null;
    return target;
  }

  /** Envoie l'annonce ; seul le membre concerné peut être notifié. */
  async announce(member, level, cfg, { channel = null, roles = [], xp } = {}) {
    const mode = cfg.announce?.mode ?? 'same';
    if (mode === 'off') return false;
    const embed = this.levelUpCard(member, level, cfg, { roles, xp });
    if (mode === 'dm') {
      return member.send({ embeds: [embed] }).then(() => true, () => false);
    }
    const target = this.announceTarget(member.guild, cfg, channel);
    if (!target) return false;
    await target.send({ content: `${member}`, embeds: [embed], allowedMentions: { parse: [], users: [member.id] } });
    return true;
  }

  // ------------------------------------------------------------ vocal

  /** Suivi voiceStateUpdate : (re)démarre le chronomètre à chaque changement d'état. */
  trackVoice(oldState, newState) {
    const member = newState?.member ?? oldState?.member;
    const guildId = newState?.guild?.id ?? oldState?.guild?.id;
    if (!member || member.user?.bot || !guildId) return;
    const key = `${guildId}:${member.id}`;
    if (!newState.channelId) {
      this.voice.delete(key);
      return;
    }
    const changed = !this.voice.has(key)
      || oldState?.channelId !== newState.channelId
      || Boolean(oldState?.selfMute || oldState?.serverMute || oldState?.selfDeaf || oldState?.serverDeaf)
        !== Boolean(newState.selfMute || newState.serverMute || newState.selfDeaf || newState.serverDeaf);
    if (changed) this.voice.set(key, { guildId, userId: member.id, credited: Date.now() });
  }

  /**
   * Tick du suivi vocal : crédite les minutes complètes passées en vocal éligible.
   * Les membres déjà connectés au démarrage sont pris en compte au premier tick.
   */
  async voiceTick(now = Date.now()) {
    if (this.stopped) return 0;
    const guilds = this.client?.guilds?.cache;
    if (!guilds) return 0;
    const active = new Set();
    for (const guild of guilds.values()) {
      const cfg = this.cfg(guild.id);
      if (!cfg.enabled || !cfg.voice?.enabled) continue;
      active.add(guild.id);
      for (const state of guild.voiceStates?.cache?.values?.() ?? []) {
        const key = `${guild.id}:${state.id}`;
        if (state.channelId && state.member && !state.member.user?.bot && !this.voice.has(key)) {
          this.voice.set(key, { guildId: guild.id, userId: state.id, credited: now });
        }
      }
    }
    let credited = 0;
    for (const [key, entry] of this.voice) {
      if (this.stopped) break;
      if (!active.has(entry.guildId)) {
        this.voice.delete(key);
        continue;
      }
      const guild = guilds.get(entry.guildId);
      const state = guild?.voiceStates?.cache?.get(entry.userId);
      if (!state?.channelId) {
        this.voice.delete(key);
        continue;
      }
      const cfg = this.cfg(guild.id);
      if (!isVoiceEligible(state, guild) || isIgnoredChannel(state.channel, cfg.ignoredChannels) || hasIgnoredRole(state.member, cfg.ignoredRoles)) {
        entry.credited = now;
        continue;
      }
      const minutes = Math.floor((now - entry.credited + VOICE_TOLERANCE_MS) / 60_000);
      if (minutes <= 0) continue;
      entry.credited += minutes * 60_000;
      const xp = Math.round(Math.max(0, cfg.voice.xpPerMinute ?? 10) * minutes * multiplierFor(roleIdsOf(state.member), cfg.multipliers));
      await this.award(guild, entry.userId, { xp, voiceMinutes: minutes, present: isPresent(guild, entry.userId) }, { member: state.member, channel: state.channel }).catch((err) => logger.debug('XP vocale :', err?.message));
      credited += 1;
    }
    return credited;
  }

  // ------------------------------------------------------------ administration

  /**
   * Donne, retire ou définit l'XP d'un membre (sans annonce). Les récompenses sont
   * resynchronisées si le membre est sur le serveur.
   * @param {'give'|'remove'|'set'} op
   */
  async adminXp(guild, userId, op, amount) {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n < 0) throw new RangeError('Montant invalide');
    const current = this.levels.get(guild.id, userId)?.xp ?? 0;
    const target = op === 'give' ? current + n : op === 'remove' ? current - n : n;
    const result = this.levels.setXp(guild.id, userId, Math.min(MAX_XP, Math.max(0, target)), levelFromXp);
    const member = await guild.members?.fetch?.(userId).catch(() => null);
    if (member) await this.syncRewards(member, result.after.level, this.cfg(guild.id), { full: true }).catch(() => {});
    return result;
  }

  /** Réinitialise un membre (XP, compteurs) et retire ses rôles de récompense. */
  async resetMember(guild, userId) {
    const n = this.levels.resetMember(guild.id, userId);
    const member = await guild.members?.fetch?.(userId).catch(() => null);
    if (member) await this.syncRewards(member, -1, this.cfg(guild.id), { full: true }).catch(() => {});
    return n;
  }

  // ------------------------------------------------------------ départs

  /** Départ d'un membre (guildMemberRemove) : son XP est conservée mais il quitte le classement. */
  markLeft(guildId, userId, at = Date.now()) {
    if (!guildId || !userId) return false;
    return this.levels.markLeft(guildId, userId, at);
  }

  /** Retour d'un membre (guildMemberAdd) : il retrouve sa place au classement. */
  markReturned(guildId, userId) {
    if (!guildId || !userId) return false;
    return this.levels.markReturned(guildId, userId);
  }

  /** Limite de date d'une purge « partis depuis plus de N jours » (0 : tous les partis). Pur. */
  static leftBefore(days, now = Date.now()) {
    return now - Math.max(0, Math.floor(Number(days) || 0)) * DAY_MS;
  }

  /** Membres partis depuis plus de `days` jours. */
  countLeft(guildId, days, now = Date.now()) {
    return this.levels.countLeft(guildId, LevelService.leftBefore(days, now));
  }

  /** Supprime l'XP des membres partis depuis plus de `days` jours. @returns {number} */
  purgeLeft(guildId, days, now = Date.now()) {
    return this.levels.purgeLeft(guildId, LevelService.leftBefore(days, now));
  }

  /** Réinitialise tout le serveur (les rôles déjà attribués sont conservés). */
  resetGuild(guildId) {
    for (const key of this.cooldowns.keys()) if (key.startsWith(`${guildId}:`)) this.cooldowns.delete(key);
    return this.levels.resetGuild(guildId);
  }
}

module.exports = {
  LevelService,
  xpForLevel,
  totalXpForLevel,
  levelFromXp,
  progressOf,
  randomXp,
  multiplierFor,
  rewardPlan,
  renderTemplate,
  isIgnoredChannel,
  hasIgnoredRole,
  isVoiceEligible,
  DEFAULT_ANNOUNCE,
  ANNOUNCE_MODES,
  GRANT_DELAY_MS,
  MAX_LEVEL,
  MAX_LEFT_DAYS,
};
