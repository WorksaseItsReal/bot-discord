'use strict';

/** Devine le nombre : logique pure. */

const MIN = 1;
const MAX = 100;

/** Nombre secret. */
const secretNumber = (rng = Math.random) => MIN + Math.floor(rng() * (MAX - MIN + 1));

/** Proposition saisie (« 42 », « 42 ») → entier de 1 à 100, ou null. Pur. */
function parseGuess(raw) {
  const text = String(raw ?? '').replace(/\s/g, '');
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= MIN && n <= MAX ? n : null;
}

/** -1 : le secret est plus petit · 1 : plus grand · 0 : trouvé. Pur. */
const compare = (secret, guess) => Math.sign(secret - guess);

/** Intervalle encore possible d'après les indications reçues. Pur. */
function range(secret, guesses) {
  let low = MIN;
  let high = MAX;
  for (const g of guesses) {
    const c = compare(secret, g);
    if (c > 0) low = Math.max(low, g + 1);
    else if (c < 0) high = Math.min(high, g - 1);
  }
  return [low, high];
}

/** Points d'une victoire : 10 au premier essai, 1 de moins par essai, 1 au minimum. Pur. */
const winPoints = (attempts) => Math.max(1, 11 - attempts);

module.exports = { MIN, MAX, secretNumber, parseGuess, compare, range, winPoints };
