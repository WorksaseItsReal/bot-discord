'use strict';

/**
 * Compteur de strikes par membre, utilisé pour l'escalade automatique
 * des sanctions (voir StrikeService).
 *
 * Deux tables (migration 21) :
 *  - `strikes` : total cumulé par membre (historique, compatibilité) ;
 *  - `strike_events` : un enregistrement daté par ajout. La décroissance
 *    (`strikes.decayDays`) FILTRE ces lignes par date : rien n'est supprimé, un strike
 *    ancien cesse seulement de compter dans le palier.
 * Les deux sont tenues à jour dans la même transaction.
 */
class StrikeRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.getStmt = db.prepare('SELECT count FROM strikes WHERE guild_id = ? AND user_id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO strikes (guild_id, user_id, count, updated_at) VALUES (@guildId, @userId, @count, @updatedAt)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET count = @count, updated_at = @updatedAt`,
    );
    this.resetStmt = db.prepare('DELETE FROM strikes WHERE guild_id = ? AND user_id = ?');
    this.insertEventStmt = db.prepare('INSERT INTO strike_events (guild_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)');
    this.clearEventsStmt = db.prepare('DELETE FROM strike_events WHERE guild_id = ? AND user_id = ?');
    this.sinceStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM strike_events WHERE guild_id = ? AND user_id = ? AND created_at >= ?');
    this.oldestActiveStmt = db.prepare('SELECT MIN(created_at) AS at FROM strike_events WHERE guild_id = ? AND user_id = ? AND created_at >= ? AND amount > 0');
    this.addTx = db.transaction((guildId, userId, delta, now) => {
      const current = this.get(guildId, userId);
      const next = Math.max(0, current + delta);
      // Un retrait (delta négatif) est enregistré aussi : il s'impute sur la fenêtre courante.
      if (next !== current) this.insertEventStmt.run(guildId, userId, next - current, now);
      this.upsertStmt.run({ guildId, userId, count: next, updatedAt: now });
      return next;
    });
    this.setTx = db.transaction((guildId, userId, count, now) => {
      this.clearEventsStmt.run(guildId, userId);
      if (count > 0) this.insertEventStmt.run(guildId, userId, count, now);
      this.upsertStmt.run({ guildId, userId, count, updatedAt: now });
      return count;
    });
    this.resetTx = db.transaction((guildId, userId) => {
      this.resetStmt.run(guildId, userId);
      this.clearEventsStmt.run(guildId, userId);
    });
  }

  /** Total cumulé (tous les strikes, sans décroissance). */
  get(guildId, userId) {
    const row = this.getStmt.get(guildId, userId);
    return row ? row.count : 0;
  }

  /**
   * Strikes ajoutés depuis `since` (ms) : ceux qui comptent encore avec la décroissance.
   * Jamais négatif ; jamais au-dessus du total cumulé.
   */
  countSince(guildId, userId, since) {
    const n = this.sinceStmt.get(guildId, userId, since)?.n ?? 0;
    return Math.max(0, Math.min(n, this.get(guildId, userId)));
  }

  /** Date du plus ancien strike encore compté depuis `since` (ou null). */
  oldestSince(guildId, userId, since) {
    return this.oldestActiveStmt.get(guildId, userId, since)?.at ?? null;
  }

  /** Remplace le total (une seule ligne datée de maintenant). */
  set(guildId, userId, count, now = Date.now()) {
    return this.setTx(guildId, userId, Math.max(0, count), now);
  }

  add(guildId, userId, delta = 1, now = Date.now()) {
    return this.addTx(guildId, userId, delta, now);
  }

  reset(guildId, userId) {
    this.resetTx(guildId, userId);
  }
}

module.exports = { StrikeRepository };
