'use strict';

class RoleMenuRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO role_menus (guild_id, channel_id, message_id, data, created_at)
       VALUES (@guildId, @channelId, @messageId, @data, @createdAt)`,
    );
    this.setMessageStmt = db.prepare('UPDATE role_menus SET message_id = ? WHERE id = ?');
    this.byMessageStmt = db.prepare('SELECT * FROM role_menus WHERE message_id = ?');
    this.listStmt = db.prepare('SELECT * FROM role_menus WHERE guild_id = ? ORDER BY created_at DESC');
  }

  create(data) {
    return Number(this.insertStmt.run({ messageId: null, ...data, data: JSON.stringify(data.data), createdAt: Date.now() }).lastInsertRowid);
  }

  setMessage(id, messageId) {
    this.setMessageStmt.run(messageId, id);
  }

  getByMessage(messageId) {
    const row = this.byMessageStmt.get(messageId);
    if (row) row.data = JSON.parse(row.data);
    return row;
  }

  list(guildId) {
    return this.listStmt.all(guildId).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
}

module.exports = { RoleMenuRepository };
