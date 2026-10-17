'use strict';

/** Types d'accès de whitelist suivis (pas de contrainte CHECK en base : validés ici). */
const GRANT_KINDS = Object.freeze(['role', 'user', 'wlrole']);
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Accès de whitelist en attente d'approbation (Secur §6). Un accès est « en attente » tant qu'il
 * n'est ni approuvé ni révoqué : il ne devient JAMAIS actif tout seul (un admin compromis ne
 * s'auto-whiteliste pas en attendant l'absence du propriétaire). Toutes les requêtes sont filtrées
 * par guild_id ; approbation et révocation sont verrouillées en SQL. Seuls les accès TRANCHÉS sont
 * purgés.
 */
class SecurityGrantRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO security_grants (guild_id, kind, subject_id, role_id, granted_by, granted_at)
       VALUES (@guildId, @kind, @subjectId, @roleId, @grantedBy, @grantedAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM security_grants WHERE id = ? AND guild_id = ?');
    this.pendingStmt = db.prepare(
      `SELECT * FROM security_grants WHERE guild_id = ? AND granted_at > ? AND approved_at IS NULL AND revoked_at IS NULL
       ORDER BY granted_at DESC, id DESC LIMIT 100`,
    );
    // Accès en attente qui concernent un utilisateur : les siens, et les rôles ajoutés à la whitelist.
    this.pendingForStmt = db.prepare(
      `SELECT * FROM security_grants WHERE guild_id = ? AND approved_at IS NULL AND revoked_at IS NULL
         AND (subject_id = ? OR kind = 'wlrole')
       ORDER BY granted_at DESC, id DESC LIMIT 500`,
    );
    this.approveSameStmt = db.prepare(
      `UPDATE security_grants SET approved_by = @by, approved_at = @at WHERE guild_id = @guildId AND subject_id = @subjectId AND kind = @kind
         AND IFNULL(role_id, '') = IFNULL(@roleId, '') AND approved_at IS NULL AND revoked_at IS NULL`,
    );
    this.samePendingStmt = db.prepare(
      `SELECT * FROM security_grants WHERE guild_id = @guildId AND subject_id = @subjectId AND kind = @kind
         AND IFNULL(role_id, '') = IFNULL(@roleId, '') AND granted_at > @since AND approved_at IS NULL AND revoked_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    );
    this.approveStmt = db.prepare('UPDATE security_grants SET approved_by = ?, approved_at = ? WHERE id = ? AND guild_id = ? AND approved_at IS NULL AND revoked_at IS NULL');
    this.revokeStmt = db.prepare('UPDATE security_grants SET revoked_by = ?, revoked_at = ? WHERE id = ? AND guild_id = ? AND approved_at IS NULL AND revoked_at IS NULL');
    this.cardStmt = db.prepare('UPDATE security_grants SET card_channel_id = ?, card_message_id = ? WHERE id = ? AND guild_id = ?');
    this.purgeStmt = db.prepare('DELETE FROM security_grants WHERE granted_at < ? AND (approved_at IS NOT NULL OR revoked_at IS NOT NULL)');
    this.purgeGuildStmt = db.prepare('DELETE FROM security_grants WHERE guild_id = ?');
  }

  /**
   * Enregistre un accès en attente. Le même accès déjà en attente (même membre, rôle, type)
   * n'est pas dupliqué : son identifiant est renvoyé avec `existing: true`. `ttlMs` (facultatif,
   * historique) : ne cherche le doublon que parmi les accès plus récents.
   * @returns {{ id: number, existing: boolean }}
   */
  create({ guildId, kind, subjectId, roleId = null, grantedBy, grantedAt = Date.now(), ttlMs = null }) {
    if (!GRANT_KINDS.includes(kind)) throw new Error(`Type d'accès inconnu : ${kind}`);
    if (!SNOWFLAKE.test(String(subjectId ?? '')) || !SNOWFLAKE.test(String(grantedBy ?? ''))) throw new Error('Accès de whitelist : identifiants invalides.');
    const same = this.samePendingStmt.get({ guildId, subjectId, kind, roleId, since: Number.isFinite(ttlMs) ? grantedAt - ttlMs : 0 });
    if (same) return { id: same.id, existing: true };
    const info = this.insertStmt.run({ guildId, kind, subjectId, roleId, grantedBy, grantedAt });
    return { id: Number(info.lastInsertRowid), existing: false };
  }

  get(guildId, id) {
    return this.getStmt.get(id, guildId) ?? null;
  }

  /** Accès encore en attente (ni approuvés, ni révoqués, attribués après `since` : 0 pour tous). */
  pending(guildId, since = 0) {
    return this.pendingStmt.all(guildId, since);
  }

  /** Accès en attente qui concernent cet utilisateur (les siens, et les rôles ajoutés à la whitelist). */
  pendingFor(guildId, userId) {
    return this.pendingForStmt.all(guildId, String(userId ?? ''));
  }

  /** Le même accès donné par un owner : les attentes correspondantes sont approuvées. @returns {number} */
  approveSame({ guildId, kind, subjectId, roleId = null, by, at = Date.now() }) {
    return this.approveSameStmt.run({ guildId, kind, subjectId, roleId, by, at }).changes;
  }

  /** Verrou : true si CET appel a approuvé l'accès. */
  approve(guildId, id, by, at = Date.now()) {
    return this.approveStmt.run(by, at, id, guildId).changes === 1;
  }

  /** Verrou : true si CET appel a révoqué l'accès. */
  revoke(guildId, id, by, at = Date.now()) {
    return this.revokeStmt.run(by, at, id, guildId).changes === 1;
  }

  setCard(guildId, id, channelId, messageId) {
    return this.cardStmt.run(channelId ?? null, messageId ?? null, id, guildId).changes;
  }

  /** Purge des accès TRANCHÉS (approuvés ou révoqués) attribués avant `before`. @returns {number} */
  purgeBefore(before) {
    return this.purgeStmt.run(before).changes;
  }

  purgeGuild(guildId) {
    return this.purgeGuildStmt.run(guildId).changes;
  }
}

module.exports = { SecurityGrantRepository, GRANT_KINDS };
