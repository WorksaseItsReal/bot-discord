'use strict';

/**
 * Évaluateur d'expressions mathématiques SÛR (aucun eval / Function).
 * Grammaire (descente récursive) :
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/' | '%') unary)*
 *   unary  := ('-' | '+') unary | power     (donc -3^2 = -(3^2) = -9)
 *   power  := primary ('^' unary)?          (associative à droite : 2^3^2 = 2^9)
 *   primary:= NUMBER | CONST | FUNC '(' expr ')' | '(' expr ')'
 */

const FUNCTIONS = {
  sqrt: Math.sqrt,
  racine: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  arrondi: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
};
const CONSTANTS = { pi: Math.PI, e: Math.E };
const MAX_LENGTH = 200;

class CalcError extends Error {}

function tokenize(input) {
  const tokens = [];
  const str = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.').replace(/\*\*/g, '^');
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9.]/.test(c)) {
      const m = str.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
      if (!m) throw new CalcError(`Nombre invalide à la position ${i + 1}.`);
      tokens.push({ type: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zà-ü]/i.test(c)) {
      const m = str.slice(i).match(/^[a-zà-ü]+/i);
      tokens.push({ type: 'id', value: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^()'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i += 1;
      continue;
    }
    throw new CalcError(`Caractère non autorisé : « ${c} ».`);
  }
  return tokens;
}

/**
 * @param {string} input
 * @returns {number}
 * @throws {CalcError}
 */
function evaluate(input) {
  const src = String(input ?? '').trim();
  if (!src) throw new CalcError('Expression vide.');
  if (src.length > MAX_LENGTH) throw new CalcError(`Expression trop longue (${MAX_LENGTH} caractères max).`);
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => peek()?.type === 'op' && peek().value === v;

  function expr() {
    let v = term();
    while (isOp('+') || isOp('-')) v = next().value === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = next().value;
      const r = unary();
      if ((op === '/' || op === '%') && r === 0) throw new CalcError('Division par zéro.');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary() {
    if (isOp('-')) { next(); return -unary(); }
    if (isOp('+')) { next(); return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (isOp('^')) {
      next();
      return base ** unary();
    }
    return base;
  }
  function primary() {
    const t = next();
    if (!t) throw new CalcError('Expression incomplète.');
    if (t.type === 'num') return t.value;
    if (t.type === 'op' && t.value === '(') {
      if (++depth > 50) throw new CalcError('Trop de parenthèses imbriquées.');
      const v = expr();
      if (!isOp(')')) throw new CalcError('Parenthèse fermante manquante.');
      next();
      depth -= 1;
      return v;
    }
    if (t.type === 'id') {
      // hasOwn : « constructor », « toString », « __proto__ »… ne sont ni des constantes ni des fonctions.
      if (Object.hasOwn(CONSTANTS, t.value)) return CONSTANTS[t.value];
      const fn = Object.hasOwn(FUNCTIONS, t.value) ? FUNCTIONS[t.value] : null;
      if (!fn) throw new CalcError(`Fonction inconnue : « ${t.value} ».`);
      if (!isOp('(')) throw new CalcError(`Parenthèse attendue après « ${t.value} ».`);
      next();
      const v = expr();
      if (!isOp(')')) throw new CalcError('Parenthèse fermante manquante.');
      next();
      return fn(v);
    }
    throw new CalcError(`Symbole inattendu : « ${t.value} ».`);
  }

  const result = expr();
  if (pos < tokens.length) throw new CalcError(`Symbole inattendu : « ${tokens[pos].value} ».`);
  if (!Number.isFinite(result)) throw new CalcError('Résultat non défini ou infini.');
  return result;
}

/** Formatage lisible (supprime les erreurs d'arrondi flottant). */
function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString('fr-FR');
  const rounded = Number(n.toPrecision(12));
  return Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0)
    ? rounded.toExponential(6)
    : rounded.toLocaleString('fr-FR', { maximumFractionDigits: 10 });
}

module.exports = { evaluate, formatNumber, CalcError, FUNCTIONS };
