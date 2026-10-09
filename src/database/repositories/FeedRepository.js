'use strict';

/** Articles mémorisés au plus par flux (déduplication). */
const MAX_SEEN_PER_FEED = 200;

/**
 * Flux RSS / Atom / YouTube (/flux) et articles déjà vus (déduplication par guid).
 * Le SchedulerService relit chaque ligne avant d'agir (flux retiré ou désactivé entre-temps).
 */
class FeedRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO feeds (guild_id, channel_id, url, title, role_id, filter, etag, last_modified, synced, last_checked_at, created_by, created_at)
       VALUES (@guildId, @channelId, @url, @title, @roleId, @filter, @etag, @lastModified, @synced, @lastCheckedAt, @createdBy, @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM feeds WHERE id = ? AND guild_id = ?');
    this.byIdStmt = db.prepare('SELECT * FROM feeds WHERE id = ?');
    this.findStmt = db.prepare('SELECT * FROM feeds WHERE guild_id = ? AND channel_id = ? AND url = ?');
    this.listStmt = db.prepare('SELECT * FROM feeds WHERE guild_id = ? ORDER BY id ASC LIMIT ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE guild_id = ?');
    this.countEnabledStmt = db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE guild_id = ? AND enabled = 1');
    this.dueStmt = db.prepare(
      `SELECT * FROM feeds WHERE guild_id = ? AND enabled = 1 AND (last_checked_at IS NULL OR last_checked_at <= ?)
       ORDER BY COALESCE(last_checked_at, 0) ASC, id ASC LIMIT ?`,
    );
    this.deleteStmt = db.prepare('DELETE FROM feeds WHERE id = ? AND guild_id = ?');
    this.successStmt = db.prepare(
      `UPDATE feeds SET errors = 0, last_error = NULL, last_checked_at = @now,
         etag = COALESCE(@etag, etag), last_modified = COALESCE(@lastModified, last_modified),
         title = COALESCE(@title, title), synced = CASE WHEN @synced = 1 THEN 1 ELSE synced END
       WHERE id = @id`,
    );
    this.errorStmt = db.prepare('UPDATE feeds SET errors = errors + 1, last_error = ?, last_checked_at = ? WHERE id = ? RETURNING errors');
    this.disableStmt = db.prepare('UPDATE feeds SET enabled = 0, last_error = COALESCE(?, last_error) WHERE id = ?');
    this.enableStmt = db.prepare('UPDATE feeds SET enabled = 1, errors = 0, last_error = NULL, last_checked_at = NULL WHERE id = ? AND guild_id = ?');
    this.pauseStmt = db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ? AND guild_id = ?');
    this.postedStmt = db.prepare('UPDATE feeds SET posted_count = posted_count + 1, last_posted_at = ? WHERE id = ?');
    this.seenStmt = db.prepare('SELECT 1 FROM feed_items WHERE feed_id = ? AND guid = ?');
    this.touchStmt = db.prepare(
      `INSERT INTO feed_items (feed_id, guid, seen_at) VALUES (?, ?, ?)
       ON CONFLICT (feed_id, guid) DO UPDATE SET seen_at = excluded.seen_at`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM feed_items WHERE feed_id = ? AND rowid NOT IN (
         SELECT rowid FROM feed_items WHERE feed_id = ? ORDER BY seen_at DESC, rowid DESC LIMIT ?)`,
    );
    this.countSeenStmt = db.prepare('SELECT COUNT(*) AS n FROM feed_items WHERE feed_id = ?');
  }

  /** @returns {object} ligne créée */
  create({ guildId, channelId, url, title = null, roleId = null, filter = null, etag = null, lastModified = null, synced = false, lastCheckedAt = null, createdBy = null, now = Date.now() }) {
    const info = this.insertStmt.run({ guildId, channelId, url, title, roleId, filter, etag, lastModified, synced: synced ? 1 : 0, lastCheckedAt, createdBy, createdAt: now });
    return this.byId(Number(info.lastInsertRowid));
  }

  /** Ligne d'un serveur (null si absente ou d'un autre serveur). */
  get(guildId, id) {
    return this.getStmt.get(id, guildId) ?? null;
  }

  /** Relecture d'une ligne (scheduler). */
  byId(id) {
    return this.byIdStmt.get(id) ?? null;
  }

  find(guildId, channelId, url) {
    return this.findStmt.get(guildId, channelId, url) ?? null;
  }

  list(guildId, limit = 25) {
    return this.listStmt.all(guildId, limit);
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  countEnabled(guildId) {
    return this.countEnabledStmt.get(guildId).n;
  }

  /** Flux actifs d'un serveur non sondés depuis `before`, les plus anciens d'abord. */
  due(guildId, before, limit = 5) {
    return this.dueStmt.all(guildId, before, limit);
  }

  /** Supprime un flux (et ses articles vus). @returns {boolean} */
  delete(guildId, id) {
    return this.deleteStmt.run(id, guildId).changes > 0;
  }

  recordSuccess(id, { etag = null, lastModified = null, title = null, synced = false, now = Date.now() } = {}) {
    this.successStmt.run({ id, etag, lastModified, title, synced: synced ? 1 : 0, now });
  }

  /** @returns {number} erreurs consécutives après celle-ci (0 si le flux n'existe plus) */
  recordError(id, message, now = Date.now()) {
    return this.errorStmt.get(String(message ?? '').slice(0, 300), now, id)?.errors ?? 0;
  }

  disable(id, reason = null) {
    this.disableStmt.run(reason ? String(reason).slice(0, 300) : null, id);
  }

  /** Réactive (compteur d'erreurs remis à zéro, sondé au prochain passage). @returns {boolean} */
  enable(guildId, id) {
    return this.enableStmt.run(id, guildId).changes > 0;
  }

  /** Met en pause (manuellement). @returns {boolean} */
  pause(guildId, id) {
    return this.pauseStmt.run(id, guildId).changes > 0;
  }

  recordPosted(id, now = Date.now()) {
    this.postedStmt.run(now, id);
  }

  isSeen(feedId, guid) {
    return Boolean(this.seenStmt.get(feedId, guid));
  }

  /**
   * Marque des articles comme vus (ceux déjà connus sont « rafraîchis » : un article encore
   * présent dans le flux n'est jamais oublié), puis ne garde que les 200 plus récents.
   */
  markSeen(feedId, guids, now = Date.now()) {
    if (!guids.length) return;
    this.db.transaction(() => {
      // Ordre inverse : le premier article du flux reçoit le rowid le plus récent.
      for (const guid of [...guids].reverse()) this.touchStmt.run(feedId, guid, now);
      this.pruneStmt.run(feedId, feedId, MAX_SEEN_PER_FEED);
    })();
  }

  countSeen(feedId) {
    return this.countSeenStmt.get(feedId).n;
  }
}

module.exports = { FeedRepository, MAX_SEEN_PER_FEED };
