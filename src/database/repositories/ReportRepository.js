'use strict';

/** Statuts d'un signalement. */
const REPORT_STATUSES = Object.freeze(['open', 'handled', 'dismissed']);

function parseList(raw, keep) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(keep) : [];
  } catch {
    return [];
  }
}

/** Ligne SQL → signalement (listes JSON décodées). */
function decode(row) {
  if (!row) return null;
  return {
    ...row,
    attachments: parseList(row.attachments, (a) => typeof a === 'string'),
    actions: parseList(row.actions, (a) => a && typeof a.type === 'string'),
  };
}

/**
 * Signalements de messages (menu contextuel « Signaler le message »).
 * Toutes les requêtes sont paramétrées par guildId (isolation multi-serveurs).
 * Au plus un signalement OUVERT par (signaleur, message) : index unique partiel.
 */
class ReportRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO reports (guild_id, reporter_id, target_id, channel_id, message_id, content, attachments, reason, created_at)
       VALUES (@guildId, @reporterId, @targetId, @channelId, @messageId, @content, @attachments, @reason, @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM reports WHERE guild_id = ? AND id = ?');
    this.findOpenStmt = db.prepare("SELECT * FROM reports WHERE guild_id = ? AND reporter_id = ? AND message_id = ? AND status = 'open'");
    this.setCardStmt = db.prepare('UPDATE reports SET card_channel_id = ?, card_message_id = ? WHERE guild_id = ? AND id = ?');
    this.closeStmt = db.prepare("UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE guild_id = ? AND id = ? AND status = 'open'");
    this.setActionsStmt = db.prepare('UPDATE reports SET actions = ? WHERE guild_id = ? AND id = ?');
    this.deleteStmt = db.prepare('DELETE FROM reports WHERE guild_id = ? AND id = ?');
    this.countsStmt = db.prepare('SELECT status, COUNT(*) AS n FROM reports WHERE guild_id = ? GROUP BY status');
    this.listStmt = db.prepare('SELECT * FROM reports WHERE guild_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?');
    this.addAction = db.transaction((guildId, id, action) => {
      const row = this.getStmt.get(guildId, id);
      if (!row) return null;
      const actions = [...decode(row).actions, action];
      this.setActionsStmt.run(JSON.stringify(actions), guildId, id);
      return decode({ ...row, actions: JSON.stringify(actions) });
    });
  }

  /**
   * @param {{ guildId: string, reporterId: string, targetId: string, channelId: string, messageId: string,
   *   content?: string|null, attachments?: string[], reason?: string|null, createdAt?: number }} data
   * @returns {number|null} identifiant, ou null si ce signaleur a déjà un signalement ouvert sur ce message
   */
  create(data) {
    const info = this.insertStmt.run({
      guildId: data.guildId,
      reporterId: data.reporterId,
      targetId: data.targetId,
      channelId: data.channelId,
      messageId: data.messageId,
      content: data.content ?? null,
      attachments: JSON.stringify(data.attachments ?? []),
      reason: data.reason ?? null,
      createdAt: data.createdAt ?? Date.now(),
    });
    return info.changes ? Number(info.lastInsertRowid) : null;
  }

  get(guildId, id) {
    return decode(this.getStmt.get(guildId, id));
  }

  /** Signalement ouvert de ce signaleur sur ce message, ou null. */
  findOpen(guildId, reporterId, messageId) {
    return decode(this.findOpenStmt.get(guildId, reporterId, messageId));
  }

  /** Mémorise la carte publiée dans le salon du staff. */
  setCard(guildId, id, channelId, messageId) {
    return this.setCardStmt.run(channelId, messageId, guildId, id).changes > 0;
  }

  /**
   * Clôt un signalement encore ouvert (une seule fois, même en cas de double clic).
   * @param {'handled'|'dismissed'} status
   * @returns {boolean} false s'il était déjà clos
   */
  close(guildId, id, status, by, at = Date.now()) {
    if (status !== 'handled' && status !== 'dismissed') throw new Error(`Statut de signalement invalide : ${status}`);
    return this.closeStmt.run(status, by, at, guildId, id).changes > 0;
  }

  /**
   * Ajoute une action du staff (suppression, avertissement, timeout) à l'historique.
   * @param {{ type: string, by: string, at?: number, note?: string }} action
   * @returns {object|null} signalement mis à jour
   */
  recordAction(guildId, id, action) {
    return this.addAction(guildId, id, { at: Date.now(), ...action });
  }

  /** Supprime un signalement (carte impossible à publier). */
  delete(guildId, id) {
    return this.deleteStmt.run(guildId, id).changes > 0;
  }

  /** @returns {{ open: number, handled: number, dismissed: number, total: number }} */
  counts(guildId) {
    const out = { open: 0, handled: 0, dismissed: 0, total: 0 };
    for (const { status, n } of this.countsStmt.all(guildId)) {
      if (status in out) out[status] = n;
      out.total += n;
    }
    return out;
  }

  /** Signalements d'un statut, du plus récent au plus ancien. */
  list(guildId, status = 'open', limit = 10, offset = 0) {
    return this.listStmt.all(guildId, status, limit, offset).map(decode);
  }
}

module.exports = { ReportRepository, REPORT_STATUSES };
