'use strict';

const { createLogger } = require('../../core/logger');

const logger = createLogger('config');

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
    // json_valid d'abord : une ligne corrompue ne doit pas faire échouer toute la requête.
    this.leftBeforeStmt = db.prepare(
      `SELECT guild_id FROM guild_config
       WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$._leftAt') END) <= ?`,
    );
  }

  /**
   * Lecture détaillée : distingue « pas de ligne » d'une ligne au JSON corrompu
   * (dont le texte brut est renvoyé pour sauvegarde avant écrasement).
   * @returns {{ data: object|null, raw: string|null, corrupted: boolean }}
   */
  read(guildId) {
    const row = this.getStmt.get(guildId);
    if (!row) return { data: null, raw: null, corrupted: false };
    try {
      const data = JSON.parse(row.data);
      // Un JSON valide mais non objet (null, tableau, nombre…) est tout aussi inutilisable.
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`type inattendu (${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data})`);
      return { data, raw: row.data, corrupted: false };
    } catch (err) {
      logger.error(`Configuration JSON corrompue pour le serveur ${guildId} (valeurs par défaut utilisées) :`, err?.message);
      return { data: null, raw: row.data, corrupted: true };
    }
  }

  /** @returns {object|null} config brute (sans defaults) */
  get(guildId) {
    return this.read(guildId).data;
  }

  /**
   * Serveurs quittés (`_leftAt` posé par guildDelete) avant `timestamp`.
   * @returns {string[]}
   */
  findLeftBefore(timestamp) {
    return this.leftBeforeStmt.all(timestamp).map((r) => r.guild_id);
  }

  set(guildId, data) {
    this.upsertStmt.run({ guildId, data: JSON.stringify(data), updatedAt: Date.now() });
  }

  delete(guildId) {
    this.deleteStmt.run(guildId);
  }
}

module.exports = { GuildConfigRepository };
