'use strict';

const { PermissionFlagsBits } = require('discord.js');

/** Entrées lues par recherche : assez pour retrouver la bonne cible pendant une rafale d'actions. */
const AUDIT_FETCH_LIMIT = 25;

/**
 * Récupère l'exécuteur d'une action récente via l'audit log (affichage « Par » des logs).
 * La détection AntiRaid n'utilise PAS cette fonction : elle est alimentée par
 * l'événement `guildAuditLogEntryCreate` (voir events/banEvents.js).
 * @param {import('discord.js').Guild} guild
 * @param {number} auditType AuditLogEvent
 * @param {string} [targetId]
 * @returns {Promise<string|null>} id de l'exécuteur ou null
 */
async function fetchExecutor(guild, auditType, targetId) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: AUDIT_FETCH_LIMIT });
    const entry = logs.entries.find(
      (e) => (!targetId || (e.targetId ?? e.target?.id) === targetId) && Date.now() - e.createdTimestamp < 10_000,
    );
    return entry?.executorId ?? entry?.executor?.id ?? null;
  } catch {
    return null;
  }
}

module.exports = { fetchExecutor, AUDIT_FETCH_LIMIT };
