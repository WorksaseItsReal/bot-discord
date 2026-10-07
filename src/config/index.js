'use strict';

const path = require('node:path');
require('dotenv').config();

/**
 * Configuration centralisée du bot, dérivée des variables d'environnement.
 * Les secrets ne vivent QUE dans le process.env (fichier .env non commité).
 */

/**
 * Nombre optionnel lu depuis l'environnement (ex : HEALTH_PORT).
 * Renvoie `null` si absent, hors bornes ou non entier quand `integer` est demandé
 * (la fonction correspondante reste alors désactivée).
 */
function parseNumberEnv(value, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (integer && !Number.isInteger(n)) return null;
  return n;
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const config = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  devGuildId: process.env.DEV_GUILD_ID || '',
  ownerIds: parseList(process.env.OWNER_IDS),
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'gadget.sqlite'),
  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  /** `json` : une ligne JSON par entrée (agrégateurs de logs) ; sinon texte coloré. */
  logFormat: (process.env.LOG_FORMAT || 'text').trim().toLowerCase(),
  /** Port du serveur /healthz + /metrics (désactivé si non défini). */
  healthPort: parseNumberEnv(process.env.HEALTH_PORT, { min: 0, max: 65535 }),
  healthHost: process.env.HEALTH_HOST || '127.0.0.1',
  /** Sauvegardes SQLite : dossier, rétention et intervalle automatique (heures, désactivé si non défini). */
  dbBackupDir: process.env.DB_BACKUP_DIR || '',
  dbBackupKeep: parseNumberEnv(process.env.DB_BACKUP_KEEP, { min: 1, max: 10_000 }) ?? 14,
  dbBackupIntervalHours: parseNumberEnv(process.env.DB_BACKUP_INTERVAL_HOURS, { min: 0.1, max: 24 * 24, integer: false }),
  env: process.env.NODE_ENV || 'development',
  version: require('../../package.json').version,
  colors: {
    primary: 0x5865f2,
    success: 0x57f287,
    error: 0xed4245,
    warning: 0xfee75c,
    info: 0x5865f2,
    moderation: 0xeb459e,
    security: 0xe67e22,
    fun: 0xf47fff,
    utility: 0x1abc9c,
    projects: 0x5865f2,
  },
  emojis: {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    loading: '⏳',
  },
};

/**
 * Vérifie que la configuration minimale requise pour se connecter est présente.
 * @param {{ requireToken?: boolean }} [opts]
 * @returns {string[]} liste des erreurs (vide si tout est bon)
 */
function validate(opts = {}) {
  const { requireToken = true } = opts;
  const errors = [];
  if (requireToken && !config.token) errors.push('DISCORD_TOKEN manquant dans .env');
  if (!config.clientId) errors.push('CLIENT_ID manquant dans .env');
  return errors;
}

module.exports = { config, validate, parseList, parseNumberEnv };
