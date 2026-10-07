'use strict';

/**
 * Historique des sanctions. Toutes les requêtes sont paramétrées par guildId
 * afin de garantir l'isolation multi-serveurs.
 */
class SanctionRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration_ms, expires_at, active, created_at)
       VALUES (@guildId, @userId, @moderatorId, @type, @reason, @durationMs, @expiresAt, 1, @createdAt)`,
    );
    this.byUserStmt = db.prepare(
      'SELECT * FROM sanctions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    this.byIdStmt = db.prepare('SELECT * FROM sanctions WHERE id = ? AND guild_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM sanctions WHERE guild_id = ? AND user_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM sanctions WHERE id = ? AND guild_id = ?');
    this.clearUserStmt = db.prepare('DELETE FROM sanctions WHERE guild_id = ? AND user_id = ?');
    this.deactivateStmt = db.prepare('UPDATE sanctions SET active = 0 WHERE id = ?');
    this.dueStmt = db.prepare(
      'SELECT * FROM sanctions WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?',
    );
    this.activeByTypeStmt = db.prepare(
      "SELECT * FROM sanctions WHERE guild_id = ? AND type = ? AND active = 1 ORDER BY created_at DESC",
    );
    // Levée d'une sanction : on garde la trace (qui, quand, pourquoi). `revoked_by`
    // est null pour une levée automatique (sanction remplacée, débannissement hors du bot).
    this.deactivateForUserStmt = db.prepare(
      `UPDATE sanctions SET active = 0, revoked_at = @at, revoked_by = @by, revoke_reason = @reason
       WHERE guild_id = @guildId AND user_id = @userId AND type = @type AND active = 1`,
    );
    // Sanctions encore « en vigueur » : expiration future (tempban/mute/timeout) ou
    // mute sans échéance. Les supprimer de l'historique les rendrait orphelines
    // (le scheduler ne pourrait plus les lever, le mute ne serait plus réappliqué).
    this.enforcedByUserStmt = db.prepare(
      `SELECT * FROM sanctions WHERE guild_id = ? AND user_id = ? AND active = 1
       AND ((expires_at IS NOT NULL AND expires_at > ?) OR (type = 'mute' AND expires_at IS NULL))
       ORDER BY created_at DESC`,
    );
    this.byUserFilteredStmt = db.prepare(
      `SELECT * FROM sanctions WHERE guild_id = @guildId AND user_id = @userId AND (@type IS NULL OR type = @type)
       ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    );
    this.countFilteredStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM sanctions WHERE guild_id = @guildId AND user_id = @userId AND (@type IS NULL OR type = @type)',
    );
    this.activeByUserStmt = db.prepare(
      `SELECT * FROM sanctions WHERE guild_id = ? AND user_id = ? AND active = 1
       AND type IN ('tempban', 'ban', 'mute', 'timeout') ORDER BY created_at DESC, id DESC LIMIT 25`,
    );
    this.countByTypeStmt = db.prepare(
      'SELECT type, COUNT(*) AS n FROM sanctions WHERE guild_id = ? AND user_id = ? GROUP BY type',
    );
    this.setReasonStmt = db.prepare('UPDATE sanctions SET reason = ? WHERE id = ? AND guild_id = ?');
    this.insertEditStmt = db.prepare(
      `INSERT INTO sanction_edits (sanction_id, guild_id, editor_id, old_reason, new_reason, created_at)
       VALUES (@sanctionId, @guildId, @editorId, @oldReason, @newReason, @createdAt)`,
    );
    this.editsStmt = db.prepare(
      'SELECT * FROM sanction_edits WHERE guild_id = ? AND sanction_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    this.countEditsStmt = db.prepare('SELECT COUNT(*) AS n FROM sanction_edits WHERE guild_id = ? AND sanction_id = ?');
    this.setLogStmt = db.prepare('UPDATE sanctions SET log_channel_id = ?, log_message_id = ? WHERE id = ? AND guild_id = ?');
    this.editReasonTx = db.transaction((guildId, id, editorId, newReason) => {
      const current = this.byIdStmt.get(id, guildId);
      if (!current) return null;
      this.insertEditStmt.run({ sanctionId: id, guildId, editorId, oldReason: current.reason ?? null, newReason, createdAt: Date.now() });
      this.setReasonStmt.run(newReason, id, guildId);
      return { oldReason: current.reason ?? null, sanction: this.byIdStmt.get(id, guildId) };
    });
    this.reasonsLikeStmt = db.prepare(
      "SELECT reason FROM sanctions WHERE guild_id = ? AND user_id = ? AND reason LIKE ? ESCAPE '\\'",
    );
  }

  /**
   * @param {{guildId:string,userId:string,moderatorId:string,type:string,reason?:string,durationMs?:number|null,expiresAt?:number|null}} data
   * @returns {number} id de la sanction créée
   */
  create(data) {
    const info = this.insertStmt.run({
      guildId: data.guildId,
      userId: data.userId,
      moderatorId: data.moderatorId,
      type: data.type,
      reason: data.reason ?? null,
      durationMs: data.durationMs ?? null,
      expiresAt: data.expiresAt ?? null,
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  listByUser(guildId, userId, limit = 25) {
    return this.byUserStmt.all(guildId, userId, limit);
  }

  get(guildId, id) {
    return this.byIdStmt.get(id, guildId);
  }

  count(guildId, userId) {
    return this.countStmt.get(guildId, userId).n;
  }

  delete(guildId, id) {
    return this.deleteStmt.run(id, guildId).changes > 0;
  }

  clearUser(guildId, userId) {
    return this.clearUserStmt.run(guildId, userId).changes;
  }

  deactivate(id) {
    this.deactivateStmt.run(id);
  }

  /** Sanctions temporaires arrivées à expiration (pour le scheduler). */
  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  listActiveByType(guildId, type) {
    return this.activeByTypeStmt.all(guildId, type);
  }

  /**
   * Désactive (lève) les sanctions actives d'un type pour un membre, en gardant la trace.
   * @param {{ by?: string|null, reason?: string|null }} [revoke] auteur (null = automatique) et motif
   * @returns {number} lignes modifiées
   */
  deactivateActive(guildId, userId, type, { by = null, reason = null } = {}) {
    return this.deactivateForUserStmt.run({ guildId, userId, type, at: Date.now(), by: by ?? null, reason: reason ?? null }).changes;
  }

  /**
   * Page de l'historique d'un membre, filtrée par type (null = tous), plus récentes d'abord.
   * @param {{ type?: string|null, limit?: number, offset?: number }} [opts]
   */
  listPage(guildId, userId, { type = null, limit = 5, offset = 0 } = {}) {
    return this.byUserFilteredStmt.all({ guildId, userId, type: type ?? null, limit, offset });
  }

  /** Nombre de sanctions d'un membre, filtré par type (null = toutes). */
  countFiltered(guildId, userId, type = null) {
    return this.countFilteredStmt.get({ guildId, userId, type: type ?? null }).n;
  }

  /** Sanctions durables (ban, mute, timeout) encore marquées actives d'un membre (à filtrer avec `sanctionState`). */
  listActive(guildId, userId) {
    return this.activeByUserStmt.all(guildId, userId);
  }

  /** Nombre de sanctions par type : { warn: 2, ban: 1, … }. */
  countByType(guildId, userId) {
    return Object.fromEntries(this.countByTypeStmt.all(guildId, userId).map((r) => [r.type, r.n]));
  }

  /**
   * Modifie la raison d'une sanction en conservant l'ancienne dans `sanction_edits` (transaction).
   * @returns {{ oldReason: string|null, sanction: object }|null} null si la sanction n'existe pas sur ce serveur
   */
  editReason(guildId, id, editorId, newReason) {
    return this.editReasonTx(guildId, id, editorId, newReason);
  }

  /** Modifications de raison d'une sanction, plus récentes d'abord. */
  listEdits(guildId, sanctionId, limit = 10) {
    return this.editsStmt.all(guildId, sanctionId, limit);
  }

  countEdits(guildId, sanctionId) {
    return this.countEditsStmt.get(guildId, sanctionId).n;
  }

  /** Mémorise le message de log d'une sanction (pour le mettre à jour plus tard). */
  setLogMessage(guildId, id, channelId, messageId) {
    this.setLogStmt.run(channelId ?? null, messageId ?? null, id, guildId);
  }

  /** Sanctions encore en vigueur d'un membre (voir `isEnforced`). */
  listEnforced(guildId, userId, now = Date.now()) {
    return this.enforcedByUserStmt.all(guildId, userId, now);
  }

  /** Mute actif (sans échéance ou échéance future) d'un membre, le plus récent. */
  activeMute(guildId, userId, now = Date.now()) {
    return this.listEnforced(guildId, userId, now).find((s) => s.type === 'mute') ?? null;
  }

  /** Raisons des sanctions d'un membre commençant par `prefix` (littéral, sans joker). */
  reasonsStartingWith(guildId, userId, prefix) {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.reasonsLikeStmt.all(guildId, userId, `${escaped}%`).map((r) => r.reason);
  }
}

/**
 * true si la sanction est encore en vigueur : active avec une expiration future
 * (tempban, mute, timeout) ou mute actif sans échéance. Pur.
 */
function isEnforced(s, now = Date.now()) {
  if (!s?.active) return false;
  if (s.expires_at) return s.expires_at > now;
  return s.type === 'mute';
}

/**
 * État lisible d'une sanction. Pur.
 *  - 'active'   : en vigueur (expiration future, mute sans échéance, ban définitif non levé)
 *  - 'revoked'  : levée (par un modérateur, ou automatiquement : remplacée, débannie hors du bot)
 *  - 'expired'  : arrivée à échéance
 *  - 'done'     : sanction ponctuelle (avertissement, expulsion)
 * @returns {'active'|'revoked'|'expired'|'done'}
 */
function sanctionState(s, now = Date.now()) {
  if (!s) return 'done';
  if (s.active) {
    if (isEnforced(s, now) || (s.type === 'ban' && !s.expires_at)) return 'active';
    return s.expires_at ? 'expired' : 'done';
  }
  if (s.revoked_by || s.revoke_reason) return 'revoked';
  if (s.expires_at && s.expires_at <= (s.revoked_at ?? now)) return 'expired';
  return s.type === 'warn' || s.type === 'kick' ? 'done' : 'revoked';
}

module.exports = { SanctionRepository, isEnforced, sanctionState };
