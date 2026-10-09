'use strict';

/**
 * Messages épinglés automatiquement (sticky) : un par salon. Requêtes préparées uniquement.
 */
class StickyRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.getStmt = db.prepare('SELECT * FROM sticky_messages WHERE channel_id = ?');
    this.allStmt = db.prepare('SELECT * FROM sticky_messages ORDER BY created_at ASC');
    this.byGuildStmt = db.prepare('SELECT * FROM sticky_messages WHERE guild_id = ? ORDER BY created_at ASC');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM sticky_messages WHERE guild_id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO sticky_messages (guild_id, channel_id, title, content, threshold, last_message_id, author_id, created_at, updated_at)
       VALUES (@guild_id, @channel_id, @title, @content, @threshold, @last_message_id, @author_id, @now, @now)
       ON CONFLICT (channel_id) DO UPDATE SET
         title = excluded.title, content = excluded.content, threshold = excluded.threshold,
         author_id = excluded.author_id, updated_at = excluded.updated_at`,
    );
    this.setLastStmt = db.prepare('UPDATE sticky_messages SET last_message_id = ? WHERE channel_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM sticky_messages WHERE channel_id = ?');
  }

  get(channelId) {
    return this.getStmt.get(channelId) ?? null;
  }

  all() {
    return this.allStmt.all();
  }

  listByGuild(guildId) {
    return this.byGuildStmt.all(guildId);
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  /**
   * Crée ou remplace le contenu du sticky d'un salon (le dernier message publié est conservé).
   * @returns {object} la ligne enregistrée
   */
  upsert({ guildId, channelId, title = null, content, threshold = 3, authorId = null }) {
    this.upsertStmt.run({
      guild_id: guildId,
      channel_id: channelId,
      title: title || null,
      content,
      threshold,
      last_message_id: null,
      author_id: authorId,
      now: Date.now(),
    });
    return this.get(channelId);
  }

  setLastMessage(channelId, messageId) {
    this.setLastStmt.run(messageId ?? null, channelId);
  }

  delete(channelId) {
    return this.deleteStmt.run(channelId).changes;
  }
}

module.exports = { StickyRepository };
