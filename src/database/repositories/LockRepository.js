'use strict';

class LockRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO lock_state (guild_id, channel_id, data, created_at) VALUES (@guildId, @channelId, @data, @createdAt)
       ON CONFLICT(guild_id, channel_id) DO UPDATE SET data = @data, created_at = @createdAt`,
    );
    this.getStmt = db.prepare('SELECT * FROM lock_state WHERE guild_id = ? AND channel_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM lock_state WHERE guild_id = ? AND channel_id = ?');
    this.listStmt = db.prepare('SELECT * FROM lock_state WHERE guild_id = ?');
  }

  save(guildId, channelId, data) {
    this.upsertStmt.run({ guildId, channelId, data: JSON.stringify(data), createdAt: Date.now() });
  }

  get(guildId, channelId) {
    const row = this.getStmt.get(guildId, channelId);
    if (row) row.data = JSON.parse(row.data);
    return row;
  }

  delete(guildId, channelId) {
    this.deleteStmt.run(guildId, channelId);
  }

  list(guildId) {
    return this.listStmt.all(guildId).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
}

module.exports = { LockRepository };
