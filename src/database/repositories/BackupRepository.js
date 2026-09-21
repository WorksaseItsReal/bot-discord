'use strict';

class BackupRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO backups (id, guild_id, name, data, created_by, created_at)
       VALUES (@id, @guildId, @name, @data, @createdBy, @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM backups WHERE id = ? AND guild_id = ?');
    this.listStmt = db.prepare('SELECT id, name, created_by, created_at FROM backups WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?');
    this.deleteStmt = db.prepare('DELETE FROM backups WHERE id = ? AND guild_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM backups WHERE guild_id = ?');
  }

  create(data) {
    this.insertStmt.run({ ...data, data: JSON.stringify(data.data), createdAt: Date.now() });
    return data.id;
  }

  get(guildId, id) {
    const row = this.getStmt.get(id, guildId);
    if (row) row.data = JSON.parse(row.data);
    return row;
  }

  list(guildId, limit = 15) {
    return this.listStmt.all(guildId, limit);
  }

  delete(guildId, id) {
    return this.deleteStmt.run(id, guildId).changes > 0;
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }
}

module.exports = { BackupRepository };
