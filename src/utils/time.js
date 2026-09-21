'use strict';

/**
 * Analyse et formatage de durées. Fonctions pures (facilement testables).
 */

const UNITS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Convertit une chaîne de durée ("10m", "1h30m", "2d", "1w") en millisecondes.
 * @param {string} input
 * @returns {number|null} durée en ms, ou null si invalide
 */
function parseDuration(input) {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase();
  if (!str) return null;
  const regex = /(\d+)\s*(w|d|h|m|s)/g;
  let total = 0;
  let matched = false;
  let match;
  while ((match = regex.exec(str)) !== null) {
    matched = true;
    total += Number(match[1]) * UNITS[match[2]];
  }
  if (!matched) return null;
  // Rejette les caractères parasites (ex: "10x") pour éviter les silences trompeurs
  const cleaned = str.replace(/(\d+)\s*(w|d|h|m|s)/g, '').trim();
  if (cleaned.length > 0) return null;
  return total > 0 ? total : null;
}

/**
 * Formate une durée en ms sous forme lisible ("1j 2h 3m").
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms == null || ms <= 0) return 'permanent';
  const parts = [];
  const units = [
    ['j', UNITS.d],
    ['h', UNITS.h],
    ['m', UNITS.m],
    ['s', UNITS.s],
  ];
  let remaining = ms;
  for (const [label, size] of units) {
    const value = Math.floor(remaining / size);
    if (value > 0) {
      parts.push(`${value}${label}`);
      remaining -= value * size;
    }
  }
  return parts.length ? parts.join(' ') : '0s';
}

/**
 * Timestamp Discord relatif/absolu. style: t T d D f F R
 * @param {number} ms timestamp en ms
 * @param {string} [style='R']
 */
function discordTimestamp(ms, style = 'R') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

module.exports = { parseDuration, formatDuration, discordTimestamp, UNITS };
