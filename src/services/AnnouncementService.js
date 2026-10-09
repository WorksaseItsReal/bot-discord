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
 */
class AnnouncementService {
  /**
   * @param {{ client: import('discord.js').Client, announcements: import('../database/repositories/ScheduledAnnouncementRepository').ScheduledAnnouncementRepository }} deps
   */
  constructor({ client, announcements }) {
    this.client = client;
    this.repo = announcements;
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
    if (!row || row.status !== 'scheduled') throw new UserError('Cette annonce n\'est plus programmée.');
    const result = await this.publish(guild, row);
    if (!result.ok) {
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
    const result = await this.publish(guild, fresh);
    const now = Date.now();
    if (result.ok) {
      const next = nextAfter(fresh.anchor_at, fresh.repeat, fresh.time_zone, fresh.runs, now);
      this.repo.markSent(fresh.id, { now, nextRun: next?.at ?? null, runs: next?.runs ?? fresh.runs + 1 });
      logger.info(`Annonce #${fresh.id} publiée (serveur ${guild.id})${next ? `, prochaine ${new Date(next.at).toISOString()}` : ''}.`);
      return;
    }
    if (result.permanent) return this.#disable(guild, fresh, result.reason);
    this.repo.setError(fresh.id, result.reason);
    if (now - fresh.next_run <= MAX_LATE_MS) return undefined;
    // Trop de retard : une annonce unique est abandonnée, une répétition passe à l'occurrence suivante.
    const next = nextAfter(fresh.anchor_at, fresh.repeat, fresh.time_zone, fresh.runs, now);
    if (!next) return this.#disable(guild, fresh, `non publiée 24 h après l'échéance (${result.reason})`);
    this.repo.markSent(fresh.id, { now, nextRun: next.at, runs: next.runs });
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
