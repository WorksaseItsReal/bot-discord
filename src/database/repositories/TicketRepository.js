'use strict';

class TicketRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO tickets (guild_id, channel_id, user_id, status, created_at)
       VALUES (@guildId, @channelId, @userId, 'open', @createdAt)`,
    );
    this.byChannelStmt = db.prepare('SELECT * FROM tickets WHERE channel_id = ?');
    this.openByUserStmt = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ? AND status != 'closed'");
    // claimed_at (migration 23) : posée à la prise en charge, conservée ensuite (COALESCE).
    this.updateStatusStmt = db.prepare(
      'UPDATE tickets SET status = @status, claimed_by = @claimedBy, closed_at = @closedAt, claimed_at = COALESCE(claimed_at, @claimedAt) WHERE channel_id = @channelId',
    );
    this.deleteStmt = db.prepare('DELETE FROM tickets WHERE channel_id = ?');
    this.byGuildStmt = db.prepare('SELECT * FROM tickets WHERE guild_id = ?');
  }

  /** Tous les tickets enregistrés d'un serveur (réconciliation au démarrage). */
  listByGuild(guildId) {
    return this.byGuildStmt.all(guildId);
  }

  create(data) {
    return Number(this.insertStmt.run({ ...data, createdAt: Date.now() }).lastInsertRowid);
  }

  getByChannel(channelId) {
    return this.byChannelStmt.get(channelId);
  }

  countOpenByUser(guildId, userId) {
    return this.openByUserStmt.get(guildId, userId).n;
  }

  setStatus(channelId, status, { claimedBy = null, closedAt = null, claimedAt = null } = {}) {
    this.updateStatusStmt.run({ channelId, status, claimedBy, closedAt, claimedAt });
  }

  delete(channelId) {
    this.deleteStmt.run(channelId);
  }
}

module.exports = { TicketRepository };
