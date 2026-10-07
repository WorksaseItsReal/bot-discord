'use strict';

class ModmailRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO modmail_threads (guild_id, user_id, channel_id, status, created_at)
       VALUES (@guildId, @userId, @channelId, 'open', @createdAt)`,
    );
    this.openByUserStmt = db.prepare("SELECT * FROM modmail_threads WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1");
    this.byChannelStmt = db.prepare('SELECT * FROM modmail_threads WHERE channel_id = ? ORDER BY id DESC LIMIT 1');
    this.closeStmt = db.prepare("UPDATE modmail_threads SET status = 'closed' WHERE channel_id = ? AND status = 'open'");
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

  /** @returns {boolean} true si une conversation ouverte a été fermée par cet appel */
  close(channelId) {
    return this.closeStmt.run(channelId).changes > 0;
  }
}

module.exports = { ModmailRepository };
