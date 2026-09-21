'use strict';

class ModmailRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO modmail_threads (guild_id, user_id, channel_id, status, created_at)
       VALUES (@guildId, @userId, @channelId, 'open', @createdAt)`,
    );
    this.openByUserStmt = db.prepare("SELECT * FROM modmail_threads WHERE user_id = ? AND status = 'open'");
    this.byChannelStmt = db.prepare('SELECT * FROM modmail_threads WHERE channel_id = ?');
    this.closeStmt = db.prepare("UPDATE modmail_threads SET status = 'closed' WHERE channel_id = ?");
  }

  create(data) {
    return Number(this.insertStmt.run({ ...data, createdAt: Date.now() }).lastInsertRowid);
  }

  getOpenByUser(userId) {
    return this.openByUserStmt.get(userId);
  }

  getByChannel(channelId) {
    return this.byChannelStmt.get(channelId);
  }

  close(channelId) {
    this.closeStmt.run(channelId);
  }
}

module.exports = { ModmailRepository };
