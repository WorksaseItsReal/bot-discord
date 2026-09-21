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
    this.byMessageStmt = db.prepare('SELECT * FROM giveaways WHERE message_id = ?');
    this.activeByGuildStmt = db.prepare('SELECT * FROM giveaways WHERE guild_id = ? AND ended = 0 ORDER BY ends_at ASC');
    this.dueStmt = db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?');
    this.markEndedStmt = db.prepare('UPDATE giveaways SET ended = 1 WHERE id = ?');
    this.addEntryStmt = db.prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)');
    this.removeEntryStmt = db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?');
    this.hasEntryStmt = db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?');
    this.entriesStmt = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?');
    this.countEntriesStmt = db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?');
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

  listActive(guildId) {
    return this.activeByGuildStmt.all(guildId);
  }

  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  markEnded(id) {
    this.markEndedStmt.run(id);
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

  countEntries(id) {
    return this.countEntriesStmt.get(id).n;
  }
}

module.exports = { GiveawayRepository };
