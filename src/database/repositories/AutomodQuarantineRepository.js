'use strict';

/**
 * Quarantaines AutoMod (compte piraté) : les rôles retirés sont enregistrés ici
 * AVANT leur retrait, pour être rendus à la levée même si le log n'a pas été
 * envoyé (salon absent, logs en pause, permission) ou a été tronqué.
 */
class AutomodQuarantineRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      'INSERT INTO automod_quarantines (guild_id, user_id, roles, timeout_until, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.getStmt = db.prepare('SELECT * FROM automod_quarantines WHERE id = ? AND guild_id = ?');
    this.setRolesStmt = db.prepare('UPDATE automod_quarantines SET roles = ? WHERE id = ? AND guild_id = ?');
    this.liftStmt = db.prepare('UPDATE automod_quarantines SET lifted_at = ?, lifted_by = ? WHERE id = ? AND guild_id = ? AND lifted_at IS NULL');
  }

  /** @returns {number} identifiant de la quarantaine (bouton « Lever la quarantaine ») */
  add({ guildId, userId, roles = [], timeoutUntil = null, eventId = null, at = Date.now() }) {
    return Number(this.insertStmt.run(guildId, userId, JSON.stringify(roles), timeoutUntil, eventId, at).lastInsertRowid);
  }

  /** Quarantaine d'un serveur (jamais celle d'un autre serveur), rôles décodés, ou null. */
  get(guildId, id) {
    const row = this.getStmt.get(id, guildId);
    if (!row) return null;
    let roles = [];
    try {
      const parsed = JSON.parse(row.roles ?? '[]');
      roles = Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : [];
    } catch {
      roles = [];
    }
    return { ...row, roles };
  }

  /** Remplace la liste des rôles retirés (ex. retrait refusé par Discord : aucun). */
  setRoles(guildId, id, roles) {
    return this.setRolesStmt.run(JSON.stringify(roles), id, guildId).changes > 0;
  }

  /** Marque la quarantaine comme levée (une seule fois). @returns {boolean} */
  lift(guildId, id, by, at = Date.now()) {
    return this.liftStmt.run(at, by, id, guildId).changes > 0;
  }
}

module.exports = { AutomodQuarantineRepository };
