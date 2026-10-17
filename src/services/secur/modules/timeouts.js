'use strict';

const { AuditLogEvent } = require('discord.js');
const St = require('../structure');
const { isRecentTarget } = require('./members');

/**
 * Modules Secur ajoutés par la revue n° 7 (S16) :
 *  - timeout : exclusions temporaires posées en masse (audit 24, changement
 *    communication_disabled_until vers une date future). Une levée de timeout, un pseudo ou un
 *    changement vocal ne sont jamais comptés ; exclure un arrivant récent (raid) non plus.
 *    Annulation : le timeout est levé s'il est toujours celui posé par l'auteur.
 *  - threadDelete : fils et posts de forum supprimés (audit 112). Sanction seule (un fil supprimé
 *    ne revient pas avec ses messages).
 */

const REASON = 'Secur : annulation (anti-nuke)';
const SNOWFLAKE = /^\d{17,20}$/;

/** Fin du timeout posé par une entrée 24 (ms), ou null (levée, autre changement). Pur. */
function timeoutUntil(entry, at = Date.now()) {
  const change = (entry?.changes ?? []).find((c) => c?.key === 'communication_disabled_until');
  if (!change?.new) return null;
  const until = Date.parse(change.new);
  return Number.isFinite(until) && until > at ? until : null;
}

const timeout = {
  key: 'timeout',
  auditTypes: [AuditLogEvent.MemberUpdate],
  priority: 5,
  classify(entry, guild, ctx) {
    const targetId = entry.targetId ?? null;
    if (!targetId || targetId === guild.ownerId || targetId === ctx.client?.user?.id) return null;
    const at = Number.isFinite(ctx.at) ? ctx.at : Date.now();
    const until = timeoutUntil(entry, at);
    if (!until) return null;
    if (isRecentTarget(guild, targetId, ctx)) return null; // raider exclu par un modérateur
    return { weight: 1, record: { targetId, until } };
  },
  async undo(guild, record) {
    const userId = record?.targetId;
    if (!SNOWFLAKE.test(String(userId ?? ''))) return { ok: false, note: 'Exclusion temporaire sans cible lisible.' };
    const member = guild.members?.cache?.get?.(userId) ?? (await guild.members?.fetch?.(userId).catch(() => null));
    if (!member) return { ok: true, changed: false }; // parti : plus rien à lever
    const current = member.communicationDisabledUntilTimestamp ?? null;
    if (!current || current <= Date.now()) return { ok: true, changed: false }; // déjà levé
    // Modifié depuis (autre durée posée par quelqu'un d'autre) : on s'abstient.
    if (Number.isFinite(record.until) && Math.abs(current - record.until) > 2_000) return { ok: true, changed: false };
    if (member.moderatable === false) return { ok: false, note: `Timeout de <@${userId}> non levé : membre au-dessus de moi ou permission manquante.` };
    try {
      await member.timeout(null, REASON);
      return { ok: true };
    } catch (e) {
      return { ok: false, note: `Timeout de <@${userId}> non levé : ${String(e?.message ?? e).slice(0, 100)}.` };
    }
  },
  describe: (record) => `Exclusion temporaire de <@${record?.targetId}>`,
  targetKey: (record) => (record?.targetId ? `timeout:${record.targetId}` : null),
};

const threadDelete = {
  key: 'threadDelete',
  auditTypes: [AuditLogEvent.ThreadDelete],
  priority: 3,
  classify(entry) {
    if (!entry.targetId) return null;
    return { weight: 1, record: { threadId: entry.targetId, name: St.changeValue(entry, 'name', 'old') ?? null } };
  },
  describe: (record) => `Fil supprimé${record?.name ? ` : ${record.name}` : ''}`,
  targetKey: () => null,
};

module.exports = [timeout, threadDelete];
module.exports.timeoutUntil = timeoutUntil;
