'use strict';

/**
 * Sauvegarde ponctuelle de la base SQLite (sans connexion à Discord).
 * Utilise l'API de sauvegarde en ligne de SQLite : peut tourner pendant que le
 * bot est démarré. Écrit `data/backups/gadget-AAAAMMJJ-HHMM.sqlite` puis ne garde
 * que les DB_BACKUP_KEEP (14 par défaut) plus récentes.
 *
 * Usage : npm run backup:db
 * Variables : DATABASE_PATH, DB_BACKUP_DIR (défaut : <dossier de la base>/backups), DB_BACKUP_KEEP.
 */
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { logger } = require('../src/core/logger');
const { backupDatabase, backupStem, defaultBackupDir } = require('../src/database/backup');

async function main() {
  const dbPath = config.databasePath;
  if (!fs.existsSync(dbPath)) {
    logger.error(`Base introuvable : ${dbPath} (vérifiez DATABASE_PATH).`);
    process.exitCode = 1;
    return;
  }
  // Pas de DatabaseManager : une sauvegarde ne doit jamais appliquer de migration.
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const dir = config.dbBackupDir || defaultBackupDir(dbPath);
    const res = await backupDatabase(db, { dir, stem: backupStem(dbPath), keep: config.dbBackupKeep });
    logger.info(`Sauvegarde créée : ${res.file} (${Math.round(res.size / 1024)} Kio)`);
    if (res.removed.length) logger.info(`Rotation : ${res.removed.length} ancienne(s) sauvegarde(s) supprimée(s) (${config.dbBackupKeep} conservées).`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error('Sauvegarde ÉCHOUÉE :', err);
  process.exitCode = 1;
});
