'use strict';

/**
 * Accès aux configurations de serveur. La configuration est stockée en JSON
 * dans la colonne `data`. La fusion avec les valeurs par défaut est faite au
 * niveau du service (ConfigService).
 */
class GuildConfigRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.getStmt = db.prepare('SELECT data FROM guild_config WHERE guild_id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO guild_config (guild_id, data, updated_at) VALUES (@guildId, @data, @updatedAt)
       ON CONFLICT(guild_id) DO UPDATE SET data = @data, updated_at = @updatedAt`,
    );
    this.deleteStmt = db.prepare('DELETE FROM guild_config WHERE guild_id = ?');
  }

  /** @returns {object|null} config brute (sans defaults) */
  get(guildId) {
    const row = this.getStmt.get(guildId);
    return row ? JSON.parse(row.data) : null;
  }

  set(guildId, data) {
    this.upsertStmt.run({ guildId, data: JSON.stringify(data), updatedAt: Date.now() });
  }

  delete(guildId) {
    this.deleteStmt.run(guildId);
  }
}

module.exports = { GuildConfigRepository };
