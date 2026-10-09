'use strict';

/**
 * Tickets fermés et leur note (table ticket_ratings, migration 23). Une ligne par ticket
 * fermé (instantané conservé pour les statistiques, la ligne `tickets` étant supprimée) ;
 * la note (1 à 5) n'est acceptée qu'une fois, et seulement de l'auteur du ticket.
 */
class TicketRatingRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO ticket_ratings (ticket_id, guild_id, user_id, claimed_by, closed_by, opened_at, claimed_at, closed_at)
       VALUES (@ticketId, @guildId, @userId, @claimedBy, @closedBy, @openedAt, @claimedAt, @closedAt)`,
    );
    this.getStmt = db.prepare('SELECT * FROM ticket_ratings WHERE ticket_id = ?');
    this.rateStmt = db.prepare('UPDATE ticket_ratings SET rating = ?, rated_at = ? WHERE ticket_id = ? AND user_id = ? AND rating IS NULL');
    this.commentStmt = db.prepare(
      'UPDATE ticket_ratings SET comment = ? WHERE ticket_id = ? AND user_id = ? AND rating IS NOT NULL AND comment IS NULL',
    );
    this.summaryStmt = db.prepare(
      `SELECT COUNT(*) AS closed,
              COUNT(rating) AS rated,
              AVG(rating) AS avg_rating,
              AVG(CASE WHEN claimed_at IS NOT NULL AND opened_at IS NOT NULL AND claimed_at >= opened_at THEN claimed_at - opened_at END) AS avg_claim_ms,
              COUNT(CASE WHEN claimed_at IS NOT NULL AND opened_at IS NOT NULL AND claimed_at >= opened_at THEN 1 END) AS claim_samples,
              AVG(CASE WHEN opened_at IS NOT NULL AND closed_at >= opened_at THEN closed_at - opened_at END) AS avg_close_ms,
              COUNT(CASE WHEN opened_at IS NOT NULL AND closed_at >= opened_at THEN 1 END) AS close_samples
         FROM ticket_ratings WHERE guild_id = ? AND closed_at >= ?`,
    );
    this.byStaffStmt = db.prepare(
      `SELECT claimed_by AS staff_id,
              COUNT(*) AS tickets,
              COUNT(rating) AS rated,
              AVG(rating) AS avg_rating,
              AVG(CASE WHEN claimed_at IS NOT NULL AND opened_at IS NOT NULL AND claimed_at >= opened_at THEN claimed_at - opened_at END) AS avg_claim_ms
         FROM ticket_ratings WHERE guild_id = ? AND closed_at >= ? AND claimed_by IS NOT NULL
        GROUP BY claimed_by
        ORDER BY tickets DESC, avg_rating DESC, claimed_by ASC
        LIMIT ?`,
    );
    this.distributionStmt = db.prepare('SELECT rating, COUNT(*) AS n FROM ticket_ratings WHERE guild_id = ? AND closed_at >= ? AND rating IS NOT NULL GROUP BY rating');
    this.commentsStmt = db.prepare(
      'SELECT * FROM ticket_ratings WHERE guild_id = ? AND comment IS NOT NULL ORDER BY rated_at DESC, ticket_id DESC LIMIT ?',
    );
  }

  /**
   * Mémorise un ticket fermé (sans note). Sans effet s'il l'est déjà.
   * @returns {boolean} une ligne a été créée
   */
  recordClosure({ ticketId, guildId, userId, claimedBy = null, closedBy = null, openedAt = null, claimedAt = null, closedAt = Date.now() }) {
    return this.insertStmt.run({ ticketId, guildId, userId, claimedBy, closedBy, openedAt, claimedAt, closedAt }).changes > 0;
  }

  get(ticketId) {
    return this.getStmt.get(ticketId) ?? null;
  }

  /** Note atomique (une seule fois, auteur seulement). @returns {boolean} */
  rate(ticketId, userId, rating, at = Date.now()) {
    return this.rateStmt.run(rating, at, ticketId, userId).changes > 0;
  }

  /** Commentaire (une seule fois, après la note, auteur seulement). @returns {boolean} */
  comment(ticketId, userId, text) {
    return this.commentStmt.run(text, ticketId, userId).changes > 0;
  }

  /** Statistiques globales des tickets fermés depuis `since`. */
  summary(guildId, since = 0) {
    const r = this.summaryStmt.get(guildId, since);
    return {
      closed: r.closed ?? 0,
      rated: r.rated ?? 0,
      avgRating: r.avg_rating ?? null,
      avgClaimMs: r.claim_samples ? r.avg_claim_ms : null,
      avgCloseMs: r.close_samples ? r.avg_close_ms : null,
    };
  }

  /** Par membre du staff ayant pris en charge : tickets, notes, délai moyen de prise en charge. */
  byStaff(guildId, since = 0, limit = 10) {
    return this.byStaffStmt.all(guildId, since, limit).map((r) => ({
      staffId: r.staff_id,
      tickets: r.tickets,
      rated: r.rated,
      avgRating: r.avg_rating ?? null,
      avgClaimMs: r.avg_claim_ms ?? null,
    }));
  }

  /** Répartition des notes : [n(1), n(2), n(3), n(4), n(5)]. */
  distribution(guildId, since = 0) {
    const out = [0, 0, 0, 0, 0];
    for (const r of this.distributionStmt.all(guildId, since)) if (r.rating >= 1 && r.rating <= 5) out[r.rating - 1] = r.n;
    return out;
  }

  /** Derniers commentaires laissés. */
  recentComments(guildId, limit = 3) {
    return this.commentsStmt.all(guildId, limit);
  }
}

module.exports = { TicketRatingRepository };
