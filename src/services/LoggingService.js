'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('../core/logger');
const { card } = require('../utils/ui');
const { LOG_CATEGORIES, EVENT_CATEGORY } = require('../utils/logCatalog');

const logger = createLogger('logs');

/** En-tête « Logs · <catégorie> » de chaque catégorie de logs. */
const LOG_SECTIONS = Object.freeze(
  Object.fromEntries(Object.entries(LOG_CATEGORIES).map(([k, c]) => [k, { emoji: c.emoji, label: c.label }])),
);

/** Permissions dont le bot a besoin dans un salon de logs. */
const REQUIRED_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * Faut-il journaliser cet événement ? Pur (testé).
 * @param {object} cfg configuration du serveur (logChannels + logs)
 * @param {string} category
 * @param {{ event?: string, channelId?: string|null, parentId?: string|null, categoryId?: string|null, bot?: boolean }} [ctx]
 */
function shouldLog(cfg, category, ctx = {}) {
  const logs = cfg.logs ?? {};
  if (logs.enabled === false) return false;
  if (logs.disabledCategories?.includes(category)) return false;
  if (ctx.event && logs.disabledEvents?.includes(ctx.event)) return false;
  const target = cfg.logChannels?.[category];
  if (!target) return false;
  if (category === 'messages') {
    if (ctx.bot && logs.ignoreBots !== false) return false;
    const ignored = logs.ignoredChannels ?? [];
    // Salon, salon parent (fil) ou catégorie (y compris celle du parent d'un fil).
    if ([ctx.channelId, ctx.parentId, ctx.categoryId].some((id) => id && ignored.includes(id))) return false;
  }
  // Jamais de log sur ce qui se passe DANS le salon de logs lui-même (boucle, bruit).
  if (ctx.channelId && Object.values(cfg.logChannels ?? {}).includes(ctx.channelId)) return false;
  return true;
}

/** Section d'une carte de log : `{ emoji, label: 'Logs · Messages' }`. */
function logSection(category) {
  const meta = LOG_SECTIONS[category] ?? { emoji: '📋', label: category };
  return { emoji: meta.emoji, label: `Logs · ${meta.label}` };
}

/**
 * Carte de log standard : section « Logs · … », miniature de l'utilisateur
 * concerné et identifiant en pied de page (`ID : …`).
 * @param {{
 *   category: keyof LOG_SECTIONS, tone?: string, icon?: string, title: string,
 *   description?: string|string[], user?: import('discord.js').User|null,
 *   thumbnail?: string|null, fields?: object[], id?: string|null,
 * }} opts
 */
function logCard({ category, tone = 'info', icon, title, description, user, thumbnail, fields = [], id }) {
  const footerId = id ?? user?.id;
  return card({
    tone,
    section: logSection(category),
    icon,
    title,
    description,
    thumbnail: thumbnail ?? user?.displayAvatarURL?.() ?? null,
    fields,
    footer: footerId ? `ID : ${footerId}` : undefined,
  });
}

/** Liste de mentions qui tient dans `max` caractères sans couper une mention. Pur. */
function fitList(items, max = 1000, separator = ' ') {
  if (!items?.length) return null;
  const out = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    if (used + items[i].length + separator.length > max - 12) {
      out.push(`+${items.length - i}`);
      break;
    }
    out.push(items[i]);
    used += items[i].length + separator.length;
  }
  return out.join(separator);
}

/**
 * Envoie des embeds de log dans le salon configuré pour chaque catégorie.
 * Tolère silencieusement l'absence de configuration ou de permissions.
 */
class LoggingService {
  /**
   * @param {import('discord.js').Client} client
   * @param {import('./ConfigService').ConfigService} configService
   */
  constructor(client, configService) {
    this.client = client;
    this.config = configService;
    /** Messages supprimés par le bot (AutoMod…) : déjà journalisés, pas de « Message supprimé » en double. */
    this.suppressed = new Map();
  }

  /** Marque un message que le bot va supprimer lui-même (TTL 30 s). */
  suppressMessage(messageId) {
    if (!messageId) return;
    const now = Date.now();
    this.suppressed.set(messageId, now + 30_000);
    if (this.suppressed.size > 500) for (const [id, exp] of this.suppressed) if (exp < now) this.suppressed.delete(id);
  }

  /** Ce message a-t-il été supprimé par le bot (et déjà journalisé ailleurs) ? */
  isSuppressed(messageId) {
    const exp = this.suppressed.get(messageId);
    if (!exp) return false;
    this.suppressed.delete(messageId);
    return exp > Date.now();
  }

  /** Ce log serait-il envoyé ? (évite un appel coûteux, ex : audit log, quand il est désactivé) */
  wouldLog(guildId, category, ctx = {}) {
    return shouldLog(this.config.get(guildId), category, ctx);
  }

  /**
   * Salon de logs utilisable (cache + permissions), ou null. Serveur en cache (cas normal,
   * intent Guilds) : aucune requête REST. Sinon, repli sur une récupération classique.
   */
  async #target(guildId, channelId) {
    const guild = this.client.guilds?.cache?.get(guildId);
    const channel = guild
      ? guild.channels?.cache?.get(channelId)
      : this.client.channels?.cache?.get?.(channelId) ?? (await this.client.channels?.fetch?.(channelId).catch(() => null));
    if (!channel || typeof channel.send !== 'function') return null;
    if (!guild) return channel;
    const me = guild.members?.me;
    if (me && typeof channel.permissionsFor === 'function' && !channel.permissionsFor(me)?.has(REQUIRED_PERMISSIONS)) return null;
    return channel;
  }

  /**
   * @param {string} guildId
   * @param {keyof LOG_SECTIONS} category
   * @param {import('discord.js').EmbedBuilder} embed
   * @param {import('discord.js').ActionRowBuilder[]} [components] boutons optionnels (ex : « Aller au message »)
   * @param {{ event?: string, channelId?: string|null, parentId?: string|null, categoryId?: string|null, bot?: boolean, files?: object[], onSent?: (message: import('discord.js').Message) => void }} [ctx]
   *   event : clé du catalogue (désactivable dans /logs) ; channelId/parentId/categoryId : origine
   *   (exemptions) ; files : pièces jointes (ex : transcription d'une purge) ; onSent : reçoit le message envoyé.
   */
  async send(guildId, category, embed, components, ctx = {}) {
    try {
      const cfg = this.config.get(guildId);
      if (ctx.event && EVENT_CATEGORY[ctx.event] && EVENT_CATEGORY[ctx.event] !== category) {
        logger.debug(`Événement ${ctx.event} envoyé dans ${category} au lieu de ${EVENT_CATEGORY[ctx.event]}`);
      }
      if (!shouldLog(cfg, category, ctx)) return false;
      // Cache uniquement : un salon supprimé ou inaccessible ne déclenche aucune requête
      // (des centaines de 403/404 peuvent faire bannir temporairement l'IP du bot).
      const channel = await this.#target(guildId, cfg.logChannels[category]);
      if (!channel) return false;
      const payload = { embeds: [embed] };
      if (components?.length) payload.components = components;
      if (ctx.files?.length) payload.files = ctx.files;
      const message = await channel.send(payload);
      // Optionnel : l'appelant peut mémoriser le message (ex : fiche de sanction mise à jour plus tard).
      if (typeof ctx.onSent === 'function') {
        try {
          ctx.onSent(message);
        } catch (err) {
          logger.debug('onSent a échoué :', err?.message);
        }
      }
      return true;
    } catch (err) {
      logger.debug(`Impossible d'envoyer un log (${category}) pour ${guildId}:`, err?.message);
      return false;
    }
  }

  /**
   * État d'un salon de logs : 'ok', 'unset' (non configuré), 'missing' (supprimé),
   * 'noperm' (le bot ne peut pas y écrire).
   * @param {import('discord.js').Guild} guild
   */
  channelStatus(guild, channelId) {
    if (!channelId) return 'unset';
    const channel = guild.channels?.cache?.get(channelId);
    if (!channel) return 'missing';
    const me = guild.members?.me;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(REQUIRED_PERMISSIONS)) return 'noperm';
    return 'ok';
  }
}

module.exports = { LoggingService, LOG_SECTIONS, logSection, logCard, fitList, shouldLog, REQUIRED_PERMISSIONS };
