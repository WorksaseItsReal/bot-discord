'use strict';

/**
 * Économie : briques PURES (aucun accès à Discord ni à la base) — bornes des réglages,
 * récompenses quotidiennes / hebdomadaires / travail, mathématiques des jeux (espérance
 * négative réglable), mise en forme de la monnaie et de l'historique. Testées une à une.
 *
 * La monnaie est virtuelle : elle ne s'achète pas et ne s'échange pas contre de l'argent.
 */

const { defaultGuildConfig } = require('../config/defaults');
const { discordTimestamp } = require('./time');
const { truncate } = require('./embeds');

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** La série quotidienne continue si la récompense précédente date de moins de 48 h. */
const STREAK_GRACE_MS = 2 * DAY_MS;
/** Plafond absolu de tout montant (solde, mise, virement) : reste exact en JavaScript. */
const HARD_MAX = 1_000_000_000_000;
/** Articles de boutique par serveur (une option de menu par article). */
const MAX_ITEMS = 25;
/** Lignes d'historique conservées par membre. */
const TX_KEEP = 200;

/** Rappel affiché sur les jeux, la boutique et les soldes. */
const VIRTUAL_NOTICE = 'Monnaie virtuelle sans valeur réelle : elle ne s\'achète pas et ne s\'échange pas contre de l\'argent.';

/** Bornes des réglages (/economie) : [min, max]. */
const BOUNDS = Object.freeze({
  dailyAmount: [1, 1_000_000],
  streakBonus: [0, 1_000_000],
  streakMax: [0, 365],
  weeklyAmount: [1, 10_000_000],
  workMin: [1, 1_000_000],
  workMax: [1, 1_000_000],
  workCooldownMinutes: [1, 1440],
  taxPercent: [0, 50],
  confirmAbove: [0, HARD_MAX],
  maxBet: [1, HARD_MAX],
  maxBalance: [100, HARD_MAX],
  houseEdgePercent: [1, 50],
  gameCooldownSeconds: [0, 3600],
  currencyName: [1, 24],
  itemName: [1, 50],
  itemDescription: [0, 200],
  itemPrice: [1, HARD_MAX],
  itemStock: [0, 1_000_000],
});

const fmt = (n) => Number(n ?? 0).toLocaleString('fr-FR');

/** Entier borné, ou la valeur de repli si la donnée stockée est abîmée. Pur. */
function clampInt(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Réglages effectifs, bornés (une config abîmée ne casse jamais un calcul). Pur.
 * @param {object} raw bloc `economy` de la config du serveur
 */
function settingsOf(raw = {}) {
  const d = defaultGuildConfig.economy;
  const r = raw ?? {};
  const name = typeof r.currency?.name === 'string' && r.currency.name.trim() ? truncate(r.currency.name.trim(), BOUNDS.currencyName[1]) : d.currency.name;
  const emoji = typeof r.currency?.emoji === 'string' && r.currency.emoji.trim() ? r.currency.emoji.trim().slice(0, 64) : d.currency.emoji;
  const workMin = clampInt(r.work?.min, BOUNDS.workMin, d.work.min);
  const workMax = Math.max(workMin, clampInt(r.work?.max, BOUNDS.workMax, d.work.max));
  return {
    enabled: r.enabled === true,
    currency: { name, emoji },
    daily: {
      amount: clampInt(r.daily?.amount, BOUNDS.dailyAmount, d.daily.amount),
      streakBonus: clampInt(r.daily?.streakBonus, BOUNDS.streakBonus, d.daily.streakBonus),
      streakMax: clampInt(r.daily?.streakMax, BOUNDS.streakMax, d.daily.streakMax),
    },
    weekly: { amount: clampInt(r.weekly?.amount, BOUNDS.weeklyAmount, d.weekly.amount) },
    work: { min: workMin, max: workMax, cooldownMinutes: clampInt(r.work?.cooldownMinutes, BOUNDS.workCooldownMinutes, d.work.cooldownMinutes) },
    transfers: {
      taxPercent: clampInt(r.transfers?.taxPercent, BOUNDS.taxPercent, d.transfers.taxPercent),
      confirmAbove: clampInt(r.transfers?.confirmAbove, BOUNDS.confirmAbove, d.transfers.confirmAbove),
    },
    limits: {
      maxBet: clampInt(r.limits?.maxBet, BOUNDS.maxBet, d.limits.maxBet),
      maxBalance: clampInt(r.limits?.maxBalance, BOUNDS.maxBalance, d.limits.maxBalance),
    },
    games: {
      coinflip: r.games?.coinflip !== false,
      slots: r.games?.slots !== false,
      houseEdgePercent: clampInt(r.games?.houseEdgePercent, BOUNDS.houseEdgePercent, d.games.houseEdgePercent),
      cooldownSeconds: clampInt(r.games?.cooldownSeconds, BOUNDS.gameCooldownSeconds, d.games.cooldownSeconds),
    },
  };
}

/** Montant mis en forme : « **1 500** 🪙 ». Pur. */
function money(n, eco) {
  return `**${fmt(n)}** ${eco?.currency?.emoji ?? '🪙'}`;
}

/** Montant signé : « +150 » / « −20 ». Pur. */
function signed(n) {
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `−${fmt(-n)}`;
  return '±0';
}

/**
 * Montant réellement crédité sous le plafond de solde (0 si déjà au plafond). Pur.
 * @returns {number}
 */
function capCredit(balance, amount, maxBalance) {
  return Math.max(0, Math.min(amount, maxBalance - balance));
}

// ---------------------------------------------------------------- récompenses

/**
 * Récompense quotidienne : disponible 24 h après la précédente ; la série continue si
 * elle date de moins de 48 h. Bonus = streakBonus × min(série − 1, streakMax). Pur.
 * @returns {{ ready: false, nextAt: number } | { ready: true, streak: number, base: number, bonus: number, amount: number }}
 */
function dailyReward(eco, account, now = Date.now()) {
  const last = account?.last_daily ?? null;
  if (last != null && now - last < DAY_MS) return { ready: false, nextAt: last + DAY_MS };
  const continues = last != null && now - last < STREAK_GRACE_MS;
  const streak = continues ? Math.max(0, account.daily_streak ?? 0) + 1 : 1;
  const bonus = eco.daily.streakBonus * Math.min(streak - 1, eco.daily.streakMax);
  return { ready: true, streak, base: eco.daily.amount, bonus, amount: eco.daily.amount + bonus };
}

/** Prochaine récompense hebdomadaire (null : disponible). Pur. */
function weeklyNext(account, now = Date.now()) {
  const last = account?.last_weekly ?? null;
  return last != null && now - last < WEEK_MS ? last + WEEK_MS : null;
}

/** Prochain travail possible (null : disponible). Pur. */
function workNext(eco, account, now = Date.now()) {
  const last = account?.last_work ?? null;
  const cd = eco.work.cooldownMinutes * MINUTE_MS;
  return last != null && now - last < cd ? last + cd : null;
}

/** Série quotidienne encore valable à `now` (0 si elle est rompue). Pur. */
function liveStreak(account, now = Date.now()) {
  const last = account?.last_daily ?? null;
  return last != null && now - last < STREAK_GRACE_MS ? account.daily_streak ?? 0 : 0;
}

/** Messages de /eco travail : {montant} est remplacé par la somme gagnée. */
const WORK_MESSAGES = Object.freeze([
  'Vous avez réparé le gadgeto-hélicoptère de l\'inspecteur et touché {montant}.',
  'Vous avez livré des croissants au commissariat de Métro City : {montant} de pourboires.',
  'Vous avez aidé Sophie à finir un exposé sur son ordinateur-livre : {montant} pour la peine.',
  'Vous avez promené Finot pendant trois heures : {montant} bien mérités.',
  'Vous avez classé les dossiers secrets du chef Gontier : {montant} de prime.',
  'Vous avez déjoué un petit piège du Docteur Gang : la récompense s\'élève à {montant}.',
  'Vous avez tenu le stand de gaufres de la fête foraine : {montant} empochés.',
  'Vous avez réécrit le mode d\'emploi du gadgeto-bras (il en avait besoin) : {montant}.',
  'Vous avez lustré la gadgetomobile de fond en comble : {montant} et quelques taches de cire.',
  'Vous avez animé une soirée quiz sur le serveur : {montant} de cachet.',
  'Vous avez retrouvé le chapeau perdu de l\'inspecteur : {montant} de récompense.',
  'Vous avez réparé le grille-pain du commissariat (encore lui) : {montant}.',
  'Vous avez testé un nouveau gadget… sans trop de bobos : {montant} pour le risque.',
  'Vous avez distribué des prospectus dans tout Métro City : {montant} en poche.',
  'Vous avez veillé sur le serveur toute la nuit : {montant} pour la garde.',
  'Vous avez démasqué un agent du M.A.D. déguisé en facteur : {montant} de prime.',
]);

/** Entier aléatoire dans [min, max] (inclus). */
function randomInt(min, max, rng = Math.random) {
  return Math.min(max, Math.floor(rng() * (max - min + 1)) + min);
}

/** Gain et message de /eco travail. Pur (rng injectable). */
function workOutcome(eco, rng = Math.random) {
  const amount = randomInt(eco.work.min, eco.work.max, rng);
  const template = WORK_MESSAGES[Math.min(WORK_MESSAGES.length - 1, Math.floor(rng() * WORK_MESSAGES.length))];
  return { amount, template };
}

// ---------------------------------------------------------------- jeux

/**
 * Pile ou face : gain du double de la mise avec une probabilité (1 − avantage) / 2,
 * soit une espérance de −avantage × mise. Pur (rng injectable).
 * @param {number} bet
 * @param {'pile'|'face'} choice
 * @param {number} edgePercent avantage de la maison (1 à 50)
 */
function playCoinflip(bet, choice, edgePercent, rng = Math.random) {
  const winChance = (1 - edgePercent / 100) / 2;
  const won = rng() < winChance;
  const side = won ? choice : choice === 'pile' ? 'face' : 'pile';
  return { won, side, winChance, payout: won ? bet * 2 : 0 };
}

/** Symboles de la machine à sous : poids (fréquence) et gains de base (× mise). */
const SLOT_SYMBOLS = Object.freeze([
  { emoji: '🍒', weight: 6, triple: 4, pair: 1 },
  { emoji: '🍋', weight: 5, triple: 6, pair: 1 },
  { emoji: '🍇', weight: 4, triple: 10, pair: 1.5 },
  { emoji: '🔔', weight: 3, triple: 20, pair: 2 },
  { emoji: '💎', weight: 2, triple: 50, pair: 3 },
  { emoji: '7️⃣', weight: 1, triple: 150, pair: 5 },
]);
const SLOT_WEIGHT = SLOT_SYMBOLS.reduce((n, s) => n + s.weight, 0);

/**
 * Retour moyen d'une table (1 = mise rendue en moyenne) : trois symboles identiques
 * ou exactement deux identiques, rouleaux indépendants. Pur.
 * @param {Array<{ weight: number, triple: number, pair: number }>} table
 */
function slotsReturn(table) {
  let rtp = 0;
  for (const s of table) {
    const q = s.weight / SLOT_WEIGHT;
    rtp += q ** 3 * s.triple + 3 * q ** 2 * (1 - q) * s.pair;
  }
  return rtp;
}

/**
 * Table des gains pour un avantage de la maison donné : les gains de base sont mis à
 * l'échelle pour un retour moyen de (1 − avantage), arrondis AU CENTIÈME INFÉRIEUR
 * (l'espérance reste donc toujours négative). Multiplicateurs en centièmes. Pur.
 */
function slotsTable(edgePercent) {
  const factor = (1 - edgePercent / 100) / slotsReturn(SLOT_SYMBOLS);
  return SLOT_SYMBOLS.map((s) => ({
    emoji: s.emoji,
    weight: s.weight,
    tripleCents: Math.floor(s.triple * factor * 100 + 1e-9),
    pairCents: Math.floor(s.pair * factor * 100 + 1e-9),
  }));
}

/** Retour moyen d'une table en centièmes (pour vérification). Pur. */
function tableReturn(table) {
  return slotsReturn(table.map((s) => ({ weight: s.weight, triple: s.tripleCents / 100, pair: s.pairCents / 100 })));
}

/** Tire trois symboles selon leurs poids. Pur (rng injectable). */
function spinSlots(rng = Math.random) {
  const one = () => {
    let r = rng() * SLOT_WEIGHT;
    for (const s of SLOT_SYMBOLS) {
      r -= s.weight;
      if (r < 0) return s.emoji;
    }
    return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1].emoji;
  };
  return [one(), one(), one()];
}

/** mise × centièmes / 100, arrondi à l'inférieur, exact pour toute mise ≤ HARD_MAX. Pur. */
function applyCents(bet, cents) {
  return Math.floor(bet / 100) * cents + Math.floor(((bet % 100) * cents) / 100);
}

/**
 * Gain d'un tirage. Pur.
 * @returns {{ kind: 'triple'|'pair'|null, symbol: string|null, cents: number, payout: number }}
 */
function slotsPayout(reels, table, bet) {
  const [a, b, c] = reels;
  let kind = null;
  let symbol = null;
  if (a === b && b === c) {
    kind = 'triple';
    symbol = a;
  } else if (a === b || a === c) {
    kind = 'pair';
    symbol = a;
  } else if (b === c) {
    kind = 'pair';
    symbol = b;
  }
  const row = symbol ? table.find((s) => s.emoji === symbol) : null;
  const cents = row ? (kind === 'triple' ? row.tripleCents : row.pairCents) : 0;
  return { kind, symbol, cents, payout: applyCents(bet, cents) };
}

/** Partie de machine à sous complète. Pur (rng injectable). */
function playSlots(bet, edgePercent, rng = Math.random) {
  const table = slotsTable(edgePercent);
  const reels = spinSlots(rng);
  return { reels, table, ...slotsPayout(reels, table, bet) };
}

/** Multiplicateur lisible (« ×1,5 »). Pur. */
const multText = (cents) => `×${(cents / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------- historique

const TX_KINDS = Object.freeze({
  daily: { emoji: '📅', label: 'Récompense quotidienne' },
  weekly: { emoji: '🗓️', label: 'Récompense hebdomadaire' },
  work: { emoji: '💼', label: 'Travail' },
  transfer_out: { emoji: '📤', label: 'Virement envoyé' },
  transfer_in: { emoji: '📥', label: 'Virement reçu' },
  buy: { emoji: '🛒', label: 'Achat' },
  refund: { emoji: '↩️', label: 'Remboursement' },
  coinflip: { emoji: '🪙', label: 'Pile ou face' },
  slots: { emoji: '🎰', label: 'Machine à sous' },
  admin: { emoji: '🛡️', label: 'Ajustement' },
});

const ADMIN_OPS = Object.freeze({ give: 'Don', take: 'Retrait', set: 'Solde défini' });
const SNOWFLAKE = /^\d{17,20}$/;

/** Détail lisible d'une ligne d'historique (référence stockée → texte). Pur. */
function txDetail(tx) {
  const ref = String(tx.ref ?? '');
  switch (tx.kind) {
    case 'transfer_out':
      return SNOWFLAKE.test(ref) ? `à <@${ref}>` : '';
    case 'transfer_in':
      return SNOWFLAKE.test(ref) ? `de <@${ref}>` : '';
    case 'buy':
    case 'refund': {
      const name = ref.split(':').slice(1).join(':');
      return name ? truncate(name.replace(/[`*_~|>]/g, ''), 60) : '';
    }
    case 'admin': {
      const [op, mod] = ref.split(':');
      return `${ADMIN_OPS[op] ?? 'Ajustement'}${SNOWFLAKE.test(mod ?? '') ? ` par <@${mod}>` : ''}`;
    }
    case 'daily':
      return /^\d+$/.test(ref) ? `série de ${ref} jour(s)` : '';
    case 'coinflip':
    case 'slots':
      return truncate(ref, 40);
    default:
      return '';
  }
}

/** Ligne d'historique : « il y a 2 min · 📅 **+150** · Récompense quotidienne · … ». Pur. */
function txLine(tx) {
  const kind = TX_KINDS[tx.kind] ?? { emoji: '•', label: 'Mouvement' };
  const detail = txDetail(tx);
  return `${discordTimestamp(tx.created_at, 'R')} · ${kind.emoji} **${signed(tx.delta)}** · ${kind.label}${detail ? ` · ${detail}` : ''}`;
}

/**
 * Montant saisi dans un formulaire (« 1 500 », « 1500 »), entier borné. Pur.
 * @returns {number|null} null si invalide
 */
function parseAmount(raw, [min, max]) {
  const text = String(raw ?? '').replace(/[\s  ._]/g, '');
  if (!/^\d{1,13}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

module.exports = {
  MINUTE_MS,
  DAY_MS,
  WEEK_MS,
  STREAK_GRACE_MS,
  HARD_MAX,
  MAX_ITEMS,
  TX_KEEP,
  VIRTUAL_NOTICE,
  BOUNDS,
  WORK_MESSAGES,
  SLOT_SYMBOLS,
  TX_KINDS,
  ADMIN_OPS,
  fmt,
  clampInt,
  settingsOf,
  money,
  signed,
  capCredit,
  dailyReward,
  weeklyNext,
  workNext,
  liveStreak,
  workOutcome,
  randomInt,
  playCoinflip,
  slotsReturn,
  slotsTable,
  tableReturn,
  spinSlots,
  applyCents,
  slotsPayout,
  playSlots,
  multText,
  txDetail,
  txLine,
  parseAmount,
};
