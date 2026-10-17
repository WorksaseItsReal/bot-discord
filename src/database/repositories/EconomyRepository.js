'use strict';

const { TX_KEEP } = require('../../utils/economy');

/**
 * Économie (/eco, /economie) : comptes, boutique, inventaires et historique.
 *
 * Les règles (soldes suffisants, plafonds, délais) vivent dans EconomyService, qui
 * compose ces primitives À L'INTÉRIEUR de `transaction()` : la lecture du solde et
 * son écriture sont atomiques (better-sqlite3 est synchrone, BEGIN IMMEDIATE), donc
 * jamais de solde négatif ni de double débit, même sur des clics simultanés.
 */
class EconomyRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    // Comptes
    this.ensureStmt = db.prepare(
      `INSERT INTO economy_accounts (guild_id, user_id, balance, daily_streak, updated_at)
       VALUES (?, ?, 0, 0, ?) ON CONFLICT (guild_id, user_id) DO NOTHING`,
    );
    this.getStmt = db.prepare('SELECT * FROM economy_accounts WHERE guild_id = ? AND user_id = ?');
    this.balanceStmt = db.prepare('UPDATE economy_accounts SET balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?');
    this.dailyStmt = db.prepare('UPDATE economy_accounts SET last_daily = ?, daily_streak = ? WHERE guild_id = ? AND user_id = ?');
    this.weeklyStmt = db.prepare('UPDATE economy_accounts SET last_weekly = ? WHERE guild_id = ? AND user_id = ?');
    this.workStmt = db.prepare('UPDATE economy_accounts SET last_work = ? WHERE guild_id = ? AND user_id = ?');
    this.boardStmt = db.prepare(
      `SELECT user_id, balance FROM economy_accounts WHERE guild_id = ? AND balance > 0
       ORDER BY balance DESC, user_id ASC LIMIT ? OFFSET ?`,
    );
    this.rankedStmt = db.prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND balance > 0');
    this.rankStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM economy_accounts
       WHERE guild_id = @guildId AND balance > 0 AND (balance > @balance OR (balance = @balance AND user_id < @userId))`,
    );
    this.statsStmt = db.prepare(
      `SELECT COUNT(*) AS accounts, COALESCE(SUM(balance), 0) AS supply, COALESCE(MAX(balance), 0) AS richest,
              COALESCE(SUM(CASE WHEN balance > 0 THEN 1 ELSE 0 END), 0) AS holders
       FROM economy_accounts WHERE guild_id = ?`,
    );
    // Historique
    this.txStmt = db.prepare(
      `INSERT INTO economy_transactions (guild_id, user_id, delta, balance_after, kind, ref, created_at)
       VALUES (@guildId, @userId, @delta, @balanceAfter, @kind, @ref, @now)`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM economy_transactions WHERE guild_id = @guildId AND user_id = @userId AND id <= (
         SELECT id FROM economy_transactions WHERE guild_id = @guildId AND user_id = @userId
         ORDER BY id DESC LIMIT 1 OFFSET @keep)`,
    );
    this.historyStmt = db.prepare('SELECT * FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?');
    this.lastOfKindStmt = db.prepare('SELECT MAX(id) AS id, MAX(created_at) AS at FROM economy_transactions WHERE guild_id = ? AND user_id = ? AND kind = ?');
    this.recentStmt = db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(delta), 0) AS net,
              COALESCE(SUM(CASE WHEN kind = 'buy' THEN 1 WHEN kind = 'refund' THEN -1 ELSE 0 END), 0) AS purchases
       FROM economy_transactions WHERE guild_id = ? AND created_at >= ?`,
    );
    // Boutique
    this.itemsStmt = db.prepare('SELECT * FROM economy_items WHERE guild_id = ? ORDER BY price ASC, id ASC');
    this.itemStmt = db.prepare('SELECT * FROM economy_items WHERE guild_id = ? AND id = ?');
    this.itemCountStmt = db.prepare('SELECT COUNT(*) AS n FROM economy_items WHERE guild_id = ?');
    this.itemInsertStmt = db.prepare(
      `INSERT INTO economy_items (guild_id, name, description, emoji, price, kind, role_id, stock, created_at, updated_at)
       VALUES (@guildId, @name, @description, @emoji, @price, @kind, @roleId, @stock, @now, @now)`,
    );
    this.itemUpdateStmt = db.prepare(
      `UPDATE economy_items SET name = @name, description = @description, emoji = @emoji, price = @price,
         stock = @stock, updated_at = @now WHERE guild_id = @guildId AND id = @id`,
    );
    this.itemDeleteStmt = db.prepare('DELETE FROM economy_items WHERE guild_id = ? AND id = ?');
    this.takeStockStmt = db.prepare('UPDATE economy_items SET stock = stock - 1 WHERE guild_id = ? AND id = ? AND (stock IS NULL OR stock > 0)');
    this.restoreStockStmt = db.prepare('UPDATE economy_items SET stock = stock + 1 WHERE guild_id = ? AND id = ? AND stock IS NOT NULL');
    this.ownersStmt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS qty FROM economy_inventory WHERE item_id = ? AND quantity > 0');
    // Inventaire
    this.inventoryStmt = db.prepare(
      `SELECT i.id, i.name, i.emoji, i.description, inv.quantity, inv.acquired_at
       FROM economy_inventory inv JOIN economy_items i ON i.id = inv.item_id
       WHERE inv.guild_id = ? AND inv.user_id = ? AND inv.quantity > 0
       ORDER BY inv.acquired_at DESC, i.id ASC`,
    );
    this.addInvStmt = db.prepare(
      `INSERT INTO economy_inventory (guild_id, user_id, item_id, quantity, acquired_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity, acquired_at = excluded.acquired_at`,
    );
    // Réinitialisations
    this.delMemberAccStmt = db.prepare('DELETE FROM economy_accounts WHERE guild_id = ? AND user_id = ?');
    this.delMemberInvStmt = db.prepare('DELETE FROM economy_inventory WHERE guild_id = ? AND user_id = ?');
    this.delMemberTxStmt = db.prepare('DELETE FROM economy_transactions WHERE guild_id = ? AND user_id = ?');
    this.delGuildAccStmt = db.prepare('DELETE FROM economy_accounts WHERE guild_id = ?');
    this.delGuildInvStmt = db.prepare('DELETE FROM economy_inventory WHERE guild_id = ?');
    this.delGuildTxStmt = db.prepare('DELETE FROM economy_transactions WHERE guild_id = ?');
  }

  /**
   * Exécute `fn` dans une transaction (BEGIN IMMEDIATE) : toute exception l'annule.
   * Imbriquée dans une autre transaction, elle devient un point de sauvegarde.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    const run = this.db.transaction(fn);
    return this.db.inTransaction ? run() : run.immediate();
  }

  // ------------------------------------------------------------ comptes

  /** Compte (créé à 0 au besoin) : à appeler dans une transaction avant une écriture. */
  ensure(guildId, userId, now = Date.now()) {
    this.ensureStmt.run(guildId, userId, now);
    return this.getStmt.get(guildId, userId);
  }

  /** Compte existant, ou null. */
  get(guildId, userId) {
    return this.getStmt.get(guildId, userId) ?? null;
  }

  setBalance(guildId, userId, balance, now = Date.now()) {
    this.balanceStmt.run(balance, now, guildId, userId);
  }

  setDaily(guildId, userId, at, streak) {
    this.dailyStmt.run(at, streak, guildId, userId);
  }

  setWeekly(guildId, userId, at) {
    this.weeklyStmt.run(at, guildId, userId);
  }

  setWork(guildId, userId, at) {
    this.workStmt.run(at, guildId, userId);
  }

  /** Comptes au solde positif, du plus riche au moins riche. */
  leaderboard(guildId, limit = 10, offset = 0) {
    return this.boardStmt.all(guildId, limit, offset);
  }

  /** Nombre de comptes classés (solde > 0). */
  countRanked(guildId) {
    return this.rankedStmt.get(guildId).n;
  }

  /** Rang (1 = plus riche), ou null si le solde est nul. */
  rank(guildId, userId) {
    const acc = this.get(guildId, userId);
    if (!acc || acc.balance <= 0) return null;
    return this.rankStmt.get({ guildId, balance: acc.balance, userId }).n + 1;
  }

  /** Masse monétaire et répartition. */
  stats(guildId, since = Date.now() - 86_400_000) {
    const s = this.statsStmt.get(guildId);
    const recent = this.recentStmt.get(guildId, since);
    return { ...s, items: this.countItems(guildId), recent };
  }

  // ------------------------------------------------------------ historique

  /** Ligne d'historique (et purge au-delà de TX_KEEP lignes pour ce membre). @returns {number} id */
  addTransaction({ guildId, userId, delta, balanceAfter, kind, ref = null, now = Date.now() }) {
    const id = Number(this.txStmt.run({ guildId, userId, delta, balanceAfter, kind, ref: ref == null ? null : String(ref).slice(0, 120), now }).lastInsertRowid);
    this.pruneStmt.run({ guildId, userId, keep: TX_KEEP });
    return id;
  }

  history(guildId, userId, limit = 15) {
    return this.historyStmt.all(guildId, userId, limit);
  }

  /** Dernière ligne d'un type : { id, at } (0 si aucune). */
  lastOfKind(guildId, userId, kind) {
    const row = this.lastOfKindStmt.get(guildId, userId, kind);
    return { id: row?.id ?? 0, at: row?.at ?? 0 };
  }

  // ------------------------------------------------------------ boutique

  listItems(guildId) {
    return this.itemsStmt.all(guildId);
  }

  getItem(guildId, id) {
    return this.itemStmt.get(guildId, id) ?? null;
  }

  countItems(guildId) {
    return this.itemCountStmt.get(guildId).n;
  }

  /** @returns {object} l'article créé */
  insertItem({ guildId, name, description = null, emoji = null, price, kind = 'item', roleId = null, stock = null, now = Date.now() }) {
    const id = Number(this.itemInsertStmt.run({ guildId, name, description, emoji, price, kind, roleId, stock, now }).lastInsertRowid);
    return this.getItem(guildId, id);
  }

  /** @returns {object|null} l'article modifié */
  updateItem(guildId, id, { name, description = null, emoji = null, price, stock = null, now = Date.now() }) {
    const changes = this.itemUpdateStmt.run({ guildId, id, name, description, emoji, price, stock, now }).changes;
    return changes ? this.getItem(guildId, id) : null;
  }

  /** Supprime l'article (et, en cascade, les objets possédés). @returns {boolean} */
  deleteItem(guildId, id) {
    return this.itemDeleteStmt.run(guildId, id).changes > 0;
  }

  /** Retire une unité du stock (stock illimité : toujours vrai). @returns {boolean} */
  takeStock(guildId, id) {
    return this.takeStockStmt.run(guildId, id).changes > 0;
  }

  restoreStock(guildId, id) {
    this.restoreStockStmt.run(guildId, id);
  }

  /** Détenteurs d'un objet : { n: membres, qty: unités }. */
  owners(itemId) {
    return this.ownersStmt.get(itemId);
  }

  // ------------------------------------------------------------ inventaire

  inventory(guildId, userId) {
    return this.inventoryStmt.all(guildId, userId);
  }

  addInventory(guildId, userId, itemId, quantity = 1, now = Date.now()) {
    this.addInvStmt.run(guildId, userId, itemId, quantity, now);
  }

  // ------------------------------------------------------------ réinitialisations

  /** Efface compte, objets et historique d'un membre. @returns {boolean} un compte existait */
  deleteMember(guildId, userId) {
    return this.transaction(() => {
      this.delMemberInvStmt.run(guildId, userId);
      this.delMemberTxStmt.run(guildId, userId);
      return this.delMemberAccStmt.run(guildId, userId).changes > 0;
    });
  }

  /** Efface comptes, objets et historique du serveur (la boutique est conservée). @returns {number} comptes effacés */
  deleteGuild(guildId) {
    return this.transaction(() => {
      this.delGuildInvStmt.run(guildId);
      this.delGuildTxStmt.run(guildId);
      return this.delGuildAccStmt.run(guildId).changes;
    });
  }
}

module.exports = { EconomyRepository };
