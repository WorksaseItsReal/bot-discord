'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrations } = require('./schema');
const { createLogger } = require('../core/logger');

const logger = createLogger('db');

/**
 * Couche d'accès à la base SQLite. Ouvre la connexion, applique les
 * migrations et expose l'instance `better-sqlite3` aux repositories.
 * Aucune requête SQL ne doit vivre en dehors de cette couche / des repositories.
 */
class DatabaseManager {
  /** @param {string} filePath chemin du fichier SQLite */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {import('better-sqlite3').Database | null} */
    this.db = null;
  }

  connect() {
    if (this.db) return this.db;
    const dir = path.dirname(this.filePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    logger.info(`Base de données prête (${this.filePath})`);
    return this.db;
  }

  migrate() {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );`,
    );
    const applied = new Set(this.db.prepare('SELECT id FROM _migrations').all().map((r) => r.id));
    const insert = this.db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');
    const run = this.db.transaction((migration) => {
      this.db.exec(migration.up);
      insert.run(migration.id, migration.name, Date.now());
    });
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      run(migration);
      logger.info(`Migration appliquée : #${migration.id} ${migration.name}`);
    }
  }

  get raw() {
    if (!this.db) throw new Error('La base de données n\'est pas connectée.');
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { DatabaseManager };
