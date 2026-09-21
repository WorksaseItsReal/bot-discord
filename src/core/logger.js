'use strict';

const { config } = require('../config');

/**
 * Logger minimal, sans dépendance, avec niveaux et horodatage.
 * Niveaux: error < warn < info < debug.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

function currentLevel() {
  return LEVELS[config.logLevel] ?? LEVELS.info;
}

function format(level, scope, args) {
  const ts = new Date().toISOString();
  const tag = scope ? ` [${scope}]` : '';
  const color = COLORS[level] || '';
  return [`${color}${ts} ${level.toUpperCase()}${tag}${RESET}`, ...args];
}

function log(level, scope, args) {
  if (LEVELS[level] > currentLevel()) return;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(...format(level, scope, args));
}

function createLogger(scope) {
  return {
    error: (...a) => log('error', scope, a),
    warn: (...a) => log('warn', scope, a),
    info: (...a) => log('info', scope, a),
    debug: (...a) => log('debug', scope, a),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

module.exports = { logger: createLogger(''), createLogger };
