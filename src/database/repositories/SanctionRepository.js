'use strict';

/**
 * Historique des sanctions. Toutes les requêtes sont paramétrées par guildId
 * afin de garantir l'isolation multi-serveurs.
 */
class SanctionRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration_ms, expires_at, active, created_at)
       VALUES (@guildId, @userId, @moderatorId, @type, @reason, @durationMs, @expiresAt, 1, @createdAt)`,
    );
    this.byUserStmt = db.prepare(
      'SELECT * FROM sanctions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    this.byIdStmt = db.prepare('SELECT * FROM sanctions WHERE id = ? AND guild_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM sanctions WHERE guild_id = ? AND user_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM sanctions WHERE id = ? AND guild_id = ?');
    this.clearUserStmt = db.prepare('DELETE FROM sanctions WHERE guild_id = ? AND user_id = ?');
    this.deactivateStmt = db.prepare('UPDATE sanctions SET active = 0 WHERE id = ?');
    this.dueStmt = db.prepare(
      'SELECT * FROM sanctions WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?',
    );
    this.activeByTypeStmt = db.prepare(
      "SELECT * FROM sanctions WHERE guild_id = ? AND type = ? AND active = 1 ORDER BY created_at DESC",
    );
  }

  /**
   * @param {{guildId:string,userId:string,moderatorId:string,type:string,reason?:string,durationMs?:number|null,expiresAt?:number|null}} data
   * @returns {number} id de la sanction créée
   */
  create(data) {
    const info = this.insertStmt.run({
      guildId: data.guildId,
      userId: data.userId,
      moderatorId: data.moderatorId,
      type: data.type,
      reason: data.reason ?? null,
      durationMs: data.durationMs ?? null,
      expiresAt: data.expiresAt ?? null,
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  listByUser(guildId, userId, limit = 25) {
    return this.byUserStmt.all(guildId, userId, limit);
  }

  get(guildId, id) {
    return this.byIdStmt.get(id, guildId);
  }

  count(guildId, userId) {
    return this.countStmt.get(guildId, userId).n;
  }

  delete(guildId, id) {
    return this.deleteStmt.run(id, guildId).changes > 0;
  }

  clearUser(guildId, userId) {
    return this.clearUserStmt.run(guildId, userId).changes;
  }

  deactivate(id) {
    this.deactivateStmt.run(id);
  }

  /** Sanctions temporaires arrivées à expiration (pour le scheduler). */
  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  listActiveByType(guildId, type) {
    return this.activeByTypeStmt.all(guildId, type);
  }
}

module.exports = { SanctionRepository };
