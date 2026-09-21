'use strict';

const { DatabaseManager } = require('../src/database');
const { config } = require('../src/config');
const { logger } = require('../src/core/logger');

const db = new DatabaseManager(config.databasePath);
db.connect();
logger.info('Migrations à jour.');
db.close();
