'use strict';

const path = require('node:path');
require('dotenv').config();

/**
 * Configuration centralisée du bot, dérivée des variables d'environnement.
 * Les secrets ne vivent QUE dans le process.env (fichier .env non commité).
 */

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
  logLevel: process.env.LOG_LEVEL || 'info',
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

module.exports = { config, validate, parseList };
