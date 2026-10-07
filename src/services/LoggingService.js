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
 * @param {{ event?: string, channelId?: string|null, parentId?: string|null, bot?: boolean }} [ctx]
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
    if (ctx.channelId && (ignored.includes(ctx.channelId) || (ctx.parentId && ignored.includes(ctx.parentId)))) return false;
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
  }

  /**
   * @param {string} guildId
   * @param {keyof LOG_SECTIONS} category
   * @param {import('discord.js').EmbedBuilder} embed
   * @param {import('discord.js').ActionRowBuilder[]} [components] boutons optionnels (ex : « Aller au message »)
   * @param {{ event?: string, channelId?: string|null, parentId?: string|null, bot?: boolean }} [ctx]
   *   event : clé du catalogue (désactivable dans /logs) ; channelId : salon d'origine (exemptions).
   */
  async send(guildId, category, embed, components, ctx = {}) {
    try {
      const cfg = this.config.get(guildId);
      if (ctx.event && EVENT_CATEGORY[ctx.event] && EVENT_CATEGORY[ctx.event] !== category) {
        logger.debug(`Événement ${ctx.event} envoyé dans ${category} au lieu de ${EVENT_CATEGORY[ctx.event]}`);
      }
      if (!shouldLog(cfg, category, ctx)) return false;
      const channel = await this.client.channels.fetch(cfg.logChannels[category]).catch(() => null);
      if (!channel || !channel.isTextBased()) return false;
      const payload = { embeds: [embed] };
      if (components?.length) payload.components = components;
      await channel.send(payload);
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
