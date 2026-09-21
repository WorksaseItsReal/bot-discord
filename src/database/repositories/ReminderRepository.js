'use strict';

/**
 * Rappels persistants. Ils survivent au redémarrage et sont rechargés par le
 * SchedulerService au démarrage du bot.
 */
class ReminderRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO reminders (guild_id, channel_id, user_id, message, remind_at, created_at)
       VALUES (@guildId, @channelId, @userId, @message, @remindAt, @createdAt)`,
    );
    this.byUserStmt = db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY remind_at ASC');
    this.dueStmt = db.prepare('SELECT * FROM reminders WHERE remind_at <= ? ORDER BY remind_at ASC');
    this.deleteStmt = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?');
    this.deleteByIdStmt = db.prepare('DELETE FROM reminders WHERE id = ?');
  }

  create(data) {
    const info = this.insertStmt.run({
      guildId: data.guildId ?? null,
      channelId: data.channelId ?? null,
      userId: data.userId,
      message: data.message,
      remindAt: data.remindAt,
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  listByUser(userId) {
    return this.byUserStmt.all(userId);
  }

  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  delete(id, userId) {
    return this.deleteStmt.run(id, userId).changes > 0;
  }

  deleteById(id) {
    this.deleteByIdStmt.run(id);
  }
}

module.exports = { ReminderRepository };
