'use strict';

/**
 * Incidents Secur (anti-nuke) : une ligne par incident (auteur, fenêtre de 60 s), mise à jour
 * au fil de l'incident (modules déclenchés, actions, sanction réelle, annulations). Toutes les
 * requêtes sont filtrées par guild_id.
 */
class SecurityIncidentRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO security_incidents (guild_id, executor_id, modules, actions, punishment, outcome, removed_roles, created_at, updated_at)
       VALUES (@guildId, @executorId, @modules, @actions, @punishment, @outcome, @removedRoles, @createdAt, @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM security_incidents WHERE id = ? AND guild_id = ?');
    this.recentStmt = db.prepare('SELECT * FROM security_incidents WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.updateStmt = db.prepare(
      `UPDATE security_incidents SET modules = @modules, actions = @actions, punishment = @punishment, outcome = @outcome,
         removed_roles = @removedRoles, undone = @undone, undo_failed = @undoFailed, updated_at = @at
       WHERE id = @id AND guild_id = @guildId`,
    );
    this.alertStmt = db.prepare('UPDATE security_incidents SET alert_channel_id = ?, alert_message_id = ?, updated_at = ? WHERE id = ? AND guild_id = ?');
    // Verrou de « Rendre les rôles » / « Débannir » : un seul clic gagne.
    this.restoreStmt = db.prepare('UPDATE security_incidents SET restored_by = ?, restored_at = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND restored_at IS NULL');
    this.unrestoreStmt = db.prepare('UPDATE security_incidents SET restored_by = NULL, restored_at = NULL WHERE id = ? AND guild_id = ? AND restored_by = ?');
    this.purgeStmt = db.prepare('DELETE FROM security_incidents WHERE created_at < ?');
    this.purgeGuildStmt = db.prepare('DELETE FROM security_incidents WHERE guild_id = ?');
  }

  /** @returns {number} identifiant de l'incident */
  create({ guildId, executorId, modules = [], actions = 1, punishment = 'none', outcome = 'pending', removedRoles = null, createdAt = Date.now() }) {
    const info = this.insertStmt.run({
      guildId,
      executorId,
      modules: JSON.stringify(modules),
      actions,
      punishment,
      outcome,
      removedRoles: removedRoles ? JSON.stringify(removedRoles) : null,
      createdAt,
    });
    return Number(info.lastInsertRowid);
  }

  get(guildId, id) {
    return SecurityIncidentRepository.#parse(this.getStmt.get(id, guildId));
  }

  /** Derniers incidents d'un serveur (le plus récent d'abord). */
  recent(guildId, limit = 3) {
    return this.recentStmt.all(guildId, Math.max(1, Math.min(50, limit))).map((r) => SecurityIncidentRepository.#parse(r));
  }

  /** Met à jour l'état d'un incident (modules, actions, sanction, annulations). */
  update(guildId, id, { modules, actions, punishment, outcome, removedRoles = null, undone = 0, undoFailed = 0 }, at = Date.now()) {
    return this.updateStmt.run({
      id,
      guildId,
      modules: JSON.stringify(modules ?? []),
      actions,
      punishment,
      outcome,
      removedRoles: removedRoles ? JSON.stringify(removedRoles) : null,
      undone,
      undoFailed,
      at,
    }).changes;
  }

  setAlert(guildId, id, channelId, messageId, at = Date.now()) {
    return this.alertStmt.run(channelId ?? null, messageId ?? null, at, id, guildId).changes;
  }

  /** Verrou : true si CET appel a marqué l'incident restauré (false : déjà fait). */
  markRestored(guildId, id, by, at = Date.now()) {
    return this.restoreStmt.run(by, at, at, id, guildId).changes === 1;
  }

  /** Restauration impossible (aucun rôle rendu, débannissement refusé) : le verrou est levé. */
  unmarkRestored(guildId, id, by) {
    return this.unrestoreStmt.run(id, guildId, by).changes;
  }

  /** Purge des incidents plus anciens que `before`. @returns {number} */
  purgeBefore(before) {
    return this.purgeStmt.run(before).changes;
  }

  purgeGuild(guildId) {
    return this.purgeGuildStmt.run(guildId).changes;
  }

  static #parse(row) {
    if (!row) return null;
    const parse = (v, fallback) => {
      try {
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    };
    return { ...row, modules: parse(row.modules, []), removed_roles: parse(row.removed_roles, []) };
  }
}

module.exports = { SecurityIncidentRepository };
