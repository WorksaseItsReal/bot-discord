'use strict';

/**
 * Absences des membres (/afk), par serveur. `old_nick` : pseudo de serveur avant le
 * préfixe « [AFK] » ; `afk_nick` : pseudo posé par le bot (NULL s'il n'a rien changé).
 */
class AfkRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO afk (guild_id, user_id, reason, since, old_nick, afk_nick)
       VALUES (@guildId, @userId, @reason, @since, @oldNick, @afkNick)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         reason = excluded.reason, since = excluded.since, old_nick = excluded.old_nick, afk_nick = excluded.afk_nick`,
    );
    this.getStmt = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?');
    this.reasonStmt = db.prepare('UPDATE afk SET reason = ? WHERE guild_id = ? AND user_id = ?');
    this.nickStmt = db.prepare('UPDATE afk SET afk_nick = ? WHERE guild_id = ? AND user_id = ?');
    this.usersStmt = db.prepare('SELECT user_id FROM afk WHERE guild_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM afk WHERE guild_id = ?');
  }

  set({ guildId, userId, reason = null, since = Date.now(), oldNick = null, afkNick = null }) {
    this.upsertStmt.run({ guildId, userId, reason: reason ?? null, since, oldNick: oldNick ?? null, afkNick: afkNick ?? null });
    return this.get(guildId, userId);
  }

  get(guildId, userId) {
    return this.getStmt.get(guildId, userId) ?? null;
  }

  setReason(guildId, userId, reason) {
    return this.reasonStmt.run(reason ?? null, guildId, userId).changes > 0;
  }

  setAfkNick(guildId, userId, afkNick) {
    return this.nickStmt.run(afkNick ?? null, guildId, userId).changes > 0;
  }

  /** @returns {object|null} la ligne supprimée */
  delete(guildId, userId) {
    const row = this.get(guildId, userId);
    if (row) this.deleteStmt.run(guildId, userId);
    return row;
  }

  /** Identifiants des membres absents d'un serveur. @returns {string[]} */
  userIds(guildId) {
    return this.usersStmt.all(guildId).map((r) => r.user_id);
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }
}

module.exports = { AfkRepository };
