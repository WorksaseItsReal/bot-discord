'use strict';

const { AuditLogEvent } = require('discord.js');
const { createLogger } = require('../../../core/logger');

const logger = createLogger('secur:members');

/**
 * Modules Secur « membres » (SEC5) : bannissements (22), débannissements (23), expulsions et
 * prunes (20, 21), ajout de bots (28) et déconnexions vocales (26/27, lues par
 * src/events/securVoice.js puis signalées hors pipeline).
 *
 * Arrivants récents (moins de 10 min) : les bannir ou les expulser n'est jamais destructeur (raid).
 * L'AntiRaid ne mémorise les arrivées que s'il est actif ; Secur garde donc en plus les départs
 * récents vus par guildMemberRemove (`rememberDeparture`), car le membre a déjà quitté le cache
 * quand l'entrée d'audit d'un ban ou d'un kick arrive.
 */

const RECENT_JOIN_MS = 10 * 60_000;
const MAX_DEPARTURES = 5_000;
const SNOWFLAKE = /^\d{17,20}$/;

/** Départs d'arrivants récents : `${guildId}:${userId}` → arrivée (ms). Ordre d'insertion = ancienneté. */
const departures = new Map();

function pruneDepartures(now = Date.now()) {
  for (const [key, joinedAt] of departures) {
    if (departures.size <= MAX_DEPARTURES && now - joinedAt < RECENT_JOIN_MS) break;
    departures.delete(key);
  }
}

/**
 * Départ d'un membre (guildMemberRemove) : arrivé il y a moins de 10 min, son arrivée est gardée
 * 10 min (exemption du ban ou du kick qui l'a fait partir). @returns {boolean} mémorisé
 */
function rememberDeparture(member, now = Date.now()) {
  const guildId = member?.guild?.id;
  const joinedAt = member?.joinedTimestamp;
  if (!guildId || !member.id || !Number.isFinite(joinedAt) || now - joinedAt >= RECENT_JOIN_MS) return false;
  const key = `${guildId}:${member.id}`;
  departures.delete(key);
  departures.set(key, joinedAt);
  pruneDepartures(now);
  return true;
}

/** Serveur quitté : départs oubliés. */
function forgetGuild(guildId) {
  if (!guildId) return;
  for (const key of departures.keys()) if (key.startsWith(`${guildId}:`)) departures.delete(key);
}

/**
 * La cible d'un ban ou d'un kick est-elle un arrivant récent (moins de 10 min avant l'action) ?
 * Sources : membre encore en cache, mémoire de l'AntiRaid (arrivées et vagues), départs récents.
 */
function isRecentTarget(guild, targetId, ctx = {}) {
  if (!targetId || !guild?.id) return false;
  const at = Number.isFinite(ctx.at) ? ctx.at : Date.now();
  const joinedAt = guild.members?.cache?.get?.(targetId)?.joinedTimestamp ?? departures.get(`${guild.id}:${targetId}`) ?? null;
  if (Number.isFinite(joinedAt) && at - joinedAt < RECENT_JOIN_MS && at >= joinedAt - 60_000) return true;
  return Boolean(ctx.client?.services?.antiraid?.isRecentJoiner?.(guild.id, targetId, Number.isFinite(joinedAt) ? joinedAt : null, at));
}

const isBlacklisted = (ctx, guildId, userId) => {
  try {
    return Boolean(ctx.client?.services?.blacklist?.has?.(guildId, userId));
  } catch {
    return false;
  }
};

/** Ban encore en place ? (true / false, null : illisible) */
async function isBanned(guild, userId) {
  try {
    const ban = await guild.bans.fetch({ user: userId, force: true });
    return Boolean(ban);
  } catch (err) {
    if (err?.code === 10026) return false;
    return null;
  }
}

const reasonText = (text) => `Secur : ${text}`.slice(0, 400);

/** Nombre de membres retirés par un prune (0 si illisible). Pur. */
function pruneCount(entry) {
  const n = Number(entry?.extra?.removed ?? entry?.options?.members_removed ?? 0);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

const ban = {
  key: 'ban',
  auditTypes: [AuditLogEvent.MemberBanAdd],
  priority: 5,
  /** Ban d'un ancien membre : compté ; ban d'un arrivant récent (raider) : ignoré. */
  classify(entry, guild, ctx) {
    const userId = entry.targetId ?? null;
    if (userId && isRecentTarget(guild, userId, ctx)) return null;
    return { weight: 1, record: { userId } };
  },
  /** Annulation (désactivée par défaut) : débannit la victime, sauf un blacklisté (SEC3). */
  async undo(guild, record, ctx) {
    const userId = record?.userId;
    if (!SNOWFLAKE.test(String(userId ?? ''))) return { ok: false, note: 'Bannissement sans cible lisible : rien à annuler.' };
    if (isBlacklisted(ctx, guild.id, userId)) return { ok: true, note: `<@${userId}> est sur la liste noire : il reste banni.` };
    const banned = await isBanned(guild, userId);
    if (banned === false) return { ok: true };
    const moderation = ctx.client?.services?.moderation;
    moderation?.markBotAction?.('unban', guild.id, userId);
    try {
      await guild.bans.remove(userId, reasonText('bannissement annulé'));
      return { ok: true };
    } catch (err) {
      moderation?.unmarkBotAction?.('unban', guild.id, userId);
      if (err?.code === 10026) return { ok: true };
      return { ok: false, note: `Débannissement de <@${userId}> impossible (${String(err?.message ?? err).slice(0, 100)}).` };
    }
  },
  describe: (record) => (record?.userId ? `Ban de <@${record.userId}>` : 'Ban'),
  targetKey: (record) => (record?.userId ? `ban:${record.userId}` : null),
};

const unban = {
  key: 'unban',
  auditTypes: [AuditLogEvent.MemberBanRemove],
  priority: 5,
  classify(entry) {
    const userId = entry.targetId ?? null;
    return userId ? { weight: 1, record: { userId } } : null;
  },
  /**
   * Rebannit la cible (markBotAction avant l'appel), sauf si elle est blacklistée : la liste
   * noire (SEC3) la rebannit déjà elle-même. Un ban déjà revenu n'est pas reposé.
   */
  async undo(guild, record, ctx) {
    const userId = record?.userId;
    if (!SNOWFLAKE.test(String(userId ?? ''))) return { ok: false, note: 'Débannissement sans cible lisible.' };
    if (isBlacklisted(ctx, guild.id, userId)) return { ok: true, note: `<@${userId}> est sur la liste noire : rebanni par la liste noire.` };
    if ((await isBanned(guild, userId)) === true) return { ok: true };
    const moderation = ctx.client?.services?.moderation;
    moderation?.markBotAction?.('ban', guild.id, userId);
    ctx.client?.services?.welcome?.silence?.(guild.id, userId);
    try {
      await guild.bans.create(userId, { reason: reasonText('débannissement non autorisé annulé') });
      return { ok: true };
    } catch (err) {
      moderation?.unmarkBotAction?.('ban', guild.id, userId);
      ctx.client?.services?.welcome?.unsilence?.(guild.id, userId);
      return { ok: false, note: `Rebannissement de <@${userId}> impossible (${String(err?.message ?? err).slice(0, 100)}).` };
    }
  },
  describe: (record) => (record?.userId ? `Débannissement de <@${record.userId}>` : 'Débannissement'),
  targetKey: (record) => (record?.userId ? `unban:${record.userId}` : null),
};

const kick = {
  key: 'kick',
  auditTypes: [AuditLogEvent.MemberKick, AuditLogEvent.MemberPrune],
  priority: 5,
  /**
   * Kick (20) : 1 action, arrivant récent exempté. Prune (21) : UNE entrée pour `members_removed`
   * expulsions → weight = ce nombre (la limite est dépassée d'un coup). Sanction seule.
   */
  classify(entry, guild, ctx) {
    if (entry.action === AuditLogEvent.MemberPrune) {
      const removed = pruneCount(entry);
      if (!removed) return null;
      return { weight: removed, record: { prune: true, removed, days: Number(entry.extra?.days ?? entry.options?.delete_member_days) || null } };
    }
    const userId = entry.targetId ?? null;
    if (userId && isRecentTarget(guild, userId, ctx)) return null;
    return { weight: 1, record: { userId } };
  },
  describe: (record) => (record?.prune ? `Prune de ${record.removed} membre(s)` : record?.userId ? `Expulsion de <@${record.userId}>` : 'Expulsion'),
  targetKey: (record) => (record?.userId ? `kick:${record.userId}` : null),
};

const bot = {
  key: 'bot',
  auditTypes: [AuditLogEvent.BotAdd],
  priority: 5,
  /**
   * Bot ajouté (28) : c'est l'INVITEUR (exécuteur) qui est jugé par le moteur (en on : whitelist,
   * confiance et au-dessus exemptés ; en max : owners et au-dessus). Le bot lui-même est autorisé
   * s'il est dans les bots de confiance, ou (en on seulement) dans whitelist.users.
   */
  classify(entry, guild, ctx) {
    const botId = entry.targetId ?? null;
    if (!botId) return null;
    const secur = ctx.cfg?.secur ?? {};
    if (Array.isArray(secur.trustedBots) && secur.trustedBots.includes(botId)) return null;
    if (ctx.moduleCfg?.mode !== 'max' && Array.isArray(ctx.cfg?.whitelist?.users) && ctx.cfg.whitelist.users.includes(botId)) return null;
    return { weight: 1, record: { botId } };
  },
  /** Annulation : expulsion du bot ajouté (ou « déjà expulsé » par l'AntiRaid / déjà parti). */
  async undo(guild, record, ctx) {
    const botId = record?.botId;
    if (!SNOWFLAKE.test(String(botId ?? ''))) return { ok: false, note: 'Bot ajouté sans identifiant lisible.' };
    if (ctx.service?.wasBotRemoved?.(guild.id, botId)) return { ok: true, note: `Bot <@${botId}> déjà expulsé.` };
    const member = guild.members?.cache?.get?.(botId) ?? (await guild.members?.fetch?.(botId).catch(() => null)) ?? null;
    if (!member) return { ok: true, note: `Bot <@${botId}> déjà parti.` };
    if (!member.user?.bot) return { ok: false, note: `<@${botId}> n'est pas un bot : rien expulsé.` };
    if (member.kickable === false) return { ok: false, note: `Bot <@${botId}> non expulsable (rôle au-dessus du mien ou permission manquante).` };
    ctx.client?.services?.welcome?.silence?.(guild.id, botId);
    try {
      await member.kick(reasonText('bot ajouté sans autorisation'));
      ctx.service?.noteBotRemoved?.(guild, botId);
      return { ok: true };
    } catch (err) {
      ctx.client?.services?.welcome?.unsilence?.(guild.id, botId);
      if (err?.code === 10007) return { ok: true, note: `Bot <@${botId}> déjà parti.` };
      logger.debug('Expulsion du bot ajouté :', err?.message);
      return { ok: false, note: `Bot <@${botId}> non expulsé (${String(err?.message ?? err).slice(0, 100)}).` };
    }
  },
  describe: (record) => (record?.botId ? `Bot <@${record.botId}> ajouté` : 'Bot ajouté'),
  targetKey: (record) => (record?.botId ? `bot:${record.botId}` : null),
};

const voiceKick = {
  key: 'voiceKick',
  // Discord REGROUPE les déconnexions et déplacements (26/27 : options.count incrémenté sur la
  // même entrée) : aucune entrée n'est classée par le pipeline. src/events/securVoice.js relit le
  // journal (lecture différée et bornée) et signale le delta de count à secur.signal.
  auditTypes: [],
  priority: 5,
  classify: () => null,
  describe: (record) => `${record?.count ?? 1} membre(s) ${record?.type === AuditLogEvent.MemberMove ? 'déplacé(s)' : 'déconnecté(s)'} du vocal`,
  targetKey: () => null,
};

module.exports = [ban, unban, kick, bot, voiceKick];
module.exports.rememberDeparture = rememberDeparture;
module.exports.forgetGuild = forgetGuild;
module.exports.isRecentTarget = isRecentTarget;
module.exports.pruneCount = pruneCount;
module.exports.departures = departures;
module.exports.RECENT_JOIN_MS = RECENT_JOIN_MS;
