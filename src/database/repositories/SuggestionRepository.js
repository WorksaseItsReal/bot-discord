'use strict';

class SuggestionRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO suggestions (guild_id, channel_id, message_id, author_id, content, status, created_at)
       VALUES (@guildId, @channelId, @messageId, @authorId, @content, 'pending', @createdAt)`,
    );
    this.setMessageStmt = db.prepare('UPDATE suggestions SET message_id = ? WHERE id = ?');
    this.byIdStmt = db.prepare('SELECT * FROM suggestions WHERE id = ?');
    this.byMessageStmt = db.prepare('SELECT * FROM suggestions WHERE message_id = ?');
    this.listStmt = db.prepare('SELECT * FROM suggestions WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?');
    this.setStatusStmt = db.prepare(
      'UPDATE suggestions SET status = @status, decision_reason = @reason, decided_by = @by, decided_at = @at WHERE id = @id',
    );
    this.deleteStmt = db.prepare('DELETE FROM suggestions WHERE id = ?');
    this.deleteVotesStmt = db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ?');
    this.voteStmt = db.prepare(
      `INSERT INTO suggestion_votes (suggestion_id, user_id, value) VALUES (@id, @userId, @value)
       ON CONFLICT(suggestion_id, user_id) DO UPDATE SET value = @value`,
    );
    this.tallyStmt = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up,
         COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down
       FROM suggestion_votes WHERE suggestion_id = ?`,
    );
  }

  create(data) {
    return Number(this.insertStmt.run({ ...data, createdAt: Date.now() }).lastInsertRowid);
  }

  setMessage(id, messageId) {
    this.setMessageStmt.run(messageId, id);
  }

  get(id) {
    return this.byIdStmt.get(id);
  }

  getByMessage(messageId) {
    return this.byMessageStmt.get(messageId);
  }

  list(guildId, limit = 15) {
    return this.listStmt.all(guildId, limit);
  }

  /** Supprime une suggestion et ses votes (ex : message jamais publié). */
  delete(id) {
    this.deleteVotesStmt.run(id);
    return this.deleteStmt.run(id).changes > 0;
  }

  /**
   * @param {number} id
   * @param {string} status pending | approved | denied
   * @param {{ reason?: string|null, by?: string|null }} [decision] raison et auteur (mention) de la décision
   */
  setStatus(id, status, decision = {}) {
    const decided = status !== 'pending';
    this.setStatusStmt.run({
      id,
      status,
      reason: decided ? decision.reason ?? null : null,
      by: decided ? decision.by ?? null : null,
      at: decided ? Date.now() : null,
    });
  }

  vote(id, userId, value) {
    this.voteStmt.run({ id, userId, value });
    return this.tally(id);
  }

  tally(id) {
    return this.tallyStmt.get(id);
  }
}

module.exports = { SuggestionRepository };
