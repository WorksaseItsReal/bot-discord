'use strict';

/**
 * Compteur de strikes par membre, utilisé pour l'escalade automatique
 * des sanctions (voir StrikeService).
 */
class StrikeRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.getStmt = db.prepare('SELECT count FROM strikes WHERE guild_id = ? AND user_id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO strikes (guild_id, user_id, count, updated_at) VALUES (@guildId, @userId, @count, @updatedAt)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET count = @count, updated_at = @updatedAt`,
    );
    this.resetStmt = db.prepare('DELETE FROM strikes WHERE guild_id = ? AND user_id = ?');
  }

  get(guildId, userId) {
    const row = this.getStmt.get(guildId, userId);
    return row ? row.count : 0;
  }

  set(guildId, userId, count) {
    this.upsertStmt.run({ guildId, userId, count, updatedAt: Date.now() });
    return count;
  }

  add(guildId, userId, delta = 1) {
    const next = Math.max(0, this.get(guildId, userId) + delta);
    return this.set(guildId, userId, next);
  }

  reset(guildId, userId) {
    this.resetStmt.run(guildId, userId);
  }
}

module.exports = { StrikeRepository };
