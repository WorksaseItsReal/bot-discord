'use strict';

/**
 * Anniversaires des membres (/anniversaire), par serveur. L'année est facultative
 * et n'est affichée qu'avec l'accord du membre (`show_age`).
 */
class BirthdayRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    // date_changed_at : création, ou jour/mois réellement modifiés (pas l'année ni l'accord).
    this.upsertStmt = db.prepare(
      `INSERT INTO birthdays (guild_id, user_id, day, month, year, show_age, created_at, updated_at, date_changed_at)
       VALUES (@guildId, @userId, @day, @month, @year, @showAge, @now, @now, @now)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         date_changed_at = CASE WHEN birthdays.day <> excluded.day OR birthdays.month <> excluded.month
                                THEN excluded.date_changed_at ELSE birthdays.date_changed_at END,
         day = excluded.day, month = excluded.month, year = excluded.year,
         show_age = excluded.show_age, updated_at = excluded.updated_at`,
    );
    this.lockStmt = db.prepare(
      `INSERT INTO birthday_locks (guild_id, user_id, until) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET until = MAX(birthday_locks.until, excluded.until)`,
    );
    this.lockedStmt = db.prepare('SELECT until FROM birthday_locks WHERE guild_id = ? AND user_id = ?');
    this.purgeLocksStmt = db.prepare('DELETE FROM birthday_locks WHERE until <= ?');
    this.getStmt = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?');
    this.allStmt = db.prepare('SELECT * FROM birthdays WHERE guild_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM birthdays WHERE guild_id = ?');
    this.onDateStmt = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND month = ? AND day = ?');
    this.claimStmt = db.prepare(
      `UPDATE birthdays SET last_celebrated = @date
       WHERE guild_id = @guildId AND user_id = @userId AND (last_celebrated IS NULL OR last_celebrated <> @date)`,
    );
    this.roleStmt = db.prepare('UPDATE birthdays SET role_id = ?, role_until = ? WHERE guild_id = ? AND user_id = ?');
    this.roleDueStmt = db.prepare('SELECT * FROM birthdays WHERE role_until IS NOT NULL AND role_until <= ? LIMIT 200');
    this.clearRoleStmt = db.prepare('UPDATE birthdays SET role_id = NULL, role_until = NULL WHERE guild_id = ? AND user_id = ? AND role_until IS NOT NULL AND role_until <= ?');
  }

  set({ guildId, userId, day, month, year = null, showAge = false, now = Date.now() }) {
    this.upsertStmt.run({ guildId, userId, day, month, year: year ?? null, showAge: showAge ? 1 : 0, now });
  }

  get(guildId, userId) {
    return this.getStmt.get(guildId, userId) ?? null;
  }

  /** @returns {object|null} la ligne supprimée */
  delete(guildId, userId) {
    const row = this.get(guildId, userId);
    if (row) this.deleteStmt.run(guildId, userId);
    return row;
  }

  all(guildId) {
    return this.allStmt.all(guildId);
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  onDate(guildId, month, day) {
    return this.onDateStmt.all(guildId, month, day);
  }

  /**
   * Réserve la fête du jour (une seule fois par date locale) : renvoie false si elle a
   * déjà eu lieu. Écrit AVANT l'envoi, donc jamais deux messages pour le même jour.
   */
  claim(guildId, userId, date) {
    return this.claimStmt.run({ guildId, userId, date }).changes > 0;
  }

  setRole(guildId, userId, roleId, until) {
    this.roleStmt.run(roleId, until, guildId, userId);
  }

  findRoleDue(now = Date.now()) {
    return this.roleDueStmt.all(now);
  }

  /** Aucune fête pour ce membre avant `until` (anniversaire retiré peu après une fête). */
  lock(guildId, userId, until) {
    this.lockStmt.run(guildId, userId, until);
  }

  /** Échéance du verrou d'un membre (0 si aucun). */
  lockedUntil(guildId, userId) {
    return this.lockedStmt.get(guildId, userId)?.until ?? 0;
  }

  /** Supprime les verrous échus. @returns {number} */
  purgeLocks(now = Date.now()) {
    return this.purgeLocksStmt.run(now).changes;
  }

  /** Efface le rôle à retirer, seulement s'il est toujours échu (relecture). @returns {boolean} */
  clearRole(guildId, userId, now = Date.now()) {
    return this.clearRoleStmt.run(guildId, userId, now).changes > 0;
  }
}

module.exports = { BirthdayRepository };
