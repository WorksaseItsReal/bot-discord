'use strict';

/** Conservation des infractions AutoMod (statistiques et sanctions progressives). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Journal des infractions AutoMod. Sert aux sanctions progressives (compte
 * récent par membre, qui survit aux redémarrages) et à /automod stats.
 */
class AutomodEventRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      'INSERT INTO automod_events (guild_id, user_id, filter, action, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.countRecentStmt = db.prepare('SELECT COUNT(*) AS n FROM automod_events WHERE guild_id = ? AND user_id = ? AND created_at >= ?');
    this.totalStmt = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM automod_events WHERE guild_id = ? AND created_at >= ?');
    this.byFilterStmt = db.prepare(
      'SELECT filter, COUNT(*) AS n FROM automod_events WHERE guild_id = ? AND created_at >= ? GROUP BY filter ORDER BY n DESC',
    );
    this.byActionStmt = db.prepare(
      'SELECT action, COUNT(*) AS n FROM automod_events WHERE guild_id = ? AND created_at >= ? GROUP BY action ORDER BY n DESC',
    );
    this.topUsersStmt = db.prepare(
      'SELECT user_id, COUNT(*) AS n FROM automod_events WHERE guild_id = ? AND created_at >= ? GROUP BY user_id ORDER BY n DESC LIMIT ?',
    );
    this.pruneStmt = db.prepare('DELETE FROM automod_events WHERE created_at < ?');
  }

  add({ guildId, userId, filter, action, channelId = null, at = Date.now() }) {
    this.insertStmt.run(guildId, userId, filter, action, channelId, at);
  }

  /** Infractions d'un membre depuis `since` (ms). */
  countRecent(guildId, userId, since) {
    return this.countRecentStmt.get(guildId, userId, since).n;
  }

  /** Statistiques d'un serveur depuis `since`. */
  stats(guildId, since, top = 5) {
    const total = this.totalStmt.get(guildId, since);
    return {
      total: total.n,
      users: total.users,
      byFilter: this.byFilterStmt.all(guildId, since),
      byAction: this.byActionStmt.all(guildId, since),
      topUsers: this.topUsersStmt.all(guildId, since, top),
    };
  }

  /** Supprime les entrées plus anciennes que la durée de conservation. */
  prune(now = Date.now()) {
    return this.pruneStmt.run(now - RETENTION_MS).changes;
  }
}

module.exports = { AutomodEventRepository, RETENTION_MS };
