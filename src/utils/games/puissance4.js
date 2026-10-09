'use strict';

/**
 * Puissance 4 : logique pure. Grille de 6 lignes × 7 colonnes, stockée ligne par ligne
 * (index = ligne × 7 + colonne, ligne 0 en haut). 0 = vide, 1 = 🔴, 2 = 🟡.
 */

const ROWS = 6;
const COLS = 7;
const EMPTY = 0;
const RED = 1;
const YELLOW = 2;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

const other = (mark) => (mark === RED ? YELLOW : RED);
const at = (board, r, c) => (r >= 0 && r < ROWS && c >= 0 && c < COLS ? board[r * COLS + c] : -1);
const newBoard = () => Array(ROWS * COLS).fill(EMPTY);

/** Colonne jouable ? */
const canPlay = (board, col) => Number.isInteger(col) && col >= 0 && col < COLS && board[col] === EMPTY;
const playableColumns = (board) => [...Array(COLS).keys()].filter((c) => canPlay(board, c));
const isFull = (board) => playableColumns(board).length === 0;

/** Ligne où tomberait un jeton dans `col` (-1 si pleine). */
function dropRow(board, col) {
  if (!canPlay(board, col)) return -1;
  for (let r = ROWS - 1; r >= 0; r -= 1) if (board[r * COLS + col] === EMPTY) return r;
  return -1;
}

/** Joue `mark` dans `col` (modifie la grille). @returns {number} ligne, ou -1 */
function drop(board, col, mark) {
  const r = dropRow(board, col);
  if (r >= 0) board[r * COLS + col] = mark;
  return r;
}

/** Alignement d'au moins 4 passant par (r, c) : liste des cases, ou null. */
function lineThrough(board, r, c) {
  const mark = at(board, r, c);
  if (mark !== RED && mark !== YELLOW) return null;
  for (const [dr, dc] of DIRECTIONS) {
    const cells = [r * COLS + c];
    for (const sign of [1, -1]) {
      let rr = r + dr * sign;
      let cc = c + dc * sign;
      while (at(board, rr, cc) === mark) {
        cells.push(rr * COLS + cc);
        rr += dr * sign;
        cc += dc * sign;
      }
    }
    if (cells.length >= 4) return cells.sort((a, b) => a - b);
  }
  return null;
}

/** Gagnant de la grille (recherche complète) : { mark, cells } ou null. */
function winnerOf(board) {
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const cells = lineThrough(board, r, c);
      if (cells) return { mark: at(board, r, c), cells };
    }
  }
  return null;
}

/** Jouer `col` ferait-il gagner `mark` ? (grille inchangée) */
function winsWith(board, col, mark) {
  const r = dropRow(board, col);
  if (r < 0) return false;
  board[r * COLS + col] = mark;
  const win = Boolean(lineThrough(board, r, col));
  board[r * COLS + col] = EMPTY;
  return win;
}

/**
 * IA simple : gagne si possible, sinon bloque la victoire adverse, sinon évite d'offrir
 * une victoire immédiate à l'adversaire et préfère le centre (tirage au sort sinon).
 * @returns {number} colonne (-1 si la grille est pleine)
 */
function aiMove(board, mark, rng = Math.random) {
  const cols = playableColumns(board);
  if (!cols.length) return -1;
  const work = [...board];
  const win = cols.find((c) => winsWith(work, c, mark));
  if (win !== undefined) return win;
  const block = cols.find((c) => winsWith(work, c, other(mark)));
  if (block !== undefined) return block;
  const safe = cols.filter((c) => {
    const r = drop(work, c, mark);
    const givesWin = r > 0 && winsWith(work, c, other(mark));
    work[r * COLS + c] = EMPTY;
    return !givesWin;
  });
  const pool = safe.length ? safe : cols;
  // Le centre d'abord ; sinon une colonne proche du centre, parfois une autre au hasard.
  if (pool.includes(3)) return 3;
  const closest = Math.min(...pool.map((c) => Math.abs(c - 3)));
  const near = pool.filter((c) => Math.abs(c - 3) === closest);
  const list = rng() < 0.7 ? near : pool;
  return list[Math.floor(rng() * list.length)];
}

module.exports = { ROWS, COLS, EMPTY, RED, YELLOW, other, newBoard, canPlay, playableColumns, isFull, dropRow, drop, lineThrough, winnerOf, aiMove };
