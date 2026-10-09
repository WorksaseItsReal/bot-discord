'use strict';

/** XP maximale d'un membre (garde-fou : niveau < 1000, entier SQLite sûr). */
const MAX_XP = 1_000_000_000;

const clampXp = (xp) => Math.min(MAX_XP, Math.max(0, Math.floor(Number(xp) || 0)));

/**
 * Niveaux / XP par membre et par serveur. Requêtes préparées uniquement.
 * Le niveau est calculé par le service (formule pure) et stocké pour l'affichage.
 *
 * Membres partis (`left_at` non NULL, migration 17) : exclus du classement, du rang
 * et du total, mais leur XP est conservée ; elle compte de nouveau à leur retour.
 */
class LevelRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.getStmt = db.prepare('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO levels (guild_id, user_id, xp, level, messages, voice_minutes, last_message_at)
       VALUES (@guild_id, @user_id, @xp, @level, @messages, @voice_minutes, @last_message_at)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         xp = excluded.xp, level = excluded.level, messages = excluded.messages,
         voice_minutes = excluded.voice_minutes, last_message_at = excluded.last_message_at`,
    );
    this.boardStmt = db.prepare(
      'SELECT user_id, xp, level, messages, voice_minutes FROM levels WHERE guild_id = ? AND xp > 0 AND left_at IS NULL ORDER BY xp DESC, user_id ASC LIMIT ? OFFSET ?',
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND xp > 0 AND left_at IS NULL');
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND xp > 0');
    this.aboveStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND left_at IS NULL AND (xp > ? OR (xp = ? AND user_id < ?))',
    );
    this.markLeftStmt = db.prepare('UPDATE levels SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL');
    this.markReturnedStmt = db.prepare('UPDATE levels SET left_at = NULL WHERE guild_id = ? AND user_id = ? AND left_at IS NOT NULL');
    this.countLeftStmt = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND left_at IS NOT NULL AND left_at <= ?');
    this.purgeLeftStmt = db.prepare('DELETE FROM levels WHERE guild_id = ? AND left_at IS NOT NULL AND left_at <= ?');
    this.resetMemberStmt = db.prepare('DELETE FROM levels WHERE guild_id = ? AND user_id = ?');
    this.resetGuildStmt = db.prepare('DELETE FROM levels WHERE guild_id = ?');

    /** Lecture + écriture atomiques (deux gains simultanés ne s'écrasent pas). */
    this.applyTx = db.transaction((guildId, userId, change, levelOf) => {
      const before = this.get(guildId, userId);
      const base = before ?? { guild_id: guildId, user_id: userId, xp: 0, level: 0, messages: 0, voice_minutes: 0, last_message_at: null, left_at: null };
      const xp = clampXp(change.setXp != null ? change.setXp : base.xp + (change.xp ?? 0));
      const after = {
        guild_id: guildId,
        user_id: userId,
        xp,
        level: levelOf(xp),
        messages: base.messages + (change.messages ?? 0),
        voice_minutes: base.voice_minutes + (change.voiceMinutes ?? 0),
        last_message_at: change.at ?? base.last_message_at,
      };
      this.upsertStmt.run(after);
      // Gain d'XP (message, vocal) : le membre est forcément présent sur le serveur.
      if (change.present && base.left_at != null) this.markReturnedStmt.run(guildId, userId);
      return { before: before ?? base, after };
    });
    this.importTx = db.transaction((guildId, entries, levelOf) => {
      let n = 0;
      for (const { userId, xp } of entries) {
        this.applyTx(guildId, userId, { setXp: xp }, levelOf);
        n += 1;
      }
      return n;
    });
  }

  /** Ligne d'un membre, ou null. */
  get(guildId, userId) {
    return this.getStmt.get(guildId, userId) ?? null;
  }

  /**
   * Ajoute de l'XP (et des compteurs) à un membre.
   * @param {{ xp?: number, messages?: number, voiceMinutes?: number, at?: number, present?: boolean }} change
   *   present : le membre est sur le serveur (son éventuelle marque de départ est effacée)
   * @param {(xp: number) => number} levelOf formule de niveau
   * @returns {{ before: object, after: object }}
   */
  add(guildId, userId, change, levelOf) {
    return this.applyTx(guildId, userId, change, levelOf);
  }

  /** Définit l'XP exacte d'un membre. */
  setXp(guildId, userId, xp, levelOf) {
    return this.applyTx(guildId, userId, { setXp: xp }, levelOf);
  }

  /** Définit l'XP de plusieurs membres en une transaction. @returns {number} */
  importMany(guildId, entries, levelOf) {
    return this.importTx(guildId, entries, levelOf);
  }

  /** Page du classement (XP décroissante, puis identifiant pour un ordre stable). */
  leaderboard(guildId, limit = 10, offset = 0) {
    return this.boardStmt.all(guildId, limit, offset);
  }

  /** Nombre de membres classés (XP > 0, présents sur le serveur). */
  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  /** Nombre de lignes avec de l'XP, membres partis compris. */
  countAll(guildId) {
    return this.countAllStmt.get(guildId).n;
  }

  /** Rang (1 = premier) d'un membre classé, ou null s'il n'a pas d'XP ou a quitté le serveur. */
  rank(guildId, userId) {
    const row = this.get(guildId, userId);
    if (!row || row.xp <= 0 || row.left_at != null) return null;
    return this.aboveStmt.get(guildId, row.xp, row.xp, userId).n + 1;
  }

  /** @returns {number} lignes supprimées */
  resetMember(guildId, userId) {
    return this.resetMemberStmt.run(guildId, userId).changes;
  }

  /**
   * Marque le départ d'un membre (sans effacer son XP). Sans effet s'il n'a pas de
   * ligne ou s'il est déjà marqué (la date du premier départ est conservée).
   * @returns {boolean} une ligne a été marquée
   */
  markLeft(guildId, userId, at = Date.now()) {
    return this.markLeftStmt.run(Math.floor(at), guildId, userId).changes > 0;
  }

  /** Efface la marque de départ (retour du membre). @returns {boolean} */
  markReturned(guildId, userId) {
    return this.markReturnedStmt.run(guildId, userId).changes > 0;
  }

  /** Membres partis au plus tard à `before` (tous par défaut). */
  countLeft(guildId, before = Number.MAX_SAFE_INTEGER) {
    return this.countLeftStmt.get(guildId, Math.floor(before)).n;
  }

  /** Supprime l'XP des membres partis au plus tard à `before`. @returns {number} lignes supprimées */
  purgeLeft(guildId, before) {
    return this.purgeLeftStmt.run(guildId, Math.floor(before)).changes;
  }

  /** @returns {number} lignes supprimées */
  resetGuild(guildId) {
    return this.resetGuildStmt.run(guildId).changes;
  }
}

module.exports = { LevelRepository, MAX_XP, clampXp };
