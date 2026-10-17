'use strict';

/**
 * Outils purs des statistiques du serveur (/statistiques, /activite) : jours UTC,
 * séries alignées, sparklines et histogrammes en caractères, croissance reconstruite.
 */

const DAY_MS = 86_400_000;
const SPARK = '▁▂▃▄▅▆▇█';
const BAR_FULL = '█';
const BAR_PARTS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Jour UTC (AAAA-MM-JJ) d'un instant. Pur. */
function dayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Minuit UTC d'un jour (ms). Pur. */
function dayStart(key) {
  return Date.parse(`${key}T00:00:00Z`);
}

/** Jour décalé de `n` jours. Pur. */
function addDays(key, n) {
  return dayKey(dayStart(key) + n * DAY_MS);
}

/** Les `n` derniers jours (le plus ancien d'abord, aujourd'hui en dernier). Pur. */
function lastDays(n, now = Date.now()) {
  const today = dayKey(now);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(addDays(today, -i));
  return out;
}

/** Valeurs d'une série alignées sur `days` (0 pour un jour absent). Pur. */
function fillSeries(rows, days, field = 'messages', key = 'day') {
  const map = new Map((rows ?? []).map((r) => [r[key], Number(r[field]) || 0]));
  return days.map((d) => map.get(d) ?? 0);
}

/** Sparkline en caractères ▁▂▃▄▅▆▇█ (0 → ▁, maximum → █). Pur. */
function sparkline(values) {
  const list = (values ?? []).map((v) => Math.max(0, Number(v) || 0));
  if (!list.length) return '';
  const max = Math.max(...list);
  if (max === 0) return SPARK[0].repeat(list.length);
  return list.map((v) => SPARK[Math.round((v / max) * (SPARK.length - 1))]).join('');
}

/** Barre horizontale proportionnelle (huitièmes de caractère). Pur. */
function bar(value, max, width = 16) {
  if (!max || value <= 0) return '';
  const eighths = Math.max(1, Math.round((value / max) * width * 8));
  return BAR_FULL.repeat(Math.floor(eighths / 8)) + BAR_PARTS[eighths % 8];
}

/** Nombre au format français (1 234). Pur. */
function fr(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

/**
 * Histogramme des 24 heures : une ligne par heure (« 14 h │█████▍ 1 234 »). Pur.
 * @param {number[]} values 24 valeurs (index = heure)
 */
function hourHistogram(values, width = 14) {
  const list = Array.from({ length: 24 }, (_, h) => Math.max(0, Number(values?.[h]) || 0));
  const max = Math.max(...list);
  return list.map((v, h) => `${String(h).padStart(2, '0')} h │${bar(v, max, width).padEnd(width + 1, ' ')}${v ? fr(v) : '·'}`);
}

/**
 * Membres en fin de chaque jour, reconstruits à rebours depuis le total actuel :
 * total(veille) = total(jour) − arrivées(jour) + départs(jour). Pur.
 * @param {number} current membres aujourd'hui
 * @param {Array<{ joins: number, leaves: number }>} flows alignés sur les jours (le plus ancien d'abord)
 * @returns {number[]} membres en fin de journée (même ordre)
 */
function reconstructMembers(current, flows) {
  const out = new Array(flows.length);
  let count = Math.max(0, Number(current) || 0);
  for (let i = flows.length - 1; i >= 0; i -= 1) {
    out[i] = Math.max(0, count);
    count = count - (Number(flows[i]?.joins) || 0) + (Number(flows[i]?.leaves) || 0);
  }
  return out;
}

/** Jour lisible (JJ/MM/AAAA). Pur. */
function formatDay(key) {
  const [y, m, d] = String(key).split('-');
  return d && m && y ? `${d}/${m}/${y}` : String(key);
}

/** Durée vocale lisible (« 3 h 05 min », « 12 min », « < 1 min »). Pur. */
function formatVoice(seconds) {
  const minutes = Math.floor((Number(seconds) || 0) / 60);
  if (minutes <= 0) return (Number(seconds) || 0) > 0 ? '< 1 min' : '0 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return `${fr(h)} h ${String(m).padStart(2, '0')} min`;
}

/** Variation signée (+3, −2, 0). Pur. */
function signed(n) {
  const v = Number(n) || 0;
  if (v > 0) return `+${fr(v)}`;
  if (v < 0) return `−${fr(-v)}`;
  return '0';
}

/** Moyenne par jour lisible (une décimale au plus : « 0,3 »). Pur. */
function perDay(total, days) {
  if (!days) return '0';
  return ((Number(total) || 0) / days).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
}

/** Pourcentage arrondi d'une part. Pur. */
function percent(part, total) {
  if (!total) return '0 %';
  return `${Math.round((part / total) * 100)} %`;
}

module.exports = {
  DAY_MS,
  SPARK,
  dayKey,
  dayStart,
  addDays,
  lastDays,
  fillSeries,
  sparkline,
  bar,
  fr,
  hourHistogram,
  reconstructMembers,
  formatDay,
  formatVoice,
  signed,
  perDay,
  percent,
};
