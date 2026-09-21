'use strict';

const { PermissionFlagsBits } = require('discord.js');

/**
 * Récupère l'exécuteur d'une action récente via l'audit log.
 * @param {import('discord.js').Guild} guild
 * @param {number} auditType AuditLogEvent
 * @param {string} [targetId]
 * @returns {Promise<string|null>} id de l'exécuteur ou null
 */
async function fetchExecutor(guild, auditType, targetId) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    const entry = logs.entries.find(
      (e) => (!targetId || e.target?.id === targetId) && Date.now() - e.createdTimestamp < 10_000,
    );
    return entry?.executor?.id ?? null;
  } catch {
    return null;
  }
}

module.exports = { fetchExecutor };
