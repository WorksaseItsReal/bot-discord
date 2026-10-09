'use strict';

const { tzOffset } = require('./datetime');

/**
 * Calendrier dans un fuseau IANA, sans dépendance : répétitions d'annonces
 * (même heure locale malgré les changements d'heure) et anniversaires
 * (29 février fêté le 28 les années non bissextiles). Fonctions pures.
 */

const DAY_MS = 86_400_000;
const REPEATS = Object.freeze({ none: 'Aucune', daily: 'Quotidienne', weekly: 'Hebdomadaire', monthly: 'Mensuelle' });
const MONTHS = Object.freeze(['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Nombre de jours d'un mois (1-12). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Date et heure locales d'un instant dans `timeZone`. */
function localParts(ms, timeZone) {
  const d = new Date(ms + tzOffset(ms, timeZone));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** Instant UTC d'une date/heure locale de `timeZone` (deux passes : changements d'heure). */
function localToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - tzOffset(guess, timeZone);
  return guess - tzOffset(first, timeZone);
}

/** « AAAA-MM-JJ » de la date locale. */
function localDateKey(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * n-ième occurrence (n = 0 : l'ancre) d'une répétition, à la même heure locale.
 * Mensuelle : le jour de l'ancre est conservé, ramené au dernier jour des mois plus courts
 * (31 janvier → 28/29 février → 31 mars).
 */
function occurrence(anchorAt, repeat, timeZone, n) {
  if (!n || repeat === 'none') return anchorAt;
  const a = localParts(anchorAt, timeZone);
  if (repeat === 'daily' || repeat === 'weekly') {
    const step = repeat === 'daily' ? n : 7 * n;
    const date = new Date(Date.UTC(a.year, a.month - 1, a.day + step));
    return localToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: a.hour, minute: a.minute }, timeZone);
  }
  if (repeat === 'monthly') {
    const index = a.month - 1 + n;
    const year = a.year + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return localToUtc({ year, month, day: Math.min(a.day, daysInMonth(year, month)), hour: a.hour, minute: a.minute }, timeZone);
  }
  return anchorAt;
}

/**
 * Prochaine occurrence strictement postérieure à `now` (les occurrences manquées
 * pendant une panne ne sont pas rattrapées une par une).
 * @returns {{ runs: number, at: number } | null} null pour une annonce unique
 */
function nextAfter(anchorAt, repeat, timeZone, runs, now = Date.now()) {
  if (repeat === 'none' || !REPEATS[repeat]) return null;
  let n = Math.max(0, runs) + 1;
  // Saut direct juste avant `now` (annonce restée en panne longtemps) ; période majorée
  // (31 jours par mois) pour ne jamais dépasser la bonne occurrence.
  const period = repeat === 'daily' ? DAY_MS : repeat === 'weekly' ? 7 * DAY_MS : 31 * DAY_MS;
  const behind = Math.floor((now - anchorAt) / period) - 2;
  if (behind > n) n = behind;
  let at = occurrence(anchorAt, repeat, timeZone, n);
  for (let guard = 0; at <= now && guard < 1000; guard += 1) {
    n += 1;
    at = occurrence(anchorAt, repeat, timeZone, n);
  }
  return { runs: n, at };
}

/** Jour/mois valides (29 février accepté). */
function isValidDayMonth(day, month) {
  return Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2000, month);
}

/** Jour fêté une année donnée : le 29 février devient le 28 les années non bissextiles. */
function celebratedDay(day, month, year) {
  return month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
}

/** L'anniversaire (jour, mois) tombe-t-il à la date locale donnée ? */
function isBirthdayOn(row, { year, month, day }) {
  return row.month === month && celebratedDay(row.day, row.month, year) === day;
}

/**
 * Prochaine fête à partir d'une date locale (aujourd'hui compris).
 * @returns {{ year: number, month: number, day: number, inDays: number }}
 */
function nextBirthday(row, today) {
  const start = Date.UTC(today.year, today.month - 1, today.day);
  for (const year of [today.year, today.year + 1]) {
    const day = celebratedDay(row.day, row.month, year);
    const at = Date.UTC(year, row.month - 1, day);
    if (at >= start) return { year, month: row.month, day, inDays: Math.round((at - start) / DAY_MS) };
  }
  return { year: today.year + 1, month: row.month, day: row.day, inDays: 365 };
}

/** « 12 mars » (année facultative). */
function formatDayMonth(day, month, year = null) {
  return `${day === 1 ? '1er' : day} ${MONTHS[month - 1] ?? '?'}${year ? ` ${year}` : ''}`;
}

module.exports = {
  DAY_MS,
  REPEATS,
  MONTHS,
  isLeapYear,
  daysInMonth,
  localParts,
  localToUtc,
  localDateKey,
  occurrence,
  nextAfter,
  isValidDayMonth,
  celebratedDay,
  isBirthdayOn,
  nextBirthday,
  formatDayMonth,
};
