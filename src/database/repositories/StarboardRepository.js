'use strict';

/**
 * Starboard : lien entre un message d'origine et sa carte dans le salon starboard.
 * Requêtes préparées uniquement.
 */
class StarboardRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.getStmt = db.prepare('SELECT * FROM starboard WHERE guild_id = ? AND message_id = ?');
    this.byStarStmt = db.prepare('SELECT * FROM starboard WHERE star_message_id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO starboard (guild_id, message_id, channel_id, author_id, star_message_id, stars, updated_at)
       VALUES (@guild_id, @message_id, @channel_id, @author_id, @star_message_id, @stars, @updated_at)
       ON CONFLICT (guild_id, message_id) DO UPDATE SET
         channel_id = excluded.channel_id, author_id = excluded.author_id,
         star_message_id = excluded.star_message_id, stars = excluded.stars, updated_at = excluded.updated_at`,
    );
    this.deleteStmt = db.prepare('DELETE FROM starboard WHERE guild_id = ? AND message_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM starboard WHERE guild_id = ? AND star_message_id IS NOT NULL');
    this.topStmt = db.prepare(
      'SELECT * FROM starboard WHERE guild_id = ? AND star_message_id IS NOT NULL ORDER BY stars DESC, updated_at DESC LIMIT ?',
    );
    this.deleteGuildStmt = db.prepare('DELETE FROM starboard WHERE guild_id = ?');
  }

  get(guildId, messageId) {
    return this.getStmt.get(guildId, messageId) ?? null;
  }

  /** Ligne dont la carte du starboard est ce message. */
  byStarMessage(starMessageId) {
    if (!starMessageId) return null;
    return this.byStarStmt.get(starMessageId) ?? null;
  }

  /**
   * Crée ou met à jour une entrée.
   * @param {{ guildId: string, messageId: string, channelId: string, authorId?: string|null, starMessageId?: string|null, stars: number }} row
   */
  upsert({ guildId, messageId, channelId, authorId = null, starMessageId = null, stars }) {
    this.upsertStmt.run({
      guild_id: guildId,
      message_id: messageId,
      channel_id: channelId,
      author_id: authorId,
      star_message_id: starMessageId,
      stars: Math.max(0, Math.floor(Number(stars) || 0)),
      updated_at: Date.now(),
    });
  }

  delete(guildId, messageId) {
    return this.deleteStmt.run(guildId, messageId).changes;
  }

  /** Nombre de messages actuellement au starboard. */
  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  /** Messages les plus étoilés. */
  top(guildId, limit = 5) {
    return this.topStmt.all(guildId, limit);
  }

  deleteGuild(guildId) {
    return this.deleteGuildStmt.run(guildId).changes;
  }
}

module.exports = { StarboardRepository };
