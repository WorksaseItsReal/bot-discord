'use strict';

const { truncate } = require('../utils/embeds');
const { card, field, wide, ICONS, subtext, code, actionButton, buttonRows, ButtonStyle, fitEmbeds } = require('../utils/ui');
const { discordTimestamp, formatDuration } = require('../utils/time');
const { logCard } = require('./LoggingService');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const logger = createLogger('ticket-ratings');

/** Longueur maximale d'un commentaire de notation. */
const MAX_COMMENT = 500;
const STAR = '⭐';

/** « ⭐⭐⭐☆☆ » pour une note entière de 1 à 5. Pur. */
function starBar(rating) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return `${STAR.repeat(n)}${'☆'.repeat(5 - n)}`;
}

/** Note moyenne lisible (« 4,3 / 5 ») ou null. Pur. */
function formatAverage(avg) {
  if (avg == null || !Number.isFinite(Number(avg))) return null;
  return `${Number(avg).toFixed(1).replace('.', ',')} / 5`;
}

/** Durée moyenne lisible (minutes arrondies), ou « — ». Pur. */
function formatAvgDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  if (ms < 60_000) return '< 1m';
  return formatDuration(Math.round(ms / 60_000) * 60_000);
}

/** Note valide (1 à 5), sinon UserError. Pur. */
function parseStars(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new UserError('Ce bouton est invalide.');
  return n;
}

/** Identifiant de ticket valide, sinon UserError. Pur. */
function parseTicketId(raw) {
  if (!/^\d{1,12}$/.test(String(raw ?? ''))) throw new UserError('Ce bouton est invalide.');
  return Number(raw);
}

/**
 * Notation des tickets : à la fermeture, l'instantané du ticket est conservé (statistiques)
 * et son auteur reçoit en MP cinq boutons ⭐ (routés vers /tickets, utilisables hors serveur),
 * puis un commentaire facultatif. Désactivable par serveur : `tickets.ratings`.
 */
class TicketRatingService {
  /**
   * @param {{ client: import('discord.js').Client, ratings: import('../database/repositories/TicketRatingRepository').TicketRatingRepository,
   *   config: import('./ConfigService').ConfigService, logging: import('./LoggingService').LoggingService }} deps
   */
  constructor({ client, ratings, config, logging }) {
    this.client = client;
    this.ratings = ratings;
    this.config = config;
    this.logging = logging;
    /** MP de notation en cours d'envoi (attendus par flush()). */
    this.pending = new Set();
    /** Arrêt en cours : plus aucun nouveau MP. */
    this.stopping = false;
  }

  enabled(guildId) {
    return this.config.get(guildId).tickets?.ratings !== false;
  }

  /**
   * Fermeture d'un ticket (appelé par TicketService) : mémorise l'instantané puis envoie,
   * sans l'attendre, le MP de notation à l'auteur. Ne lève jamais.
   * @param {{ guild: import('discord.js').Guild, ticket: object, closedBy?: { id: string }|null, closedAt?: number }} info
   */
  onClosed({ guild, ticket, closedBy = null, closedAt = Date.now() }) {
    if (!guild?.id || !ticket?.id || !ticket.user_id) return;
    try {
      this.ratings.recordClosure({
        ticketId: ticket.id,
        guildId: guild.id,
        userId: ticket.user_id,
        claimedBy: ticket.claimed_by ?? null,
        closedBy: closedBy?.id ?? null,
        openedAt: ticket.created_at ?? null,
        claimedAt: ticket.claimed_at ?? null,
        closedAt,
      });
    } catch (err) {
      logger.warn(`Ticket #${ticket.id} : instantané non enregistré :`, err?.message ?? err);
      return;
    }
    if (this.stopping || !this.enabled(guild.id)) return;
    const job = this.#prompt(guild, ticket)
      .catch((err) => logger.debug(`MP de notation du ticket #${ticket.id} non envoyé :`, err?.message ?? err))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  async #prompt(guild, ticket) {
    const user = await this.client.users.fetch(ticket.user_id).catch(() => null);
    if (!user || user.bot) return;
    const payload = this.promptPayload(guild, this.ratings.get(ticket.id) ?? { ticket_id: ticket.id, claimed_by: ticket.claimed_by });
    await user.send({ ...payload, embeds: fitEmbeds(payload.embeds) });
  }

  /** Arrêt : plus de nouveaux MP, envois en cours attendus. */
  async flush() {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
  }

  /** MP de notation (cinq boutons ⭐). */
  promptPayload(guild, row) {
    return {
      embeds: [
        card({
          tone: 'brand',
          section: 'tickets',
          icon: STAR,
          title: 'Comment s\'est passé votre ticket ?',
          description: [
            `Votre ticket ${code(`#${row.ticket_id}`)} sur **${truncate(guild?.name ?? 'le serveur', 100)}** est fermé.`,
            'Notez l\'aide reçue de **1** (décevante) à **5** (excellente) : votre avis aide l\'équipe à s\'améliorer.',
            subtext('Une seule note par ticket. Vous pourrez ajouter un commentaire ensuite.'),
          ],
          fields: [row.claimed_by ? field(ICONS.moderator, 'Pris en charge par', `<@${row.claimed_by}>`) : null],
          footer: `Ticket #${row.ticket_id}`,
        }),
      ],
      components: buttonRows(
        [1, 2, 3, 4, 5].map((n) => actionButton({ command: 'tickets', action: 'rate', args: [row.ticket_id, n], label: String(n), emoji: STAR, style: n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary })),
      ),
    };
  }

  /** Remerciement après la note (bouton de commentaire tant qu'il n'y en a pas). */
  thanksPayload(row) {
    const commented = Boolean(row.comment);
    return {
      embeds: [
        card({
          tone: 'success',
          section: 'tickets',
          icon: ICONS.success,
          title: 'Merci pour votre avis !',
          description: [
            `Votre note pour le ticket ${code(`#${row.ticket_id}`)} : **${starBar(row.rating)}** (${row.rating}/5).`,
            commented ? null : subtext('Vous pouvez préciser votre avis avec un commentaire (facultatif).'),
          ],
          fields: [commented ? wide('💬', 'Votre commentaire', truncate(row.comment, 1000)) : null],
          footer: `Ticket #${row.ticket_id}`,
        }),
      ],
      components: commented
        ? []
        : buttonRows(actionButton({ command: 'tickets', action: 'ratecomment', args: [row.ticket_id], label: 'Ajouter un commentaire', emoji: '💬', style: ButtonStyle.Primary })),
    };
  }

  /** Ligne d'un ticket que `userId` peut noter, ou UserError. */
  ownRow(ticketId, userId) {
    const row = this.ratings.get(ticketId);
    if (!row) throw new UserError('Ce ticket est introuvable : il ne peut plus être noté.');
    if (row.user_id !== userId) throw new UserError('Seul l\'auteur du ticket peut le noter.');
    return row;
  }

  /**
   * Note un ticket (une fois, auteur seulement ; vérifié en base).
   * @returns {object} ligne à jour
   */
  rate(ticketId, userId, stars) {
    const row = this.ownRow(ticketId, userId);
    if (row.rating != null || !this.ratings.rate(ticketId, userId, stars)) {
      throw new UserError(`Vous avez déjà noté ce ticket (${starBar(this.ratings.get(ticketId)?.rating ?? row.rating)}).`);
    }
    return this.ratings.get(ticketId);
  }

  /** Commentaire facultatif (une fois, après la note). @returns {object} ligne à jour */
  comment(ticketId, userId, text) {
    const row = this.ownRow(ticketId, userId);
    if (row.rating == null) throw new UserError('Notez d\'abord le ticket avec les étoiles.');
    const clean = String(text ?? '').trim();
    if (!clean) throw new UserError('Le commentaire est vide.');
    if (clean.length > MAX_COMMENT) throw new UserError(`Le commentaire est limité à ${MAX_COMMENT} caractères.`);
    if (row.comment != null || !this.ratings.comment(ticketId, userId, clean)) throw new UserError('Vous avez déjà commenté ce ticket.');
    return this.ratings.get(ticketId);
  }

  /** Journal (Modération · « Notes des tickets »). Ne lève jamais. */
  async log(row, { comment = false } = {}) {
    try {
      await this.logging.send(
        row.guild_id,
        'moderation',
        logCard({
          category: 'moderation',
          tone: row.rating >= 4 ? 'success' : row.rating <= 2 ? 'warning' : 'info',
          icon: STAR,
          title: comment ? `Commentaire sur le ticket #${row.ticket_id}` : `Ticket #${row.ticket_id} noté ${row.rating}/5`,
          description: `<@${row.user_id}> a ${comment ? 'commenté' : 'noté'} son ticket : **${starBar(row.rating)}**.`,
          fields: [
            field(ICONS.user, 'Auteur', `<@${row.user_id}>`),
            field(ICONS.moderator, 'Pris en charge par', row.claimed_by ? `<@${row.claimed_by}>` : '*Personne*'),
            field(ICONS.date, 'Fermé', discordTimestamp(row.closed_at, 'R')),
            comment && row.comment ? wide('💬', 'Commentaire', truncate(row.comment, 1000)) : null,
          ],
          id: row.user_id,
        }),
        undefined,
        { event: 'ticketRating' },
      );
    } catch (err) {
      logger.debug('Journal de notation :', err?.message ?? err);
    }
  }

  /** Statistiques (vue « Statistiques » de /tickets). */
  stats(guildId, since = 0) {
    return {
      summary: this.ratings.summary(guildId, since),
      staff: this.ratings.byStaff(guildId, since, 10),
      distribution: this.ratings.distribution(guildId, since),
      comments: this.ratings.recentComments(guildId, 3),
    };
  }
}

module.exports = { TicketRatingService, starBar, formatAverage, formatAvgDuration, parseStars, parseTicketId, MAX_COMMENT };
