'use strict';

/** Types d'entrées (pas de contrainte CHECK en base : validés ici). */
const BLACKLIST_KINDS = Object.freeze(['ban', 'rank']);
/** Entrées au plus par serveur et par type. */
const MAX_PER_KIND = 1_000;
const SNOWFLAKE = /^\d{17,20}$/;

function assertKind(kind) {
  if (!BLACKLIST_KINDS.includes(kind)) throw new Error(`Type de liste noire inconnu : ${kind}`);
}

/**
 * Liste noire persistante (kind 'ban') et blrank (kind 'rank') : table security_blacklist
 * (migration #30), clé primaire (guild_id, user_id, kind). Toutes les requêtes d'un serveur
 * filtrent sur guild_id ; seule `due()` (étape `security` du scheduler) parcourt tous les
 * serveurs, et chaque ligne est relue (avec son serveur) avant d'agir.
 */
class SecurityBlacklistRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO security_blacklist (guild_id, user_id, kind, reason, author_id, created_at, next_check_at)
       VALUES (@guildId, @userId, @kind, @reason, @authorId, @createdAt, @nextCheckAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM security_blacklist WHERE guild_id = ? AND user_id = ? AND kind = ?');
    this.removeStmt = db.prepare('DELETE FROM security_blacklist WHERE guild_id = ? AND user_id = ? AND kind = ?');
    this.listStmt = db.prepare('SELECT * FROM security_blacklist WHERE guild_id = ? AND kind = ? ORDER BY created_at DESC, user_id LIMIT ? OFFSET ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM security_blacklist WHERE guild_id = ? AND kind = ?');
    this.dueStmt = db.prepare(
      `SELECT * FROM security_blacklist WHERE kind = 'ban' AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at, guild_id, user_id LIMIT ?`,
    );
    this.enforcedStmt = db.prepare(
      `UPDATE security_blacklist SET last_enforced_at = @at, enforce_failures = 0, next_check_at = @next
       WHERE guild_id = @guildId AND user_id = @userId AND kind = @kind`,
    );
    this.checkedStmt = db.prepare(
      `UPDATE security_blacklist SET enforce_failures = 0, next_check_at = @next
       WHERE guild_id = @guildId AND user_id = @userId AND kind = @kind`,
    );
    this.failureStmt = db.prepare(
      `UPDATE security_blacklist SET enforce_failures = enforce_failures + 1, next_check_at = @next
       WHERE guild_id = @guildId AND user_id = @userId AND kind = @kind`,
    );
    this.postponeStmt = db.prepare('UPDATE security_blacklist SET next_check_at = @next WHERE guild_id = @guildId AND user_id = @userId AND kind = @kind');
    this.purgeGuildStmt = db.prepare('DELETE FROM security_blacklist WHERE guild_id = ?');
  }

  /**
   * Ajoute une entrée (INSERT OR IGNORE). Refuse au-delà de MAX_PER_KIND entrées du type.
   * @returns {{ added: boolean, full?: boolean }} added : false si l'entrée existait déjà
   */
  add({ guildId, userId, kind, reason = null, authorId, createdAt = Date.now(), nextCheckAt = null }) {
    assertKind(kind);
    if (!SNOWFLAKE.test(String(userId ?? '')) || !SNOWFLAKE.test(String(authorId ?? ''))) throw new Error('Liste noire : identifiants invalides.');
    if (this.getStmt.get(guildId, userId, kind)) return { added: false };
    if (this.count(guildId, kind) >= MAX_PER_KIND) return { added: false, full: true };
    const info = this.insertStmt.run({ guildId, userId, kind, reason: reason ?? null, authorId, createdAt, nextCheckAt });
    return { added: info.changes === 1 };
  }

  get(guildId, userId, kind) {
    assertKind(kind);
    return this.getStmt.get(guildId, userId, kind) ?? null;
  }

  has(guildId, userId, kind) {
    return Boolean(guildId && userId && this.get(guildId, userId, kind));
  }

  /** Verrou : true si CET appel a supprimé l'entrée. */
  remove(guildId, userId, kind) {
    assertKind(kind);
    return this.removeStmt.run(guildId, userId, kind).changes === 1;
  }

  list(guildId, kind, { limit = 10, offset = 0 } = {}) {
    assertKind(kind);
    return this.listStmt.all(guildId, kind, Math.max(1, Math.min(100, limit)), Math.max(0, offset));
  }

  count(guildId, kind) {
    assertKind(kind);
    return this.countStmt.get(guildId, kind).n;
  }

  /** Entrées 'ban' à contrôler (next_check_at échu), tous serveurs confondus, bornées. */
  due(now = Date.now(), limit = 50) {
    return this.dueStmt.all(now, Math.max(1, Math.min(500, limit)));
  }

  /** Bannissement (ré)appliqué par le bot : échecs remis à zéro, prochain contrôle. */
  markEnforced(guildId, userId, kind, { at = Date.now(), next = null } = {}) {
    return this.enforcedStmt.run({ guildId, userId, kind, at, next }).changes;
  }

  /** Contrôle réussi (toujours banni) : échecs remis à zéro, prochain contrôle. */
  markChecked(guildId, userId, kind, next) {
    return this.checkedStmt.run({ guildId, userId, kind, next }).changes;
  }

  /** Échec (bannissement ou contrôle) : compteur incrémenté, prochain essai. */
  markFailure(guildId, userId, kind, next) {
    return this.failureStmt.run({ guildId, userId, kind, next }).changes;
  }

  postpone(guildId, userId, kind, next) {
    return this.postponeStmt.run({ guildId, userId, kind, next }).changes;
  }

  purgeGuild(guildId) {
    return this.purgeGuildStmt.run(guildId).changes;
  }
}

module.exports = { SecurityBlacklistRepository, BLACKLIST_KINDS, MAX_PER_KIND };
