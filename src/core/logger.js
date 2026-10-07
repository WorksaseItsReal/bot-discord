'use strict';

const util = require('node:util');
const { config } = require('../config');

/**
 * Logger minimal, sans dépendance, avec niveaux et horodatage.
 * Niveaux: error < warn < info < debug.
 *
 * Tous les arguments passent par `sanitize()` avant affichage : les jetons
 * d'interaction/webhook présents dans les URL (`/interactions/:id/:token`,
 * `/webhooks/:id/:token`) sont masqués et le `requestBody` des DiscordAPIError
 * (contenu des messages, fichiers…) n'est jamais imprimé.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

/** Clés jamais imprimées (corps de requête : contenu utilisateur, pièces jointes). */
const DROPPED_KEYS = new Set(['requestBody']);
const TOKEN_PATH_RE = /(\/(?:webhooks|interactions)\/\d+\/)[^/\s?#"'`]+/gi;
const MAX_DEPTH = 4;

function currentLevel() {
  return LEVELS[config.logLevel] ?? LEVELS.info;
}

/** Masque les jetons dans une chaîne. Pur (testé). */
function redact(str) {
  return typeof str === 'string' ? str.replace(TOKEN_PATH_RE, '$1[REDACTED]') : str;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rend une erreur en texte sûr : pile (ou nom + message) masquée, puis ses
 * propriétés propres (code, status, method, url…) sans `requestBody`.
 */
function serializeError(err, depth, seen) {
  const head = redact(err.stack || `${err.name ?? 'Error'}: ${err.message ?? ''}`);
  const extra = {};
  for (const key of Object.keys(err)) {
    if (key === 'stack' || key === 'message' || DROPPED_KEYS.has(key)) continue;
    extra[key] = sanitize(err[key], depth + 1, seen);
  }
  if (err.cause !== undefined && !('cause' in extra)) extra.cause = sanitize(err.cause, depth + 1, seen);
  if (!Object.keys(extra).length) return head;
  return `${head} ${util.inspect(extra, { depth: MAX_DEPTH, breakLength: 120 })}`;
}

/**
 * Prépare une valeur pour l'affichage. Les erreurs deviennent du texte sûr ;
 * chaînes, objets simples et tableaux sont masqués récursivement ; les autres
 * instances (Guild, Collection…) sont laissées telles quelles.
 */
function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_DEPTH) return value instanceof Error ? redact(`${value.name}: ${value.message}`) : '[…]';
  seen.add(value);
  try {
    if (value instanceof Error) return serializeError(value, depth, seen);
    if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen));
    if (isPlainObject(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (!DROPPED_KEYS.has(k)) out[k] = sanitize(v, depth + 1, seen);
      }
      return out;
    }
    return value;
  } finally {
    seen.delete(value);
  }
}

function format(level, scope, args) {
  const ts = new Date().toISOString();
  const tag = scope ? ` [${scope}]` : '';
  const color = COLORS[level] || '';
  return [`${color}${ts} ${level.toUpperCase()}${tag}${RESET}`, ...args.map((a) => sanitize(a))];
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

module.exports = { logger: createLogger(''), createLogger, sanitize, redact };
