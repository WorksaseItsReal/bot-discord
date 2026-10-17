'use strict';

/**
 * Morpion (tic-tac-toe) : logique pure. Grille de 9 cases (0 = vide, 1 = ❌, 2 = ⭕),
 * numérotées de gauche à droite puis de haut en bas.
 * L'IA (minimax complet, mémoïsé) est imbattable : au mieux, match nul.
 */

const EMPTY = 0;
const X = 1;
const O = 2;
const LINES = Object.freeze([
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]);

const other = (mark) => (mark === X ? O : X);

/** Gagnant de la grille : { mark, line } ou null. */
function winnerOf(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] !== EMPTY && board[a] === board[b] && board[a] === board[c]) return { mark: board[a], line };
  }
  return null;
}

const isFull = (board) => board.every((c) => c !== EMPTY);
const freeCells = (board) => board.flatMap((c, i) => (c === EMPTY ? [i] : []));

/** Issue de la grille : 'win' (avec le gagnant), 'draw' ou null (partie en cours). */
function outcomeOf(board) {
  const w = winnerOf(board);
  if (w) return { type: 'win', ...w };
  if (isFull(board)) return { type: 'draw' };
  return null;
}

const memo = new Map();

/**
 * Valeur de la position pour `toMove` (négamax) : > 0 gagnant, 0 nul, < 0 perdant.
 * Une victoire rapide vaut plus qu'une victoire tardive (10 - profondeur).
 */
function negamax(board, toMove) {
  const key = `${board.join('')}${toMove}`;
  if (memo.has(key)) return memo.get(key);
  const w = winnerOf(board);
  let value;
  if (w) value = w.mark === toMove ? 10 - countMarks(board) : -(10 - countMarks(board));
  else if (isFull(board)) value = 0;
  else {
    value = -Infinity;
    for (const i of freeCells(board)) {
      board[i] = toMove;
      value = Math.max(value, -negamax(board, other(toMove)));
      board[i] = EMPTY;
    }
  }
  memo.set(key, value);
  return value;
}

const countMarks = (board) => board.filter((c) => c !== EMPTY).length;

/**
 * Meilleur coup pour `mark` (imbattable). Entre plusieurs coups optimaux, tirage au sort
 * (toujours optimal) pour varier les parties. -1 si la grille est pleine ou terminée.
 */
function bestMove(board, mark, rng = Math.random) {
  if (winnerOf(board) || isFull(board)) return -1;
  const work = [...board];
  let best = -Infinity;
  let moves = [];
  for (const i of freeCells(work)) {
    work[i] = mark;
    const value = -negamax(work, other(mark));
    work[i] = EMPTY;
    if (value > best) {
      best = value;
      moves = [i];
    } else if (value === best) moves.push(i);
  }
  return moves[Math.floor(rng() * moves.length)];
}

/** Grille vide. */
const newBoard = () => Array(9).fill(EMPTY);

module.exports = { EMPTY, X, O, LINES, other, winnerOf, isFull, freeCells, outcomeOf, bestMove, newBoard };
