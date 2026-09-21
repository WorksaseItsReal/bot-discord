'use strict';

/**
 * Tire `count` gagnants uniques au hasard dans `pool`. Pur (injection de rng
 * possible pour les tests). Renvoie moins d'éléments si le pool est trop petit.
 * @template T
 * @param {T[]} pool
 * @param {number} count
 * @param {() => number} [rng]
 * @returns {T[]}
 */
function pickWinners(pool, count, rng = Math.random) {
  const items = [...pool];
  const n = Math.min(count, items.length);
  const winners = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(rng() * items.length);
    winners.push(items.splice(idx, 1)[0]);
  }
  return winners;
}

/** Identifiant court alphanumérique (pour backups, etc.). */
function shortId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = { pickWinners, shortId };
