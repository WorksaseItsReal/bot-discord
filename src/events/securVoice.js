'use strict';

const { AuditLogEvent, PermissionFlagsBits, SnowflakeUtil } = require('discord.js');
const { createLogger } = require('../core/logger');
const members = require('../services/secur/modules/members');

const logger = createLogger('secur:voice');

/**
 * Secur, écouteurs « membres » (SEC5).
 *
 * 1. Déconnexions vocales (module voiceKick, audit 27 MemberDisconnect seulement : un déplacement
 *    laisse le membre connecté et n'est pas destructeur). Discord REGROUPE ces entrées d'audit : il
 *    incrémente `options.count` de la même entrée au lieu d'en créer une nouvelle (pas d'événement
 *    GUILD_AUDIT_LOG_ENTRY_CREATE). Quand un membre quitte un salon vocal, et seulement si le module
 *    est actif, une lecture DIFFÉRÉE (1,5 s) de fetchAuditLogs({ type, limit: 10 }) est lancée, une
 *    seule à la fois par serveur. Le delta de count de chaque entrée (mémoire PAR SERVEUR de 100
 *    entrées, 10 min : les lectures des autres serveurs n'évincent jamais une entrée encore lue) est
 *    attribué à son auteur par secur.signal. Une entrée vue pour la première fois plus de 60 s après
 *    sa création (bot redémarré) sert seulement de référence : jamais de sanction pour des actions
 *    anciennes. Approximatif par nature (débit du journal d'audit, regroupement).
 * 2. Départs d'arrivants récents (modules ban / kick) : leur arrivée est gardée 10 min, car le
 *    membre a déjà quitté le cache quand l'entrée d'audit du ban ou du kick arrive.
 * 3. Arrivée d'un bot que le module bot a déjà refusé (entrée d'audit BotAdd reçue avant
 *    l'arrivée) : il est expulsé tout de suite.
 */

/** Délai avant la lecture du journal (Discord écrit l'entrée après l'événement vocal). Modifiable par les tests. */
const timing = { delayMs: 1_500 };
/** Déconnexions seulement (SECUR_MODULES.voiceKick.auditTypes) : un déplacement n'est pas compté. */
const VOICE_TYPES = [AuditLogEvent.MemberDisconnect];
const COUNT_TTL_MS = 10 * 60_000;
const READ_LIMIT = 10;
/** Entrées gardées PAR SERVEUR (au moins READ_LIMIT × VOICE_TYPES.length : une entrée encore lue n'est jamais évincée). */
const MAX_COUNTS = 100;
/** Serveurs suivis au plus (les moins récemment lus sortent d'abord). */
const MAX_GUILDS = 5_000;
/** Une entrée vue pour la première fois n'est attribuée que si elle a moins de 60 s. */
const FRESH_MS = 60_000;

/**
 * Comptes déjà vus, par serveur : guildId → { touchedAt, entries: Map(entryId → { count, seenAt }) }
 * (ordre d'insertion = ancienneté, aux deux niveaux).
 */
const seen = new Map();
/** Lectures par serveur : guildId → { timer, running, again }. */
const reads = new Map();

function entryTime(entry, fallback) {
  if (Number.isFinite(entry?.createdTimestamp)) return entry.createdTimestamp;
  try {
    return SnowflakeUtil.timestampFrom(String(entry.id));
  } catch {
    return fallback;
  }
}

/** Mémoire d'un serveur (créée au besoin, remise en fin d'ordre) ; serveurs oubliés après 10 min sans lecture. */
function guildSeen(guildId, now) {
  let st = seen.get(guildId);
  if (st) seen.delete(guildId);
  else st = { touchedAt: now, entries: new Map() };
  st.touchedAt = now;
  seen.set(guildId, st);
  for (const [id, other] of seen) {
    if (seen.size <= MAX_GUILDS && now - other.touchedAt < COUNT_TTL_MS) break;
    if (id !== guildId) seen.delete(id);
  }
  return st.entries;
}

function pruneSeen(entries, now) {
  for (const [key, v] of entries) {
    if (entries.size <= MAX_COUNTS && now - v.seenAt < COUNT_TTL_MS) break;
    entries.delete(key);
  }
}

/** Nombre d'entrées gardées pour un serveur. */
function seenSize(guildId) {
  return seen.get(guildId)?.entries.size ?? 0;
}

/**
 * Nouvelles actions d'une entrée regroupée depuis la dernière lecture (0 si rien de neuf). Une
 * entrée inconnue compte entièrement si elle a moins de 60 s, sinon elle sert de référence.
 */
function countDelta(guildId, entry, now = Date.now()) {
  const raw = Number(entry?.extra?.count ?? entry?.options?.count ?? 1);
  const count = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  const entries = guildSeen(guildId, now);
  const key = String(entry.id);
  const prev = entries.get(key);
  const delta = prev ? Math.max(0, count - prev.count) : now - entryTime(entry, now) <= FRESH_MS ? count : 0;
  entries.delete(key);
  entries.set(key, { count: Math.max(count, prev?.count ?? 0), seenAt: now });
  pruneSeen(entries, now);
  return delta;
}

/** Lit les entrées 27 récentes et signale les nouvelles déconnexions à Secur. @returns {Promise<number>} signaux */
async function readVoiceAudit(client, guild, now = Date.now()) {
  const secur = client.services?.secur;
  if (!secur || secur.stopped || !secur.covers?.(guild.id, 'voiceKick')) return 0;
  const me = guild.members?.me;
  if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return 0;
  const found = [];
  for (const type of VOICE_TYPES) {
    let logs;
    try {
      logs = await guild.fetchAuditLogs({ type, limit: READ_LIMIT });
    } catch (err) {
      logger.debug(`Lecture du journal d'audit (${type}) impossible :`, err?.message);
      continue;
    }
    // Du plus ancien au plus récent : les signaux suivent l'ordre des actions.
    for (const entry of [...(logs?.entries?.values?.() ?? [])].reverse()) {
      const executorId = entry.executorId ?? entry.executor?.id ?? null;
      if (!executorId || executorId === client.user?.id) continue;
      const delta = countDelta(guild.id, entry, now);
      if (delta > 0) found.push({ executorId, type, delta, channelId: entry.extra?.channel?.id ?? null });
    }
  }
  for (const s of found) {
    await secur.signal(guild, s.executorId, 'voiceKick', { type: s.type, count: s.delta, channelId: s.channelId }, { weight: s.delta }).catch((err) => logger.warn('Signal voiceKick :', err?.message));
  }
  return found.length;
}

/** Programme une lecture (une seule à la fois par serveur ; une demande pendant la lecture la relance une fois). */
function schedule(client, guildId) {
  let st = reads.get(guildId);
  if (!st) {
    st = { timer: null, running: false, again: false };
    reads.set(guildId, st);
  }
  if (st.timer || st.running) {
    st.again = true;
    return;
  }
  st.timer = setTimeout(() => {
    run(client, guildId).catch((err) => logger.debug('Lecture voiceKick :', err?.message));
  }, timing.delayMs);
  st.timer.unref?.();
}

async function run(client, guildId) {
  const st = reads.get(guildId);
  if (!st) return;
  st.timer = null;
  st.running = true;
  st.again = false;
  try {
    const guild = client.guilds?.cache?.get?.(guildId);
    if (guild) await readVoiceAudit(client, guild);
  } finally {
    st.running = false;
    if (st.again && !client.services?.secur?.stopped && reads.get(guildId) === st) schedule(client, guildId);
    else if (reads.get(guildId) === st) reads.delete(guildId);
  }
}

/** Serveur quitté : lecture annulée, comptes et départs oubliés. */
function forgetGuild(guildId) {
  if (!guildId) return;
  const st = reads.get(guildId);
  if (st?.timer) clearTimeout(st.timer);
  reads.delete(guildId);
  seen.delete(guildId);
  members.forgetGuild(guildId);
}

module.exports = [
  {
    // Requiert l'intent GuildVoiceStates et la permission « Voir les logs du serveur ».
    name: 'voiceStateUpdate',
    execute(client, oldState, newState) {
      const guild = newState?.guild ?? oldState?.guild;
      // Seule une vraie déconnexion peut produire une entrée 27 : un changement de salon n'est pas lu.
      if (!guild?.id || !oldState?.channelId || newState?.channelId) return;
      if (!client.services?.secur?.covers?.(guild.id, 'voiceKick')) return;
      schedule(client, guild.id);
    },
  },
  {
    // Bot dont l'ajout a déclenché le module bot AVANT son arrivée (entrée d'audit en avance).
    name: 'guildMemberAdd',
    async execute(client, member) {
      if (!member?.user?.bot || !member.guild?.id || !members.takeBotKick(member.guild.id, member.id)) return;
      const res = await members.kickAddedBot(member.guild, member, { client, service: client.services?.secur });
      if (!res.ok) logger.warn(`Bot ${member.id} non expulsé à son arrivée : ${res.note}`);
    },
  },
  {
    name: 'guildMemberRemove',
    execute(client, member) {
      const secur = client.services?.secur;
      const guildId = member?.guild?.id;
      if (!guildId || !(secur?.covers?.(guildId, 'ban') || secur?.covers?.(guildId, 'kick'))) return;
      members.rememberDeparture(member);
    },
  },
  {
    name: 'guildDelete',
    execute(client, guild) {
      if (guild?.available === false) return; // panne Discord passagère : pas un départ
      forgetGuild(guild?.id);
    },
  },
];

module.exports.timing = timing;
module.exports.countDelta = countDelta;
module.exports.readVoiceAudit = readVoiceAudit;
module.exports.forgetGuild = forgetGuild;
module.exports.seen = seen;
module.exports.seenSize = seenSize;
module.exports.VOICE_TYPES = VOICE_TYPES;
module.exports.MAX_COUNTS = MAX_COUNTS;
module.exports.reads = reads;
