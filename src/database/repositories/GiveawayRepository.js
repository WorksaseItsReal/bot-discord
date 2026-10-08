'use strict';

class GiveawayRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winners, host_id, required_role, forbidden_role, ends_at, created_at)
       VALUES (@guildId, @channelId, @messageId, @prize, @winners, @hostId, @requiredRole, @forbiddenRole, @endsAt, @createdAt)`,
    );
    this.setMessageStmt = db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?');
    this.byIdStmt = db.prepare('SELECT * FROM giveaways WHERE id = ?');
    // Nombre de participants inclus (entry_count) : une seule requête pour toute la liste.
    this.activeByGuildStmt = db.prepare(
      `SELECT g.*, COUNT(e.user_id) AS entry_count
       FROM giveaways g LEFT JOIN giveaway_entries e ON e.giveaway_id = g.id
       WHERE g.guild_id = ? AND g.ended = 0
       GROUP BY g.id ORDER BY g.ends_at ASC`,
    );
    this.dueStmt = db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?');
    this.markEndedStmt = db.prepare('UPDATE giveaways SET ended = 1 WHERE id = ? AND ended = 0');
    this.deleteStmt = db.prepare('DELETE FROM giveaways WHERE id = ?');
    this.deleteEntriesStmt = db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ?');
    this.addEntryStmt = db.prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)');
    this.removeEntryStmt = db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?');
    this.hasEntryStmt = db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?');
    this.entriesStmt = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?');
    this.countEntriesStmt = db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?');
    this.addWinnerStmt = db.prepare('INSERT OR IGNORE INTO giveaway_winners (giveaway_id, user_id, drawn_at) VALUES (?, ?, ?)');
    this.winnersStmt = db.prepare('SELECT user_id FROM giveaway_winners WHERE giveaway_id = ?');
    this.markAnnouncedStmt = db.prepare('UPDATE giveaways SET announced_at = ? WHERE id = ? AND announced_at IS NULL');
    this.addWinnersTx = db.transaction((id, userIds) => {
      const now = Date.now();
      for (const u of userIds) this.addWinnerStmt.run(id, u, now);
    });
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

  /** Giveaways en cours du serveur, avec `entry_count`. */
  listActive(guildId) {
    return this.activeByGuildStmt.all(guildId);
  }

  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  /**
   * Marque le giveaway comme terminé de façon atomique.
   * @returns {boolean} true si CET appel l'a terminé (false s'il l'était déjà).
   */
  markEnded(id) {
    return this.markEndedStmt.run(id).changes > 0;
  }

  /** Supprime un giveaway (et ses participations), ex : message jamais envoyé. */
  delete(id) {
    this.deleteEntriesStmt.run(id);
    return this.deleteStmt.run(id).changes > 0;
  }

  /** Inscription idempotente. @returns {boolean} true si le membre vient d'être inscrit. */
  addEntry(id, userId) {
    return this.addEntryStmt.run(id, userId).changes > 0;
  }

  /** @returns {boolean} true si une participation a été retirée. */
  removeEntry(id, userId) {
    return this.removeEntryStmt.run(id, userId).changes > 0;
  }

  hasEntry(id, userId) {
    return Boolean(this.hasEntryStmt.get(id, userId));
  }

  /** Mémorise la publication de l'annonce de fin (première fois seulement). */
  markAnnounced(id, at = Date.now()) {
    return this.markAnnouncedStmt.run(at, id).changes > 0;
  }

  toggleEntry(id, userId) {
    if (this.hasEntryStmt.get(id, userId)) {
      this.removeEntryStmt.run(id, userId);
      return false;
    }
    this.addEntryStmt.run(id, userId);
    return true;
  }

  entries(id) {
    return this.entriesStmt.all(id).map((r) => r.user_id);
  }

  /** Mémorise des gagnants tirés (premier tirage ou relance). */
  addWinners(id, userIds) {
    if (userIds?.length) this.addWinnersTx(id, userIds);
  }

  /** Tous les gagnants déjà tirés pour ce giveaway. */
  winners(id) {
    return this.winnersStmt.all(id).map((r) => r.user_id);
  }

  countEntries(id) {
    return this.countEntriesStmt.get(id).n;
  }
}

module.exports = { GiveawayRepository };
