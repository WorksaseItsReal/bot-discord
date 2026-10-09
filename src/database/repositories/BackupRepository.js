'use strict';

/** Nom donné aux sauvegardes du planificateur (sert aussi à reconnaître les anciennes). */
const AUTO_BACKUP_NAME = 'Auto-backup';

/** true si la ligne est une sauvegarde automatique (même règle que les quotas SQL). Pur. */
function isAutoBackup(row) {
  return row?.created_by == null || row?.name === AUTO_BACKUP_NAME;
}

class BackupRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO backups (id, guild_id, name, data, created_by, created_at)
       VALUES (@id, @guildId, @name, @data, @createdBy, @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM backups WHERE id = ? AND guild_id = ?');
    // Compteurs lus dans le JSON par SQLite (sans décoder toute la sauvegarde côté Node).
    // Repli sur la longueur des tableaux pour les sauvegardes antérieures à `counts`.
    this.listStmt = db.prepare(
      `SELECT id, name, created_by, created_at,
         CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.counts.roles'), json_array_length(data, '$.roles'), 0) ELSE 0 END AS role_count,
         CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.counts.channels'), json_array_length(data, '$.channels'), 0) ELSE 0 END AS channel_count
       FROM backups WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?`,
    );
    this.deleteStmt = db.prepare('DELETE FROM backups WHERE id = ? AND guild_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM backups WHERE guild_id = ?');
    this.pruneStmt = db.prepare(
      `DELETE FROM backups WHERE guild_id = @guildId AND id NOT IN (
         SELECT id FROM backups WHERE guild_id = @guildId ORDER BY created_at DESC, rowid DESC LIMIT @keep
       )`,
    );
    // Quotas séparés : une sauvegarde est « automatique » si elle n'a pas d'auteur
    // (created_by NULL) ou porte le nom historique du planificateur (anciennes
    // sauvegardes auto enregistrées avec l'ID du bot comme auteur).
    const AUTO = `(created_by IS NULL OR name = '${AUTO_BACKUP_NAME}')`;
    this.pruneKindStmt = {
      auto: db.prepare(
        `DELETE FROM backups WHERE guild_id = @guildId AND ${AUTO} AND id NOT IN (
           SELECT id FROM backups WHERE guild_id = @guildId AND ${AUTO} ORDER BY created_at DESC, rowid DESC LIMIT @keep
         )`,
      ),
      manual: db.prepare(
        `DELETE FROM backups WHERE guild_id = @guildId AND NOT ${AUTO} AND id NOT IN (
           SELECT id FROM backups WHERE guild_id = @guildId AND NOT ${AUTO} ORDER BY created_at DESC, rowid DESC LIMIT @keep
         )`,
      ),
    };
  }

  /**
   * Ne conserve que les `keep` sauvegardes les plus récentes du serveur
   * (toutes, ou seulement celles du type `kind` : 'auto' | 'manual').
   */
  prune(guildId, keep = 15, kind) {
    const stmt = kind ? this.pruneKindStmt[kind] : this.pruneStmt;
    if (!stmt) throw new Error(`Type de sauvegarde inconnu : ${kind}`);
    return stmt.run({ guildId, keep }).changes;
  }

  create(data) {
    this.insertStmt.run({ ...data, data: JSON.stringify(data.data), createdAt: Date.now() });
    return data.id;
  }

  get(guildId, id) {
    const row = this.getStmt.get(id, guildId);
    if (row) row.data = JSON.parse(row.data);
    return row;
  }

  /** Résumés (sans `data`) : id, name, created_by, created_at, role_count, channel_count. */
  list(guildId, limit = 25) {
    return this.listStmt.all(guildId, limit);
  }

  delete(guildId, id) {
    return this.deleteStmt.run(id, guildId).changes > 0;
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }
}

module.exports = { BackupRepository, AUTO_BACKUP_NAME, isAutoBackup };
