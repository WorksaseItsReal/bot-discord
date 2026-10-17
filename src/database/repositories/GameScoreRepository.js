'use strict';

/** Jeux dont les scores sont conservés (clé `game` de la table). */
const GAME_KEYS = Object.freeze(['morpion', 'puissance4', 'pendu', 'quiz', 'devine']);
const OUTCOMES = Object.freeze({ win: 'wins', loss: 'losses', draw: 'draws' });
/** Garde-fou : points gagnés en une fois (entier SQLite sûr, jamais négatif). */
const MAX_POINTS = 1_000;

/**
 * Scores des mini-jeux (/jeu), par serveur, membre et jeu (migration 24).
 * Classement : points décroissants, puis victoires, puis identifiant (ordre stable).
 * `game` à null = tous les jeux additionnés.
 */
class GameScoreRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.upsertStmt = db.prepare(
      `INSERT INTO game_scores (guild_id, user_id, game, wins, losses, draws, points, updated_at)
       VALUES (@guildId, @userId, @game, @wins, @losses, @draws, @points, @now)
       ON CONFLICT (guild_id, game, user_id) DO UPDATE SET
         wins = wins + excluded.wins, losses = losses + excluded.losses, draws = draws + excluded.draws,
         points = points + excluded.points, updated_at = excluded.updated_at`,
    );
    this.getStmt = db.prepare('SELECT * FROM game_scores WHERE guild_id = ? AND game = ? AND user_id = ?');
    this.totalStmt = db.prepare(
      `SELECT user_id, SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws, SUM(points) AS points
       FROM game_scores WHERE guild_id = ? AND user_id = ? GROUP BY user_id`,
    );
    this.boardStmt = db.prepare(
      `SELECT user_id, wins, losses, draws, points FROM game_scores WHERE guild_id = ? AND game = ?
       ORDER BY points DESC, wins DESC, user_id ASC LIMIT ? OFFSET ?`,
    );
    this.boardAllStmt = db.prepare(
      `SELECT user_id, SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws, SUM(points) AS points
       FROM game_scores WHERE guild_id = ? GROUP BY user_id
       ORDER BY points DESC, wins DESC, user_id ASC LIMIT ? OFFSET ?`,
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM game_scores WHERE guild_id = ? AND game = ?');
    this.countAllStmt = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM game_scores WHERE guild_id = ?');
    this.aboveStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM game_scores WHERE guild_id = @guildId AND game = @game
       AND (points > @points OR (points = @points AND wins > @wins) OR (points = @points AND wins = @wins AND user_id < @userId))`,
    );
    this.aboveAllStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT user_id, SUM(points) AS points, SUM(wins) AS wins FROM game_scores WHERE guild_id = @guildId GROUP BY user_id
       ) WHERE points > @points OR (points = @points AND wins > @wins) OR (points = @points AND wins = @wins AND user_id < @userId)`,
    );
    this.deleteGuildStmt = db.prepare('DELETE FROM game_scores WHERE guild_id = ?');
    this.recordTx = db.transaction((entries, now) => {
      let n = 0;
      for (const e of entries) {
        const row = normalizeEntry(e);
        if (!row) continue;
        this.upsertStmt.run({ ...row, now });
        n += 1;
      }
      return n;
    });
  }

  /**
   * Enregistre des résultats (une transaction). Entrées invalides ignorées.
   * @param {{ guildId: string, userId: string, game: string, outcome: 'win'|'loss'|'draw', points?: number }[]} entries
   * @returns {number} lignes écrites
   */
  record(entries, now = Date.now()) {
    return this.recordTx(Array.isArray(entries) ? entries : [entries], now);
  }

  /** Bilan d'un membre pour un jeu (ou tous les jeux si `game` est null). */
  get(guildId, userId, game = null) {
    if (game == null) return this.totalStmt.get(guildId, userId) ?? null;
    return this.getStmt.get(guildId, game, userId) ?? null;
  }

  /** Une page du classement. */
  leaderboard(guildId, game = null, limit = 10, offset = 0) {
    return game == null ? this.boardAllStmt.all(guildId, limit, offset) : this.boardStmt.all(guildId, game, limit, offset);
  }

  /** Nombre de joueurs classés. */
  count(guildId, game = null) {
    return (game == null ? this.countAllStmt.get(guildId) : this.countStmt.get(guildId, game)).n;
  }

  /** Rang (1 = premier) d'un membre, ou null s'il n'a jamais joué. */
  rank(guildId, userId, game = null) {
    const row = this.get(guildId, userId, game);
    if (!row) return null;
    const params = { guildId, game, userId, points: row.points, wins: row.wins };
    return (game == null ? this.aboveAllStmt.get(params) : this.aboveStmt.get(params)).n + 1;
  }

  deleteGuild(guildId) {
    return this.deleteGuildStmt.run(guildId).changes;
  }
}

/** Ligne prête à écrire, ou null si l'entrée est invalide. Pur. */
function normalizeEntry(entry) {
  const { guildId, userId, game, outcome, points = 0 } = entry ?? {};
  if (!/^\d{17,20}$/.test(String(guildId ?? '')) || !/^\d{17,20}$/.test(String(userId ?? ''))) return null;
  if (!GAME_KEYS.includes(game) || !Object.hasOwn(OUTCOMES, outcome ?? '')) return null;
  const p = Math.min(MAX_POINTS, Math.max(0, Math.floor(Number(points) || 0)));
  return {
    guildId: String(guildId),
    userId: String(userId),
    game,
    wins: outcome === 'win' ? 1 : 0,
    losses: outcome === 'loss' ? 1 : 0,
    draws: outcome === 'draw' ? 1 : 0,
    points: p,
  };
}

module.exports = { GameScoreRepository, GAME_KEYS, normalizeEntry };
