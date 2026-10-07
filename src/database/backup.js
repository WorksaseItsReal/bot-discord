'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../core/logger');

const logger = createLogger('db:backup');

const HOUR_MS = 3_600_000;
/** Délai minimal avant la première sauvegarde automatique après le démarrage. */
const FIRST_RUN_MIN_DELAY_MS = 60_000;

const pad = (n) => String(n).padStart(2, '0');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Préfixe des fichiers de sauvegarde, dérivé du nom de la base (`gadget.sqlite` → `gadget`). */
function backupStem(dbPath) {
  const base = path.basename(String(dbPath || '')).replace(/\.(sqlite3?|db)$/i, '');
  return base && base !== ':memory:' ? base : 'gadget';
}

/** Dossier par défaut : `<dossier de la base>/backups` (dans le volume Docker /app/data). */
function defaultBackupDir(dbPath) {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/** `gadget-AAAAMMJJ-HHMM.sqlite` (heure locale du serveur). */
function backupFileName(stem, date = new Date()) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `${stem}-${day}-${pad(date.getHours())}${pad(date.getMinutes())}.sqlite`;
}

/** Sauvegardes existantes, de la plus ancienne à la plus récente (l'ordre du nom est chronologique). */
function listBackups(dir, stem) {
  const re = new RegExp(`^${escapeRe(stem)}-\\d{8}-\\d{4}\\.sqlite$`);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => re.test(n)).sort();
}

/** Ne garde que les `keep` sauvegardes les plus récentes. Renvoie les fichiers supprimés. */
function rotateBackups(dir, stem, keep) {
  const max = Math.max(1, Math.floor(Number(keep) || 1));
  const files = listBackups(dir, stem);
  const removed = files.slice(0, Math.max(0, files.length - max));
  for (const name of removed) fs.rmSync(path.join(dir, name), { force: true });
  return removed;
}

/**
 * Copie cohérente de la base via l'API de sauvegarde en ligne de SQLite
 * (`db.backup()` de better-sqlite3 : sûre pendant que le bot écrit), puis rotation.
 * L'écriture passe par un fichier `.partial` renommé à la fin : une sauvegarde
 * interrompue ne remplace jamais une sauvegarde valide.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ dir: string, stem?: string, keep?: number, now?: Date }} opts
 * @returns {Promise<{ file: string, size: number, removed: string[] }>}
 */
async function backupDatabase(db, { dir, stem = 'gadget', keep = 14, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName(stem, now));
  const tmp = `${file}.partial`;
  fs.rmSync(tmp, { force: true });
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const removed = rotateBackups(dir, stem, keep);
  return { file, size: fs.statSync(file).size, removed };
}

/**
 * Sauvegarde automatique périodique dans le processus du bot (DB_BACKUP_INTERVAL_HOURS).
 * Minuteur `unref` (n'empêche jamais l'arrêt) ; `stop()` attend la sauvegarde en
 * cours pour que la base ne soit pas fermée sous elle. Une erreur est journalisée,
 * jamais propagée : le bot continue de tourner.
 */
class AutoBackup {
  /**
   * @param {object} opts
   * @param {{ raw: import('better-sqlite3').Database }} opts.database DatabaseManager
   * @param {number} opts.intervalHours
   * @param {string} opts.dir
   * @param {string} [opts.stem]
   * @param {number} [opts.keep]
   */
  constructor({ database, intervalHours, dir, stem = 'gadget', keep = 14 }) {
    this.database = database;
    // Plancher d'une minute ; le plafond (24 jours, cf. config) reste sous la limite de setTimeout.
    this.intervalMs = Math.max(60_000, Number(intervalHours) * HOUR_MS);
    this.dir = dir;
    this.stem = stem;
    this.keep = keep;
    this.timer = null;
    this.stopped = false;
    /** @type {Promise<object|null> | null} */
    this.current = null;
  }

  /** Délai avant la première sauvegarde : tient compte de la dernière existante (redémarrages fréquents). */
  firstDelay(now = Date.now()) {
    const files = listBackups(this.dir, this.stem);
    if (!files.length) return FIRST_RUN_MIN_DELAY_MS;
    let last = 0;
    try {
      last = fs.statSync(path.join(this.dir, files[files.length - 1])).mtimeMs;
    } catch {
      /* fichier disparu entre-temps */
    }
    return Math.max(FIRST_RUN_MIN_DELAY_MS, last + this.intervalMs - now);
  }

  start() {
    if (this.timer || this.stopped) return;
    this.#schedule(this.firstDelay());
    logger.info(`Sauvegarde automatique activée (toutes les ${this.intervalMs / HOUR_MS} h, ${this.keep} conservées, ${this.dir})`);
  }

  #schedule(delay) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.run();
      this.#schedule(this.intervalMs);
    }, delay);
    this.timer.unref?.();
  }

  /** Lance une sauvegarde (une seule à la fois). Ne rejette jamais. */
  run() {
    if (this.current) return this.current;
    this.current = (async () => {
      try {
        const res = await backupDatabase(this.database.raw, { dir: this.dir, stem: this.stem, keep: this.keep });
        logger.info(`Sauvegarde créée : ${path.basename(res.file)} (${Math.round(res.size / 1024)} Kio${res.removed.length ? `, ${res.removed.length} ancienne(s) supprimée(s)` : ''})`);
        return res;
      } catch (err) {
        logger.error('Sauvegarde automatique de la base échouée :', err);
        return null;
      } finally {
        this.current = null;
      }
    })();
    return this.current;
  }

  /** Arrête le minuteur et attend la sauvegarde en cours. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) await this.current;
  }
}

module.exports = { backupDatabase, rotateBackups, listBackups, backupFileName, backupStem, defaultBackupDir, AutoBackup };
