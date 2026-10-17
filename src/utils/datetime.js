'use strict';

/**
 * Conversion « date/heure locale d'un fuseau » → timestamp UTC, sans dépendance.
 * Utilisé par /timestamp (fuseau par défaut : Europe/Paris).
 */

/** Décalage (ms) du fuseau `timeZone` par rapport à UTC à l'instant `utcMs`. */
function tzOffset(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * « JJ/MM/AAAA [HH:MM] » ou « AAAA-MM-JJ [HH:MM] » ou « HH:MM » (aujourd'hui), dans `timeZone`.
 * @returns {number|null} timestamp UTC en ms
 */
function parseLocalDateTime(input, timeZone = 'Europe/Paris', now = Date.now()) {
  const str = String(input ?? '').trim();
  let y, mo, d, h = 0, mi = 0;
  let m = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]+(\d{1,2})[:h](\d{2}))?$/i);
  if (m) [, d, mo, y, h = 0, mi = 0] = m;
  if (!m) {
    m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2})[:h](\d{2}))?$/i);
    if (m) [, y, mo, d, h = 0, mi = 0] = m;
  }
  if (!m) {
    m = str.match(/^(\d{1,2})[:h](\d{2})$/i);
    if (!m) return null;
    const today = new Date(now + tzOffset(now, timeZone));
    y = today.getUTCFullYear();
    mo = today.getUTCMonth() + 1;
    d = today.getUTCDate();
    [, h, mi] = m;
  }
  [y, mo, d, h, mi] = [y, mo, d, h, mi].map(Number);
  if (h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  // Deux passes pour gérer correctement les changements d'heure.
  let ts = guess - tzOffset(guess, timeZone);
  ts = guess - tzOffset(ts, timeZone);
  return ts;
}

module.exports = { tzOffset, parseLocalDateTime, isValidTimeZone };
