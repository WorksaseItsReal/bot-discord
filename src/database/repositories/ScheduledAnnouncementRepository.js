'use strict';

/**
 * Annonces programmées (/annonce). Cycle de vie : `draft` (aperçu en attente de
 * confirmation) → `scheduled` → `done` (envoi unique effectué) ou `disabled`
 * (salon supprimé, permission manquante…). Pendant une publication, la ligne passe
 * `scheduled` → `sending` (réservation atomique) : un double clic sur « Envoyer
 * maintenant » ou le scheduler au même instant ne publient jamais deux fois.
 */
class ScheduledAnnouncementRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      `INSERT INTO scheduled_announcements
         (guild_id, channel_id, author_id, role_id, repeat, time_zone, anchor_at, next_run, status, created_at)
       VALUES (@guildId, @channelId, @authorId, @roleId, @repeat, @timeZone, @runAt, @runAt, 'draft', @createdAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM scheduled_announcements WHERE id = ? AND guild_id = ?');
    this.byIdStmt = db.prepare('SELECT * FROM scheduled_announcements WHERE id = ?');
    this.contentStmt = db.prepare(
      `UPDATE scheduled_announcements SET title = @title, message = @message, color = @color, image = @image
       WHERE id = @id AND guild_id = @guildId AND status = 'draft'`,
    );
    this.scheduleStmt = db.prepare("UPDATE scheduled_announcements SET status = 'scheduled', anchor_at = ?, next_run = ?, runs = ? WHERE id = ? AND guild_id = ? AND status = 'draft'");
    // « sending » (publication en cours) s'affiche et se compte comme « scheduled ».
    this.listStmt = db.prepare(
      `SELECT * FROM scheduled_announcements WHERE guild_id = ? AND status IN ('scheduled', 'sending', 'disabled')
       ORDER BY CASE status WHEN 'disabled' THEN 1 ELSE 0 END, next_run ASC LIMIT ? OFFSET ?`,
    );
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM scheduled_announcements WHERE guild_id = ? AND status IN ('scheduled', 'sending', 'disabled')");
    this.countScheduledStmt = db.prepare("SELECT COUNT(*) AS n FROM scheduled_announcements WHERE guild_id = ? AND status IN ('scheduled', 'sending')");
    this.reserveStmt = db.prepare("UPDATE scheduled_announcements SET status = 'sending' WHERE id = ? AND status = 'scheduled'");
    this.releaseStmt = db.prepare("UPDATE scheduled_announcements SET status = 'scheduled' WHERE id = ? AND status = 'sending'");
    this.resetSendingStmt = db.prepare("UPDATE scheduled_announcements SET status = 'scheduled' WHERE status = 'sending'");
    this.dueStmt = db.prepare("SELECT * FROM scheduled_announcements WHERE status = 'scheduled' AND next_run <= ? ORDER BY next_run ASC LIMIT 100");
    this.sentStmt = db.prepare(
      `UPDATE scheduled_announcements SET sent_count = sent_count + 1, last_sent_at = @now, last_error = NULL,
         status = @status, next_run = @nextRun, runs = @runs
       WHERE id = @id AND status = 'sending'`,
    );
    this.skipStmt = db.prepare("UPDATE scheduled_announcements SET next_run = @nextRun, runs = @runs, last_error = @error WHERE id = @id AND status IN ('scheduled', 'sending')");
    this.sentNowStmt = db.prepare(
      `UPDATE scheduled_announcements SET sent_count = sent_count + 1, last_sent_at = ?, last_error = NULL,
         status = CASE WHEN repeat = 'none' THEN 'done' ELSE 'scheduled' END
       WHERE id = ? AND status = 'sending'`,
    );
    this.disableStmt = db.prepare("UPDATE scheduled_announcements SET status = 'disabled', last_error = ? WHERE id = ? AND status IN ('scheduled', 'sending')");
    this.errorStmt = db.prepare('UPDATE scheduled_announcements SET last_error = ? WHERE id = ?');
    this.deleteStmt = db.prepare('DELETE FROM scheduled_announcements WHERE id = ? AND guild_id = ?');
    this.purgeDraftsStmt = db.prepare("DELETE FROM scheduled_announcements WHERE status = 'draft' AND created_at < ?");
  }

  /** Crée un brouillon (contenu rempli ensuite par le formulaire). @returns {number} */
  createDraft({ guildId, channelId, authorId, roleId = null, repeat = 'none', timeZone, runAt, now = Date.now() }) {
    const info = this.insertStmt.run({ guildId, channelId, authorId, roleId, repeat, timeZone, runAt, createdAt: now });
    return Number(info.lastInsertRowid);
  }

  get(guildId, id) {
    return this.getStmt.get(id, guildId) ?? null;
  }

  byId(id) {
    return this.byIdStmt.get(id) ?? null;
  }

  /** Contenu d'un brouillon. @returns {boolean} */
  setContent(guildId, id, { title = null, message = null, color = null, image = null }) {
    return this.contentStmt.run({ id, guildId, title, message, color, image }).changes > 0;
  }

  /**
   * Brouillon → programmée. Par défaut, l'échéance est aussi l'ancre des répétitions ;
   * `anchorAt`/`runs` gardent l'ancre d'origine (aperçu confirmé après l'échéance).
   * @returns {boolean}
   */
  schedule(guildId, id, runAt, { anchorAt = runAt, runs = 0 } = {}) {
    return this.scheduleStmt.run(anchorAt, runAt, runs, id, guildId).changes > 0;
  }

  /** Réserve une annonce programmée pour la publier (atomique). @returns {boolean} */
  reserve(id) {
    return this.reserveStmt.run(id).changes > 0;
  }

  /** Annule une réservation (publication échouée) : la ligne redevient programmée. */
  release(id) {
    return this.releaseStmt.run(id).changes > 0;
  }

  /** Démarrage : réservations laissées par un arrêt brutal pendant un envoi → programmées. @returns {number} */
  resetSending() {
    return this.resetSendingStmt.run().changes;
  }

  /** Occurrence sautée (trop de retard) : échéance suivante, sans compter d'envoi. @returns {boolean} */
  skipTo(id, { nextRun, runs, error = null }) {
    return this.skipStmt.run({ id, nextRun, runs, error: error ? String(error).slice(0, 300) : null }).changes > 0;
  }

  /** Annonces visibles dans /annonce liste (programmées puis désactivées). */
  list(guildId, { limit = 10, offset = 0 } = {}) {
    return this.listStmt.all(guildId, limit, offset);
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  countScheduled(guildId) {
    return this.countScheduledStmt.get(guildId).n;
  }

  findDue(now = Date.now()) {
    return this.dueStmt.all(now);
  }

  /** Envoi d'échéance réussi (ligne réservée) : prochaine occurrence, ou `done`. @returns {boolean} */
  markSent(id, { now = Date.now(), nextRun = null, runs }) {
    return this.sentStmt.run({ id, now, status: nextRun ? 'scheduled' : 'done', nextRun: nextRun ?? now, runs }).changes > 0;
  }

  /** Envoi manuel réussi (ligne réservée) : l'échéancier ne change pas, sauf envoi unique → `done`. */
  markSentNow(id, now = Date.now()) {
    return this.sentNowStmt.run(now, id).changes > 0;
  }

  /** @returns {boolean} */
  disable(id, error) {
    return this.disableStmt.run(String(error ?? '').slice(0, 300), id).changes > 0;
  }

  setError(id, error) {
    this.errorStmt.run(String(error ?? '').slice(0, 300), id);
  }

  /** @returns {boolean} */
  delete(guildId, id) {
    return this.deleteStmt.run(id, guildId).changes > 0;
  }

  /** Supprime les brouillons abandonnés (aperçu jamais confirmé). @returns {number} */
  purgeDrafts(before) {
    return this.purgeDraftsStmt.run(before).changes;
  }
}

module.exports = { ScheduledAnnouncementRepository };
