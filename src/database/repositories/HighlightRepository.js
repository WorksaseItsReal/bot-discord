'use strict';

/** Liste JSON stockée → tableau de chaînes (une donnée abîmée donne une liste vide). */
function parseList(raw) {
  try {
    const list = JSON.parse(raw ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

/** Ligne SQL → entrée lisible. */
function toEntry(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    words: parseList(row.words),
    blockedChannels: parseList(row.blocked_channels),
    blockedUsers: parseList(row.blocked_users),
    paused: Number(row.paused) || 0,
    dmFailures: Number(row.dm_failures) || 0,
    updatedAt: row.updated_at,
  };
}

/**
 * Alertes de mots-clés (/alertes) : une ligne par (serveur, membre), listes en JSON.
 * paused : 0 actives · 1 en pause (membre) · 2 en pause automatique (MP fermés).
 */
class HighlightRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO highlights (guild_id, user_id, words, blocked_channels, blocked_users, paused, dm_failures, updated_at)
       VALUES (@guildId, @userId, @words, @blockedChannels, @blockedUsers, @paused, @dmFailures, @now)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         words = excluded.words, blocked_channels = excluded.blocked_channels, blocked_users = excluded.blocked_users,
         paused = excluded.paused, dm_failures = excluded.dm_failures, updated_at = excluded.updated_at`,
    );
    this.getStmt = db.prepare('SELECT * FROM highlights WHERE guild_id = ? AND user_id = ?');
    this.guildStmt = db.prepare('SELECT * FROM highlights WHERE guild_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM highlights WHERE guild_id = ? AND user_id = ?');
    this.failStmt = db.prepare('UPDATE highlights SET dm_failures = dm_failures + 1 WHERE guild_id = ? AND user_id = ?');
    this.resetFailStmt = db.prepare('UPDATE highlights SET dm_failures = 0 WHERE guild_id = ? AND user_id = ? AND dm_failures <> 0');
    this.pauseStmt = db.prepare('UPDATE highlights SET paused = ?, dm_failures = 0, updated_at = ? WHERE guild_id = ? AND user_id = ?');
  }

  /** @returns {ReturnType<typeof toEntry>} */
  get(guildId, userId) {
    return toEntry(this.getStmt.get(guildId, userId));
  }

  /** Toutes les entrées d'un serveur (reconstruction de l'index). */
  listByGuild(guildId) {
    return this.guildStmt.all(guildId).map(toEntry);
  }

  /** Enregistre l'entrée complète d'un membre. */
  save({ guildId, userId, words = [], blockedChannels = [], blockedUsers = [], paused = 0, dmFailures = 0, now = Date.now() }) {
    this.upsertStmt.run({
      guildId,
      userId,
      words: JSON.stringify(words),
      blockedChannels: JSON.stringify(blockedChannels),
      blockedUsers: JSON.stringify(blockedUsers),
      paused,
      dmFailures,
      now,
    });
    return this.get(guildId, userId);
  }

  /** Un échec d'envoi en MP de plus. @returns {number} échecs d'affilée */
  recordFailure(guildId, userId) {
    this.failStmt.run(guildId, userId);
    return this.get(guildId, userId)?.dmFailures ?? 0;
  }

  /** MP reçu : le compteur d'échecs repart de zéro (aucune écriture s'il l'était déjà). */
  resetFailures(guildId, userId) {
    return this.resetFailStmt.run(guildId, userId).changes > 0;
  }

  setPaused(guildId, userId, paused, now = Date.now()) {
    return this.pauseStmt.run(paused, now, guildId, userId).changes > 0;
  }

  /** @returns {boolean} une ligne a été supprimée */
  delete(guildId, userId) {
    return this.deleteStmt.run(guildId, userId).changes > 0;
  }
}

module.exports = { HighlightRepository, parseList };
