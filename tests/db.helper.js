'use strict';

const { DatabaseManager } = require('../src/database');

/** Crée une base SQLite en mémoire avec les migrations appliquées. */
function memoryDb() {
  const manager = new DatabaseManager(':memory:');
  return { manager, db: manager.connect() };
}

module.exports = { memoryDb };
