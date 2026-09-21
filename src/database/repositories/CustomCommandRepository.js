'use strict';

class CustomCommandRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO custom_commands (guild_id, name, content, is_embed, created_by, created_at)
       VALUES (@guildId, @name, @content, @isEmbed, @createdBy, @createdAt)
       ON CONFLICT(guild_id, name) DO UPDATE SET content = @content, is_embed = @isEmbed`,
    );
    this.getStmt = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?');
    this.listStmt = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY name');
    this.deleteStmt = db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?');
  }

  set(data) {
    this.upsertStmt.run({ isEmbed: 0, createdBy: null, ...data, createdAt: Date.now() });
  }

  get(guildId, name) {
    return this.getStmt.get(guildId, name);
  }

  list(guildId) {
    return this.listStmt.all(guildId);
  }

  delete(guildId, name) {
    return this.deleteStmt.run(guildId, name).changes > 0;
  }
}

module.exports = { CustomCommandRepository };
