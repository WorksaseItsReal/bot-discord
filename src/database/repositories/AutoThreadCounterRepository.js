'use strict';

/**
 * Compteurs des fils automatiques ({n}) : un par salon.
 */
class AutoThreadCounterRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.nextStmt = db.prepare(
      `INSERT INTO auto_thread_counters (guild_id, channel_id, count) VALUES (?, ?, 1)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET count = count + 1 RETURNING count`,
    );
  }

  /** @returns {number} numéro du prochain fil de ce salon (1, 2, 3…) */
  next(guildId, channelId) {
    return this.nextStmt.get(guildId, channelId).count;
  }
}

module.exports = { AutoThreadCounterRepository };
