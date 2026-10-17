'use strict';

/**
 * Mélange de Fisher-Yates paresseux : chaque élément est tiré à la demande, sans remise,
 * en O(1) (copie initiale O(n)). Le pool n'est pas modifié. On s'arrête dès qu'on a ce
 * qu'il faut : tirer 3 gagnants parmi 300 000 ne mélange pas toute la liste.
 * @template T
 * @param {T[]} pool
 * @param {() => number} [rng]
 * @returns {Generator<T>}
 */
function* lazyShuffle(pool, rng = Math.random) {
  const items = [...pool];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const picked = items[j];
    items[j] = items[i];
    yield picked;
  }
}

/**
 * Tire `count` gagnants uniques au hasard dans `pool`. Pur (injection de rng
 * possible pour les tests). Renvoie moins d'éléments si le pool est trop petit.
 * O(n + count) (Fisher-Yates partiel), jamais O(n²).
 * @template T
 * @param {T[]} pool
 * @param {number} count
 * @param {() => number} [rng]
 * @returns {T[]}
 */
function pickWinners(pool, count, rng = Math.random) {
  const winners = [];
  if (!(count > 0)) return winners;
  for (const item of lazyShuffle(pool, rng)) {
    winners.push(item);
    if (winners.length >= count) break;
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

module.exports = { pickWinners, lazyShuffle, shortId };

/** Élément aléatoire d'un tableau. */
function pick(items, rng = Math.random) {
  return items[Math.floor(rng() * items.length)];
}

/** Entier aléatoire dans [min, max] (inclus). */
function randomInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Analyse une notation de dés : « d20 », « 2d6 », « 3d8+2 », « 4d6-1 ».
 * @returns {{ count: number, sides: number, modifier: number } | null}
 */
function parseDice(input) {
  const m = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '').match(/^(\d{0,3})d(\d{1,4})([+-]\d{1,5})?$/);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3]) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
  return { count, sides, modifier };
}

/** Lance les dés décrits par parseDice. */
function rollDice({ count, sides, modifier }, rng = Math.random) {
  const rolls = Array.from({ length: count }, () => randomInt(1, sides, rng));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) + modifier };
}

module.exports.pick = pick;
module.exports.randomInt = randomInt;
module.exports.parseDice = parseDice;
module.exports.rollDice = rollDice;
