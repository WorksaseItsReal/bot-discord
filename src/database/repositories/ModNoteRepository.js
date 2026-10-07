'use strict';

/**
 * Notes de modération internes : de simples mémos d'équipe, sans aucun effet sur
 * le membre (pas de strike, pas de DM, pas de log public). Une note peut être
 * rattachée à une sanction (`sanction_id`, remis à NULL si la sanction est supprimée).
 * Toutes les requêtes sont paramétrées par guildId (isolation multi-serveurs).
 */
class ModNoteRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO mod_notes (guild_id, user_id, author_id, sanction_id, content, created_at)
       VALUES (@guildId, @userId, @authorId, @sanctionId, @content, @createdAt)`,
    );
    this.byUserStmt = db.prepare(
      'SELECT * FROM mod_notes WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM mod_notes WHERE guild_id = ? AND user_id = ?');
    this.bySanctionStmt = db.prepare(
      'SELECT * FROM mod_notes WHERE guild_id = ? AND sanction_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    this.countBySanctionStmt = db.prepare('SELECT COUNT(*) AS n FROM mod_notes WHERE guild_id = ? AND sanction_id = ?');
  }

  /**
   * @param {{ guildId: string, userId: string, authorId: string, content: string, sanctionId?: number|null }} data
   * @returns {number} id de la note
   */
  create(data) {
    const info = this.insertStmt.run({
      guildId: data.guildId,
      userId: data.userId,
      authorId: data.authorId,
      sanctionId: data.sanctionId ?? null,
      content: data.content,
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  listByUser(guildId, userId, limit = 5, offset = 0) {
    return this.byUserStmt.all(guildId, userId, limit, offset);
  }

  count(guildId, userId) {
    return this.countStmt.get(guildId, userId).n;
  }

  listBySanction(guildId, sanctionId, limit = 5) {
    return this.bySanctionStmt.all(guildId, sanctionId, limit);
  }

  countBySanction(guildId, sanctionId) {
    return this.countBySanctionStmt.get(guildId, sanctionId).n;
  }
}

module.exports = { ModNoteRepository };
