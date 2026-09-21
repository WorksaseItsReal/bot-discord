'use strict';

class TempVoiceRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      'INSERT OR REPLACE INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)',
    );
    this.getStmt = db.prepare('SELECT * FROM temp_voice WHERE channel_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM temp_voice WHERE channel_id = ?');
    this.allStmt = db.prepare('SELECT * FROM temp_voice');
  }

  create(channelId, guildId, ownerId) {
    this.insertStmt.run(channelId, guildId, ownerId, Date.now());
  }

  get(channelId) {
    return this.getStmt.get(channelId);
  }

  delete(channelId) {
    this.deleteStmt.run(channelId);
  }

  all() {
    return this.allStmt.all();
  }
}

module.exports = { TempVoiceRepository };
