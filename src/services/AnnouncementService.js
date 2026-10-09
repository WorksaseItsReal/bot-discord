'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { card, fitEmbeds, field, wide, ICONS, code } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { nextAfter, REPEATS, DAY_MS } = require('../utils/calendar');
const { logCard } = require('./LoggingService');

const logger = createLogger('announcements');

/** Types de salons où une annonce peut être publiée. */
const ANNOUNCE_CHANNEL_TYPES = Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
/** Permissions nécessaires au bot dans le salon d'une annonce. */
const SEND_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
/** Erreurs définitives d'envoi : salon supprimé, accès ou permission retirés, contenu refusé. */
const PERMANENT_CODES = new Set([10003, 10004, 50001, 50013, 50035, 50083]);
/** Brouillon (aperçu jamais confirmé) supprimé après ce délai. */
const DRAFT_TTL_MS = DAY_MS;
/** Un envoi unique bloqué par des erreurs transitoires est abandonné 24 h après l'échéance. */
const MAX_LATE_MS = DAY_MS;
/** Membre ou utilisateur inconnu : l'auteur a quitté le serveur. */
const GONE_CODES = new Set([10007, 10013]);

/** Mention d'une annonce : contenu et `allowedMentions` explicites. Pur. */
function mentionOf(row) {
  if (!row.role_id) return { content: undefined, allowedMentions: { parse: [] } };
  if (row.role_id === row.guild_id) return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
  return { content: `<@&${row.role_id}>`, allowedMentions: { parse: [], roles: [row.role_id] } };
}

/** Carte publiée (titre facultatif, message, couleur, image). Pur. */
function announcementCard(row) {
  return card({
    tone: Number.isInteger(row.color) ? row.color : 'brand',
    icon: row.title ? '📢' : undefined,
    title: row.title ? truncate(row.title, 250) : undefined,
    description: row.message || '​',
    image: row.image || null,
  });
}

/** Message complet d'une annonce. Pur. */
function announcementPayload(row) {
  const { content, allowedMentions } = mentionOf(row);
  return { ...(content ? { content } : {}), embeds: fitEmbeds([announcementCard(row)]), allowedMentions };
}

/**
 * Le rôle peut-il être mentionné par cet auteur ? @everyone, ou un rôle non
 * mentionnable, exigent la permission « Mentionner @everyone » de l'auteur. Lève une UserError.
 */
function assertMentionAllowed(guild, roleId, authorPermissions) {
  if (!roleId) return;
  const canEveryone = Boolean(authorPermissions?.has?.(PermissionFlagsBits.MentionEveryone));
  if (roleId === guild.id) {
    if (!canEveryone) throw new UserError('Mentionner **@everyone** demande la permission **Mentionner @everyone, @here et tous les rôles**.');
    return;
  }
  const role = guild.roles?.cache?.get(roleId);
  if (!role) throw new UserError('Ce rôle n\'existe plus.');
  if (role.managed) throw new UserError(`Le rôle ${role.name} est géré par une intégration : choisissez un autre rôle à mentionner.`);
  if (!role.mentionable && !canEveryone) throw new UserError(`Le rôle ${role.name} n'est pas mentionnable : il faut la permission **Mentionner @everyone, @here et tous les rôles**.`);
}

/** Pourquoi le bot ne peut pas publier dans ce salon (texte), ou null. Pur. */
function channelIssue(guild, channelId) {
  const channel = guild?.channels?.cache?.get(channelId);
  if (!channel) return 'le salon a été supprimé';
  if (!ANNOUNCE_CHANNEL_TYPES.includes(channel.type)) return 'le salon n\'est plus un salon textuel';
  const me = guild.members?.me;
  const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
  if (perms && !perms.has(SEND_PERMISSIONS)) return 'il me manque **Voir le salon**, **Envoyer des messages** ou **Intégrer des liens**';
  return null;
}

/**
 * Annonces programmées : publication à l'échéance (étape du SchedulerService),
 * répétitions, envoi manuel, désactivation si le salon devient inutilisable.
 * Chaque publication réserve la ligne (`scheduled` → `sending`) avant l'envoi : un double
 * clic ou le scheduler au même instant ne publient jamais deux fois (deux @everyone).
 */
class AnnouncementService {
  /**
   * @param {{ client: import('discord.js').Client, announcements: import('../database/repositories/ScheduledAnnouncementRepository').ScheduledAnnouncementRepository }} deps
   */
  constructor({ client, announcements }) {
    this.client = client;
    this.repo = announcements;
    // Arrêt brutal pendant un envoi : la réservation est rendue (au pire un envoi en double,
    // jamais une annonce bloquée à vie).
    const reset = announcements?.resetSending?.() ?? 0;
    if (reset) logger.warn(`${reset} annonce(s) interrompue(s) pendant leur envoi : reprogrammée(s).`);
  }

  /**
   * L'auteur peut-il TOUJOURS mentionner ce rôle (@everyone ou rôle non mentionnable) ?
   * Revérifié à chaque publication programmée : un auteur rétrogradé ou parti ne pingue plus.
   * @returns {Promise<string|null>} raison du refus (définitif), ou null
   */
  async #authorMentionIssue(guild, row) {
    if (!row.role_id) return null;
    const everyone = row.role_id === guild.id;
    const role = everyone ? null : guild.roles?.cache?.get(row.role_id);
    // Rôle mentionnable : aucune permission requise. Rôle supprimé : la mention ne notifie plus personne.
    if (!everyone && (!role || role.mentionable)) return null;
    let member = guild.members?.cache?.get(row.author_id);
    if (!member) {
      try {
        member = await guild.members.fetch(row.author_id);
      } catch (e) {
        if (GONE_CODES.has(e?.code)) return 'son auteur a quitté le serveur (mention non autorisée)';
        throw e; // erreur passagère : réessai
      }
    }
    if (member.permissions?.has?.(PermissionFlagsBits.MentionEveryone)) return null;
    return everyone
      ? 'son auteur n\'a plus la permission de mentionner @everyone'
      : 'son auteur n\'a plus la permission de mentionner ce rôle (non mentionnable)';
  }

  /**
   * Publie une annonce. @returns {Promise<{ ok: true } | { ok: false, permanent: boolean, reason: string }>}
   */
  async publish(guild, row) {
    const issue = channelIssue(guild, row.channel_id);
    if (issue) return { ok: false, permanent: true, reason: issue };
    const channel = guild.channels.cache.get(row.channel_id);
    try {
      await channel.send(announcementPayload(row));
      return { ok: true };
    } catch (e) {
      return { ok: false, permanent: PERMANENT_CODES.has(e?.code), reason: e?.code ? `erreur Discord ${e.code}` : (e?.message ?? 'erreur inconnue') };
    }
  }

  /**
   * « Envoyer maintenant » : publie sans toucher à l'échéancier (une annonce unique est terminée).
   * Lève une UserError si la publication échoue (et désactive l'annonce si c'est définitif).
   */
  async sendNow(guild, id, by) {
    const row = this.repo.get(guild.id, id);
    if (row?.status === 'sending') throw new UserError('Cette annonce est déjà en cours de publication.');
    if (!row || row.status !== 'scheduled') throw new UserError('Cette annonce n\'est plus programmée.');
    // Réservation atomique : le second clic (ou le scheduler) trouve la ligne déjà prise.
    if (!this.repo.reserve(row.id)) throw new UserError('Cette annonce est déjà en cours de publication.');
    let result;
    try {
      result = await this.publish(guild, row);
    } catch (e) {
      this.repo.release(row.id);
      throw e;
    }
    if (!result.ok) {
      this.repo.release(row.id);
      if (result.permanent) await this.#disable(guild, row, result.reason);
      throw new UserError(`Annonce non publiée : ${result.reason}.${result.permanent ? ' Elle a été désactivée.' : ''}`);
    }
    this.repo.markSentNow(row.id);
    logger.info(`Annonce #${row.id} publiée manuellement par ${by?.id ?? '?'} (serveur ${guild.id}).`);
    return this.repo.get(guild.id, id);
  }

  /**
   * Étape du scheduler : brouillons abandonnés purgés, annonces échues publiées.
   * Chaque ligne est relue avant l'envoi (supprimée ou envoyée entre-temps → ignorée).
   * @param {{ isStopping?: () => boolean, now?: number }} [opts]
   */
  async processDue({ isStopping = () => false, now = Date.now() } = {}) {
    const purged = this.repo.purgeDrafts(now - DRAFT_TTL_MS);
    if (purged) logger.debug(`${purged} brouillon(s) d'annonce abandonné(s) supprimé(s).`);
    for (const row of this.repo.findDue(now)) {
      if (isStopping()) return;
      try {
        await this.#runDue(row);
      } catch (e) {
        logger.warn(`Annonce #${row.id} (serveur ${row.guild_id}) en échec, réessai :`, e?.message ?? e);
      }
    }
  }

  async #runDue(row) {
    const guild = this.client.guilds.cache.get(row.guild_id);
    if (!guild) {
      if (this.client.isReady?.()) this.repo.disable(row.id, 'serveur quitté');
      return;
    }
    if (!guild.available) return;
    const fresh = this.repo.byId(row.id);
    if (fresh?.status !== 'scheduled' || fresh.next_run > Date.now()) return;
    // Occurrence suivante calculée AVANT l'envoi : si le calcul échoue, rien n'est publié
    // (sinon l'annonce, jamais marquée envoyée, repartirait à chaque tick).
    const next = nextAfter(fresh.anchor_at, fresh.repeat, fresh.time_zone, fresh.runs, Date.now());
    const mentionIssue = await this.#authorMentionIssue(guild, fresh);
    if (mentionIssue) return this.#disable(guild, fresh, mentionIssue);
    if (!this.repo.reserve(fresh.id)) return; // « Envoyer maintenant » en cours
    let result;
    try {
      result = await this.publish(guild, fresh);
    } catch (e) {
      this.repo.release(fresh.id);
      throw e;
    }
    const now = Date.now();
    if (result.ok) {
      // Envoi plus long que prévu : l'occurrence suivante doit rester dans le futur.
      const upcoming = next && next.at <= now ? nextAfter(fresh.anchor_at, fresh.repeat, fresh.time_zone, next.runs, now) : next;
      this.repo.markSent(fresh.id, { now, nextRun: upcoming?.at ?? null, runs: upcoming?.runs ?? fresh.runs + 1 });
      logger.info(`Annonce #${fresh.id} publiée (serveur ${guild.id})${upcoming ? `, prochaine ${new Date(upcoming.at).toISOString()}` : ''}.`);
      return;
    }
    this.repo.release(fresh.id);
    if (result.permanent) return this.#disable(guild, fresh, result.reason);
    this.repo.setError(fresh.id, result.reason);
    if (now - fresh.next_run <= MAX_LATE_MS) return undefined;
    // Trop de retard : une annonce unique est abandonnée, une répétition passe à l'occurrence suivante.
    if (!next) return this.#disable(guild, fresh, `non publiée 24 h après l'échéance (${result.reason})`);
    this.repo.skipTo(fresh.id, { nextRun: next.at, runs: next.runs, error: result.reason });
    return undefined;
  }

  async #disable(guild, row, reason) {
    if (!this.repo.disable(row.id, reason)) return;
    logger.warn(`Annonce #${row.id} désactivée (serveur ${guild.id}) : ${reason.replace(/\*/g, '')}`);
    const logging = this.client.services?.logging;
    if (!logging) return;
    const embed = logCard({
      category: 'server',
      tone: 'warning',
      icon: ICONS.warning,
      title: 'Annonce programmée désactivée',
      description: `L'annonce ${code(`#${row.id}`)} n'a pas pu être publiée dans <#${row.channel_id}> : ${reason}. Elle est désactivée ; supprimez-la ou recréez-la avec \`/annonce programmer\`.`,
      id: String(row.id),
      fields: [
        field(ICONS.channel, 'Salon', `<#${row.channel_id}>`),
        field(ICONS.user, 'Auteur', `<@${row.author_id}>`),
        field(ICONS.date, 'Échéance', discordTimestamp(row.next_run, 'f')),
        row.title ? wide('📢', 'Titre', truncate(row.title, 200)) : null,
      ],
    });
    await logging.send(guild.id, 'server', embed).catch(() => {});
  }
}

module.exports = {
  AnnouncementService,
  ANNOUNCE_CHANNEL_TYPES,
  SEND_PERMISSIONS,
  REPEATS,
  DRAFT_TTL_MS,
  mentionOf,
  announcementCard,
  announcementPayload,
  assertMentionAllowed,
  channelIssue,
};
