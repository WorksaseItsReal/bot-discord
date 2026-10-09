'use strict';

/** Sortes d'actions temporaires sur un salon (ou le serveur pour un lockdown). */
const TIMED_KINDS = Object.freeze(['lock', 'slowmode', 'lockdown']);

function decode(row) {
  if (!row) return null;
  let data = {};
  try {
    const parsed = JSON.parse(row.data ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    data = {};
  }
  return { ...row, data };
}

/**
 * Actions temporaires (/lock duree, /slowmode pendant, /lockdown enable duree) : levées
 * par le SchedulerService à l'échéance (TimedLockService). Une seule ligne ACTIVE par
 * (serveur, sorte, cible) : programmer à nouveau remplace l'échéance ; une action
 * manuelle (unlock, nouveau mode lent, lockdown levé) annule la ligne.
 */
class TimedActionRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO timed_channel_actions (guild_id, channel_id, kind, data, moderator_id, expires_at, created_at)
       VALUES (@guildId, @channelId, @kind, @data, @moderatorId, @expiresAt, @createdAt)`,
    );
    this.activeForStmt = db.prepare('SELECT * FROM timed_channel_actions WHERE guild_id = ? AND kind = ? AND channel_id = ? AND active = 1');
    this.byIdStmt = db.prepare('SELECT * FROM timed_channel_actions WHERE id = ?');
    this.dueStmt = db.prepare('SELECT * FROM timed_channel_actions WHERE active = 1 AND expires_at <= ? ORDER BY expires_at ASC LIMIT 200');
    this.activeByGuildStmt = db.prepare('SELECT * FROM timed_channel_actions WHERE guild_id = ? AND active = 1 ORDER BY expires_at ASC LIMIT 50');
    this.closeStmt = db.prepare('UPDATE timed_channel_actions SET active = 0, ended_at = ?, end_reason = ? WHERE id = ? AND active = 1');
    this.closeForStmt = db.prepare('UPDATE timed_channel_actions SET active = 0, ended_at = ?, end_reason = ? WHERE guild_id = ? AND kind = ? AND channel_id = ? AND active = 1');
    this.scheduleTx = db.transaction((row) => {
      this.closeForStmt.run(row.createdAt, 'replaced', row.guildId, row.kind, row.channelId);
      return Number(this.insertStmt.run(row).lastInsertRowid);
    });
  }

  /**
   * Programme (ou reprogramme) la levée d'une action. Une ligne active pour la même
   * cible est close (« replaced ») dans la même transaction.
   * @returns {number} identifiant
   */
  schedule({ guildId, channelId, kind, data = {}, moderatorId = null, expiresAt, now = Date.now() }) {
    if (!TIMED_KINDS.includes(kind)) throw new Error(`Sorte d'action temporaire inconnue : ${kind}`);
    return this.scheduleTx({ guildId, channelId, kind, data: JSON.stringify(data ?? {}), moderatorId, expiresAt, createdAt: now });
  }

  /** Ligne active d'une cible (ou null). */
  activeFor(guildId, kind, channelId) {
    return decode(this.activeForStmt.get(guildId, kind, channelId));
  }

  /** Relecture d'une ligne (scheduler). */
  byId(id) {
    return decode(this.byIdStmt.get(id));
  }

  /** Lignes actives arrivées à échéance (200 au plus par passage). */
  findDue(now = Date.now()) {
    return this.dueStmt.all(now).map(decode);
  }

  /** Actions temporaires en cours d'un serveur. */
  listActive(guildId) {
    return this.activeByGuildStmt.all(guildId).map(decode);
  }

  /** Clôt une ligne active. @returns {boolean} true si elle l'était encore. */
  close(id, reason, now = Date.now()) {
    return this.closeStmt.run(now, reason, id).changes > 0;
  }

  /** Annule la levée programmée d'une cible. @returns {boolean} true si une ligne était active. */
  cancel(guildId, kind, channelId, reason = 'cancelled', now = Date.now()) {
    return this.closeForStmt.run(now, reason, guildId, kind, channelId).changes > 0;
  }
}

module.exports = { TimedActionRepository, TIMED_KINDS };
