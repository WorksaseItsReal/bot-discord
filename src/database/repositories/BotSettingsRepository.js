'use strict';

/**
 * Réglages globaux du bot (table bot_settings, migration #29) : clé → valeur JSON.
 * Table sans guild_id par conception (réglages de l'instance, pas d'un serveur).
 */
class BotSettingsRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.getStmt = db.prepare('SELECT value, updated_at, updated_by FROM bot_settings WHERE key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO bot_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
    this.deleteStmt = db.prepare('DELETE FROM bot_settings WHERE key = ?');
  }

  /**
   * Valeur d'une clé, ou null (absente ou JSON illisible).
   * @returns {any}
   */
  get(key) {
    const row = this.getStmt.get(String(key));
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  /** Ligne complète (valeur décodée, date et auteur de la dernière modification), ou null. */
  entry(key) {
    const row = this.getStmt.get(String(key));
    if (!row) return null;
    let value = null;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    return { value, updatedAt: row.updated_at, updatedBy: row.updated_by ?? null };
  }

  /** Enregistre `value` (sérialisée en JSON) pour `key`. */
  set(key, value, updatedBy = null, now = Date.now()) {
    this.setStmt.run(String(key), JSON.stringify(value ?? null), now, updatedBy ? String(updatedBy) : null);
  }

  /** @returns {boolean} vrai si une ligne a été supprimée */
  delete(key) {
    return this.deleteStmt.run(String(key)).changes > 0;
  }
}

module.exports = { BotSettingsRepository };
