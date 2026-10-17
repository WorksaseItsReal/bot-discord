'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { UserError } = require('../core/errors');
const { discordTimestamp } = require('../utils/time');
const { hasForbiddenPermissions } = require('../commands/roles/rolemenu');
const E = require('../utils/economy');

/**
 * Le bot peut-il vendre (attribuer) ce rôle ? Vérifié à la création de l'article ET à
 * chaque achat : rôle existant, ni @everyone ni géré, aucune permission sensible, sous
 * le rôle le plus haut du bot, permission « Gérer les rôles ».
 * @returns {string|null} la raison du refus, ou null
 */
function roleIssue(guild, roleId) {
  const role = roleId ? guild?.roles?.cache?.get(roleId) : null;
  if (!role) return 'ce rôle n\'existe plus';
  if (role.id === guild.id) return '@everyone ne peut pas être vendu';
  if (role.managed) return 'ce rôle est géré par une intégration';
  if (hasForbiddenPermissions(role)) return 'ce rôle donne des permissions de modération ou d\'administration';
  const me = guild.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) return 'il me manque la permission **Gérer les rôles**';
  if (role.position >= (me.roles?.highest?.position ?? 0)) return 'ce rôle est au-dessus (ou au niveau) de mon rôle le plus haut';
  return null;
}

/**
 * Économie : règles métier au-dessus d'EconomyRepository. Chaque opération qui touche
 * un solde est UNE transaction SQLite qui relit le compte, vérifie le solde, le
 * plafond et les délais, écrit le nouveau solde et la ligne d'historique : aucun
 * solde négatif, aucun double débit (clics simultanés traités l'un après l'autre).
 *
 * Toutes les méthodes sont synchrones (rien à arrêter à l'extinction du bot).
 */
class EconomyService {
  /**
   * @param {{ economy: import('../database/repositories/EconomyRepository').EconomyRepository, config: import('./ConfigService').ConfigService }} deps
   */
  constructor({ economy, config }) {
    this.repo = economy;
    this.config = config;
  }

  /** Réglages effectifs (bornés) du serveur. */
  settings(guildId) {
    return E.settingsOf(this.config.get(guildId).economy);
  }

  /** Réglages, ou UserError si l'économie est désactivée. */
  assertEnabled(guildId) {
    const eco = this.settings(guildId);
    if (!eco.enabled) throw new UserError('L\'économie n\'est pas activée sur ce serveur. Un administrateur peut l\'activer avec `/economie`.');
    return eco;
  }

  /** Compte d'un membre (valeurs à zéro s'il n'en a pas encore). */
  account(guildId, userId) {
    return this.repo.get(guildId, userId) ?? { guild_id: guildId, user_id: userId, balance: 0, last_daily: null, last_weekly: null, last_work: null, daily_streak: 0 };
  }

  rank(guildId, userId) {
    return this.repo.rank(guildId, userId);
  }

  /** Écrit un nouveau solde + la ligne d'historique (dans une transaction en cours). */
  #write(guildId, userId, before, after, kind, ref, now) {
    this.repo.setBalance(guildId, userId, after, now);
    return this.repo.addTransaction({ guildId, userId, delta: after - before, balanceAfter: after, kind, ref, now });
  }

  #capError(eco) {
    return new UserError(`Votre solde a atteint le plafond du serveur (${E.money(eco.limits.maxBalance, eco)}) : dépensez-en un peu avant de gagner davantage.`);
  }

  // ------------------------------------------------------------ gains

  /** /eco quotidien. @returns {{ amount, base, bonus, streak, credited, capped, balance }} */
  claimDaily(guildId, userId, now = Date.now()) {
    const eco = this.assertEnabled(guildId);
    return this.repo.transaction(() => {
      const acc = this.repo.ensure(guildId, userId, now);
      const r = E.dailyReward(eco, acc, now);
      if (!r.ready) throw new UserError(`Vous avez déjà récupéré votre récompense quotidienne. Revenez ${discordTimestamp(r.nextAt, 'R')}.`);
      const credited = E.capCredit(acc.balance, r.amount, eco.limits.maxBalance);
      if (credited <= 0) throw this.#capError(eco);
      const balance = acc.balance + credited;
      this.#write(guildId, userId, acc.balance, balance, 'daily', r.streak, now);
      this.repo.setDaily(guildId, userId, now, r.streak);
      return { ...r, credited, capped: credited < r.amount, balance };
    });
  }

  /** /eco hebdo. */
  claimWeekly(guildId, userId, now = Date.now()) {
    const eco = this.assertEnabled(guildId);
    return this.repo.transaction(() => {
      const acc = this.repo.ensure(guildId, userId, now);
      const next = E.weeklyNext(acc, now);
      if (next) throw new UserError(`Vous avez déjà récupéré votre récompense hebdomadaire. Revenez ${discordTimestamp(next, 'R')}.`);
      const amount = eco.weekly.amount;
      const credited = E.capCredit(acc.balance, amount, eco.limits.maxBalance);
      if (credited <= 0) throw this.#capError(eco);
      const balance = acc.balance + credited;
      this.#write(guildId, userId, acc.balance, balance, 'weekly', null, now);
      this.repo.setWeekly(guildId, userId, now);
      return { amount, credited, capped: credited < amount, balance };
    });
  }

  /** /eco travail : gain aléatoire borné, délai réglable. */
  work(guildId, userId, now = Date.now(), rng = Math.random) {
    const eco = this.assertEnabled(guildId);
    return this.repo.transaction(() => {
      const acc = this.repo.ensure(guildId, userId, now);
      const next = E.workNext(eco, acc, now);
      if (next) throw new UserError(`Vous êtes encore fatigué de votre dernier travail. Reprenez ${discordTimestamp(next, 'R')}.`);
      const { amount, template } = E.workOutcome(eco, rng);
      const credited = E.capCredit(acc.balance, amount, eco.limits.maxBalance);
      if (credited <= 0) throw this.#capError(eco);
      const balance = acc.balance + credited;
      this.#write(guildId, userId, acc.balance, balance, 'work', null, now);
      this.repo.setWork(guildId, userId, now);
      return { amount, credited, capped: credited < amount, template, balance, nextAt: now + eco.work.cooldownMinutes * E.MINUTE_MS };
    });
  }

  // ------------------------------------------------------------ virements

  /**
   * Montant reçu et taxe d'un virement. Pur. Taxe arrondie au SUPÉRIEUR dès qu'elle est
   * activée : des petits virements successifs ne l'esquivent plus.
   */
  static transferSplit(amount, taxPercent) {
    const tax = taxPercent > 0 ? Math.ceil((amount * taxPercent) / 100) : 0;
    return { tax, received: amount - tax };
  }

  /** Vérifications d'un virement (avant confirmation). @returns {{ tax, received }} */
  checkTransfer(guildId, fromId, toId, amount) {
    const eco = this.assertEnabled(guildId);
    if (!Number.isInteger(amount) || amount < 1 || amount > E.HARD_MAX) throw new UserError('Le montant doit être un nombre entier positif.');
    if (fromId === toId) throw new UserError('Vous ne pouvez pas vous payer vous-même.');
    const split = EconomyService.transferSplit(amount, eco.transfers.taxPercent);
    if (split.received < 1) throw new UserError(`Montant trop faible : après la taxe de **${eco.transfers.taxPercent} %**, le destinataire ne recevrait rien.`);
    const balance = this.account(guildId, fromId).balance;
    if (balance < amount) throw new UserError(`Solde insuffisant : vous avez ${E.money(balance, eco)}.`);
    return { ...split, eco };
  }

  /** Virement : débit, crédit (moins la taxe, détruite) et deux lignes d'historique, atomiquement. */
  transfer(guildId, fromId, toId, amount, now = Date.now()) {
    const { eco } = this.checkTransfer(guildId, fromId, toId, amount);
    return this.repo.transaction(() => {
      const { tax, received } = EconomyService.transferSplit(amount, eco.transfers.taxPercent);
      const from = this.repo.ensure(guildId, fromId, now);
      if (from.balance < amount) throw new UserError(`Solde insuffisant : vous avez ${E.money(from.balance, eco)}.`);
      const to = this.repo.ensure(guildId, toId, now);
      if (to.balance + received > eco.limits.maxBalance) throw new UserError(`Le solde de <@${toId}> dépasserait le plafond du serveur (${E.money(eco.limits.maxBalance, eco)}).`);
      const fromAfter = from.balance - amount;
      const toAfter = to.balance + received;
      this.#write(guildId, fromId, from.balance, fromAfter, 'transfer_out', toId, now);
      this.#write(guildId, toId, to.balance, toAfter, 'transfer_in', fromId, now);
      return { amount, tax, received, fromBalance: fromAfter, toBalance: toAfter };
    });
  }

  // ------------------------------------------------------------ boutique

  /** Jeton anti-double-clic d'un acheteur : identifiant de son dernier achat (0 : aucun). */
  purchaseToken(guildId, userId) {
    return this.repo.lastOfKind(guildId, userId, 'buy').id;
  }

  /**
   * Achat : le jeton (dernier achat connu à l'affichage) doit être inchangé, sinon le clic
   * est un doublon ou la vue est périmée. Débit, stock et inventaire dans la même transaction.
   * Les vérifications Discord (rôle attribuable) sont faites par l'appelant.
   * @returns {{ item: object, balance: number, txId: number }}
   */
  buy(guildId, userId, itemId, token, now = Date.now()) {
    const eco = this.assertEnabled(guildId);
    return this.repo.transaction(() => {
      const item = this.repo.getItem(guildId, itemId);
      if (!item) throw new UserError('Cet article n\'existe plus : actualisez la boutique.');
      if (this.purchaseToken(guildId, userId) !== token) throw new UserError('Achat déjà effectué (double clic ?) ou boutique périmée : actualisez la boutique avant de racheter.');
      const acc = this.repo.ensure(guildId, userId, now);
      if (acc.balance < item.price) throw new UserError(`Solde insuffisant : ${E.money(item.price, eco)} nécessaires, vous avez ${E.money(acc.balance, eco)}.`);
      if (!this.repo.takeStock(guildId, item.id)) throw new UserError(`**${item.name}** est en rupture de stock.`);
      const balance = acc.balance - item.price;
      const txId = this.#write(guildId, userId, acc.balance, balance, 'buy', `${item.id}:${item.name}`, now);
      if (item.kind !== 'role') this.repo.addInventory(guildId, userId, item.id, 1, now);
      return { item, balance, txId };
    });
  }

  /** Annule un achat de rôle qui n'a pas pu être attribué (crédit et stock rendus). */
  refund(guildId, userId, item, now = Date.now()) {
    return this.repo.transaction(() => {
      const acc = this.repo.ensure(guildId, userId, now);
      const balance = acc.balance + item.price;
      this.#write(guildId, userId, acc.balance, balance, 'refund', `${item.id}:${item.name}`, now);
      this.repo.restoreStock(guildId, item.id);
      return { balance };
    });
  }

  inventory(guildId, userId) {
    return this.repo.inventory(guildId, userId);
  }

  // ------------------------------------------------------------ jeux

  /**
   * Partie de pile ou face / machine à sous : mise plafonnée et couverte par le solde,
   * délai entre deux parties, gain plafonné au solde maximal.
   * @param {'coinflip'|'slots'} game
   */
  play(guildId, userId, game, bet, { choice = 'pile', now = Date.now(), rng = Math.random } = {}) {
    const eco = this.assertEnabled(guildId);
    if (!eco.games[game]) throw new UserError(`${game === 'slots' ? 'La machine à sous' : 'Le pile ou face'} est désactivé${game === 'slots' ? 'e' : ''} sur ce serveur.`);
    if (!Number.isInteger(bet) || bet < 1) throw new UserError('La mise doit être un nombre entier positif.');
    if (bet > eco.limits.maxBet) throw new UserError(`Mise maximale : ${E.money(eco.limits.maxBet, eco)}.`);
    return this.repo.transaction(() => {
      const acc = this.repo.ensure(guildId, userId, now);
      const cooldown = eco.games.cooldownSeconds * 1000;
      const last = Math.max(this.repo.lastOfKind(guildId, userId, 'coinflip').at, this.repo.lastOfKind(guildId, userId, 'slots').at);
      if (cooldown && last && now - last < cooldown) throw new UserError(`Doucement ! Prochaine partie ${discordTimestamp(last + cooldown, 'R')}.`);
      if (acc.balance < bet) throw new UserError(`Solde insuffisant pour miser ${E.money(bet, eco)} : vous avez ${E.money(acc.balance, eco)}.`);
      const edge = eco.games.houseEdgePercent;
      const outcome = game === 'slots' ? E.playSlots(bet, edge, rng) : E.playCoinflip(bet, choice === 'face' ? 'face' : 'pile', edge, rng);
      let balance = acc.balance - bet + outcome.payout;
      // Plafond : un gain ne fait jamais dépasser le solde maximal, mais ne fait jamais perdre non
      // plus (solde déjà au-dessus d'un plafond abaissé : gain ramené à ±0) ; une perte reste une perte.
      if (balance > eco.limits.maxBalance) balance = Math.max(eco.limits.maxBalance, Math.min(acc.balance, balance));
      const ref = game === 'slots' ? outcome.reels.join('') : `${outcome.side} · ${outcome.won ? 'gagné' : 'perdu'}`;
      this.#write(guildId, userId, acc.balance, balance, game, ref, now);
      return { ...outcome, bet, before: acc.balance, balance, delta: balance - acc.balance, capped: balance < acc.balance - bet + outcome.payout, edge };
    });
  }

  // ------------------------------------------------------------ administration

  /**
   * Don, retrait ou solde défini par un administrateur (plafond respecté).
   * @param {'give'|'take'|'set'} op
   * @returns {{ before: number, after: number, capped: boolean }}
   */
  adminAdjust(guildId, userId, op, amount, moderatorId, now = Date.now()) {
    const eco = this.settings(guildId);
    if (!['give', 'take', 'set'].includes(op)) throw new UserError('Opération inconnue.');
    if (!Number.isInteger(amount) || amount < 0 || amount > E.HARD_MAX) throw new UserError('Montant invalide.');
    if (op === 'set' && amount > eco.limits.maxBalance) throw new UserError(`Le solde maximal du serveur est ${E.money(eco.limits.maxBalance, eco)}.`);
    return this.repo.transaction(() => {
      const acc = this.repo.ensure(guildId, userId, now);
      let after = acc.balance;
      if (op === 'give') after = acc.balance + E.capCredit(acc.balance, amount, eco.limits.maxBalance);
      else if (op === 'take') after = Math.max(0, acc.balance - amount);
      else after = amount;
      const wanted = op === 'give' ? acc.balance + amount : op === 'take' ? acc.balance - amount : amount;
      if (after !== acc.balance) this.#write(guildId, userId, acc.balance, after, 'admin', `${op}:${moderatorId}`, now);
      return { before: acc.balance, after, capped: after !== wanted };
    });
  }

  /** Remise à zéro d'un membre (compte, objets, historique). */
  resetMember(guildId, userId) {
    return this.repo.deleteMember(guildId, userId);
  }

  /** Remise à zéro de tout le serveur (la boutique et les réglages sont conservés). */
  resetGuild(guildId) {
    return this.repo.deleteGuild(guildId);
  }

  /** Statistiques du tableau de bord. */
  stats(guildId, now = Date.now()) {
    return this.repo.stats(guildId, now - E.DAY_MS);
  }

  // ------------------------------------------------------------ articles

  /**
   * Crée un article (25 par serveur). Données déjà validées par l'appelant.
   * @param {{ name: string, description?: string|null, emoji?: string|null, price: number, stock?: number|null, kind?: 'item'|'role', roleId?: string|null }} data
   */
  addItem(guildId, data, now = Date.now()) {
    return this.repo.transaction(() => {
      if (this.repo.countItems(guildId) >= E.MAX_ITEMS) throw new UserError(`${E.MAX_ITEMS} articles maximum : supprimez-en un d'abord.`);
      if (data.kind === 'role' && this.repo.listItems(guildId).some((i) => i.kind === 'role' && i.role_id === data.roleId)) {
        throw new UserError('Ce rôle est déjà en vente : modifiez l\'article existant.');
      }
      return this.repo.insertItem({ guildId, ...data, kind: data.kind === 'role' ? 'role' : 'item', now });
    });
  }

  updateItem(guildId, id, data, now = Date.now()) {
    const item = this.repo.updateItem(guildId, id, { ...data, now });
    if (!item) throw new UserError('Cet article n\'existe plus.');
    return item;
  }

  deleteItem(guildId, id) {
    const item = this.repo.getItem(guildId, id);
    if (!item || !this.repo.deleteItem(guildId, id)) throw new UserError('Cet article n\'existe plus.');
    return item;
  }

  getItem(guildId, id) {
    return this.repo.getItem(guildId, id);
  }

  listItems(guildId) {
    return this.repo.listItems(guildId);
  }
}

module.exports = { EconomyService, roleIssue };
