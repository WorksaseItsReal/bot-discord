'use strict';

/**
 * Rôles temporaires (/role temporaire). Une ligne active par (serveur, membre, rôle) ;
 * le SchedulerService retire le rôle à l'échéance puis clôt la ligne.
 */
class TempRoleRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO temp_roles (guild_id, user_id, role_id, moderator_id, reason, expires_at, created_at)
       VALUES (@guildId, @userId, @roleId, @moderatorId, @reason, @expiresAt, @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM temp_roles WHERE id = ? AND guild_id = ?');
    this.byIdStmt = db.prepare('SELECT * FROM temp_roles WHERE id = ?');
    this.activeForStmt = db.prepare('SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ? AND active = 1');
    this.activeByMemberStmt = db.prepare('SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? AND active = 1 ORDER BY expires_at ASC');
    this.activeByGuildStmt = db.prepare('SELECT * FROM temp_roles WHERE guild_id = ? AND active = 1 ORDER BY expires_at ASC LIMIT ? OFFSET ?');
    this.countGuildStmt = db.prepare('SELECT COUNT(*) AS n FROM temp_roles WHERE guild_id = ? AND active = 1');
    this.countMemberStmt = db.prepare('SELECT COUNT(*) AS n FROM temp_roles WHERE guild_id = ? AND user_id = ? AND active = 1');
    this.activeByMemberPageStmt = db.prepare('SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? AND active = 1 ORDER BY expires_at ASC LIMIT ? OFFSET ?');
    this.dueStmt = db.prepare('SELECT * FROM temp_roles WHERE active = 1 AND expires_at <= ? ORDER BY expires_at ASC LIMIT 200');
    this.closeStmt = db.prepare('UPDATE temp_roles SET active = 0, ended_at = ?, end_reason = ? WHERE id = ? AND active = 1');
    this.setExpiryStmt = db.prepare('UPDATE temp_roles SET expires_at = ?, reason = COALESCE(?, reason), moderator_id = COALESCE(?, moderator_id) WHERE id = ? AND active = 1');
  }

  /**
   * Attribue (ou renouvelle) un rôle temporaire. Une ligne déjà active pour ce rôle
   * voit son échéance remplacée.
   * @returns {{ id: number, renewed: boolean, previous: object|null }}
   */
  upsert({ guildId, userId, roleId, moderatorId = null, reason = null, expiresAt, now = Date.now() }) {
    return this.db.transaction(() => {
      const previous = this.activeForStmt.get(guildId, userId, roleId) ?? null;
      if (previous) {
        this.setExpiryStmt.run(expiresAt, reason, moderatorId, previous.id);
        return { id: previous.id, renewed: true, previous };
      }
      const info = this.insertStmt.run({ guildId, userId, roleId, moderatorId, reason, expiresAt, createdAt: now });
      return { id: Number(info.lastInsertRowid), renewed: false, previous: null };
    })();
  }

  /** Ligne d'un serveur (null si absente ou d'un autre serveur). */
  get(guildId, id) {
    return this.getStmt.get(id, guildId) ?? null;
  }

  /** Relecture d'une ligne par identifiant (scheduler). */
  byId(id) {
    return this.byIdStmt.get(id) ?? null;
  }

  activeFor(guildId, userId, roleId) {
    return this.activeForStmt.get(guildId, userId, roleId) ?? null;
  }

  activeByMember(guildId, userId) {
    return this.activeByMemberStmt.all(guildId, userId);
  }

  /** Page de rôles temporaires actifs (d'un membre si `userId`). */
  page(guildId, { userId = null, limit = 10, offset = 0 } = {}) {
    return userId ? this.activeByMemberPageStmt.all(guildId, userId, limit, offset) : this.activeByGuildStmt.all(guildId, limit, offset);
  }

  count(guildId, userId = null) {
    return (userId ? this.countMemberStmt.get(guildId, userId) : this.countGuildStmt.get(guildId)).n;
  }

  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  /** Clôt une ligne active. @returns {boolean} true si elle l'était encore. */
  close(id, reason, now = Date.now()) {
    return this.closeStmt.run(now, reason, id).changes > 0;
  }

  /** Nouvelle échéance d'une ligne active. @returns {boolean} */
  setExpiry(id, expiresAt, moderatorId = null) {
    return this.setExpiryStmt.run(expiresAt, null, moderatorId, id).changes > 0;
  }
}

module.exports = { TempRoleRepository };
