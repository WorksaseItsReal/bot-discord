'use strict';

const { PermissionFlagsBits, ChannelType, OverwriteType, embedLength } = require('discord.js');
const { createLogger } = require('../core/logger');
const { card, wide, ICONS, fitEmbeds } = require('../utils/ui');
const { LOG_CATEGORIES, EVENT_CATEGORY } = require('../utils/logCatalog');
const { canReadCached } = require('../utils/channelAccess');

const logger = createLogger('logs');

/** En-tête « Logs · <catégorie> » de chaque catégorie de logs. */
const LOG_SECTIONS = Object.freeze(
  Object.fromEntries(Object.entries(LOG_CATEGORIES).map(([k, c]) => [k, { emoji: c.emoji, label: c.label }])),
);

/** Permissions dont le bot a besoin dans un salon de logs. */
const REQUIRED_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/** Texte affiché à la place d'un contenu venu d'un salon (ou fil) plus restreint que le salon de logs. */
const PRIVATE_CONTENT = '🔒 *Contenu masqué : salon privé (certains lecteurs de ce salon de logs n\'y ont pas accès).*';
/** Lecture d'un salon et de son historique. */
const READ_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
/** Au-delà, les lecteurs ne sont plus vérifiés un à un (repli : tout refus propre à la source masque). */
const MAX_READER_CHECKS = 500;

/**
 * Le salon `source` (salon ou fil) est-il MOINS visible que le salon de logs `target` ? Vrai dès
 * qu'un lecteur possible du salon de logs ne peut pas lire la source, et en cas de doute (salon
 * inconnu, membre hors cache, erreur). Lecteurs comparés : chaque rôle (dont @everyone ; hors
 * rôles gérés et « Administrateur ») qui voit le salon de logs, puis chaque membre en cache qui
 * le voit (permission propre, combinaison de rôles). Un fil hérite de son salon parent ; un fil
 * privé n'est lisible, hors membres du fil, qu'avec « Gérer les fils ». Pur (cache uniquement).
 */
function sourceLessVisible(source, target) {
  if (!source || !target) return true;
  if (source.id === target.id) return false;
  const guild = target.guild ?? source.guild;
  const parent = source.isThread?.() ? source.parent : source;
  if (!guild?.roles?.cache || typeof parent?.permissionsFor !== 'function' || typeof target.permissionsFor !== 'function') return true;
  const privateThread = source.type === ChannelType.PrivateThread;
  const { Administrator, ViewChannel, ManageThreads } = PermissionFlagsBits;
  try {
    // 1) Rôles qui voient le salon de logs : chacun doit lire la source.
    const readers = [];
    for (const role of guild.roles.cache.values()) {
      if (role.managed || role.permissions.has(Administrator)) continue;
      if (!target.permissionsFor(role)?.has(ViewChannel)) continue;
      const perms = parent.permissionsFor(role);
      if (!perms?.has(READ_PERMS) || (privateThread && !perms.has(ManageThreads))) return true;
      readers.push(role);
    }
    // 2) Membres qui voient le salon de logs : permission propre, ou porteurs d'un rôle lecteur.
    const me = guild.members?.me?.id;
    const members = new Map();
    for (const ow of target.permissionOverwrites?.cache?.values() ?? []) {
      if (ow.type !== OverwriteType.Member || ow.id === me || !ow.allow.has(ViewChannel)) continue;
      const member = guild.members?.cache?.get(ow.id);
      if (!member) return true;
      members.set(member.id, member);
    }
    let exhaustive = true;
    for (const role of readers) {
      if (role.id === guild.id) {
        exhaustive = false; // @everyone : tout le serveur
        continue;
      }
      for (const member of role.members.values()) {
        if (members.size >= MAX_READER_CHECKS) {
          exhaustive = false;
          break;
        }
        members.set(member.id, member);
      }
    }
    for (const member of members.values()) {
      if (member.user?.bot || member.permissions?.has(Administrator)) continue;
      if (target.permissionsFor(member)?.has(ViewChannel) && !canReadCached(source, member)) return true;
    }
    // Lecteurs non vérifiés un à un : tout refus de lecture propre à la source (rôle, membre) masque.
    if (!exhaustive && parent.permissionOverwrites?.cache?.some((ow) => ow.id !== guild.id && ow.deny.any(READ_PERMS))) return true;
    return false;
  } catch (err) {
    logger.debug('Visibilité du salon source :', err?.message);
    return true;
  }
}

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
 * File d'envoi par salon de logs (Discord : ~5 messages / 5 s par salon). Les catégories
 * prioritaires (alertes de sécurité, sanctions) passent devant et ne sont jamais abandonnées ;
 * les autres sont plafonnées par salon (au-delà : abandonnées et comptées), et regroupées par
 * lots de 10 cartes par message dès qu'elles s'accumulent.
 */
const PRIORITY_CATEGORIES = new Set(['security', 'moderation']);
const MAX_PENDING = 200;
const GROUP_FROM = 5;
const GROUP_MAX = 10;
const GROUP_CHARS = 5_500; // limite de Discord : 6 000 caractères d'embeds par message

/** Taille (caractères comptés par Discord) d'une carte. */
function embedSize(embed) {
  try {
    return embedLength(embed?.data ?? embed ?? {});
  } catch {
    return GROUP_CHARS;
  }
}

/** Le bot peut-il joindre des fichiers dans ce salon (d'après le cache) ? */
function canAttach(channel) {
  const me = channel?.guild?.members?.me;
  if (!me || typeof channel.permissionsFor !== 'function') return true;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles) !== false;
}

/** Ajoute à la carte l'explication « fichier non joint » (une seule fois). */
function withoutFilesNote(embed) {
  if (typeof embed?.addFields !== 'function' || embed.data?.fields?.some((f) => f.name.includes('Fichier non joint'))) return;
  embed.addFields(wide(ICONS.warning, 'Fichier non joint', 'Il me manque la permission **Joindre des fichiers** dans ce salon de logs.'));
}

/** Carte « logs abandonnés » publiée quand une inondation se termine. */
function floodCard(n) {
  return card({
    tone: 'warning',
    section: { emoji: '📋', label: 'Logs' },
    icon: ICONS.warning,
    title: 'Logs non envoyés',
    description: `**${n}** log(s) ignoré(s) : trop d'événements d'un coup pour ce salon (limite d'envoi de Discord). Les alertes de sécurité et les sanctions passent toujours, en priorité.`,
  });
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
    /** Files d'envoi par salon : salon → { channel, items, running, dropped }. */
    this.queues = new Map();
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

  /**
   * Suppression groupée faite par le bot (ex. purge d'une quarantaine, déjà journalisée) :
   * vrai si TOUS les messages ont été marqués, et les marques sont alors consommées.
   * Sinon (purge manuelle, mélange), rien n'est consommé et la suppression est journalisée.
   * @param {Iterable<string>} messageIds
   */
  allSuppressed(messageIds) {
    const ids = [...messageIds];
    const now = Date.now();
    if (!ids.length || !ids.every((id) => (this.suppressed.get(id) ?? 0) > now)) return false;
    for (const id of ids) this.suppressed.delete(id);
    return true;
  }

  /**
   * Faut-il masquer, dans le salon de logs de `category`, le contenu venu de `source` (texte,
   * transcription, nom de fil) ? Jamais de contenu d'un salon ou d'un fil privé dans un salon de
   * logs lu par des membres qui n'y ont pas accès (voir `sourceLessVisible`).
   */
  hidesContent(guildId, category, source) {
    const channelId = this.config.get(guildId).logChannels?.[category];
    const target = channelId ? this.client.guilds?.cache?.get(guildId)?.channels?.cache?.get(channelId) : null;
    return sourceLessVisible(source, target);
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
    // Jamais de logs dans un salon d'annonces : ils pourraient être publiés vers les serveurs abonnés.
    if (channel.type === ChannelType.GuildAnnouncement) return null;
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
      return await this.#enqueue(channel, { guildId, category, embed, components, ctx });
    } catch (err) {
      logger.debug(`Impossible d'envoyer un log (${category}) pour ${guildId}:`, err?.message);
      return false;
    }
  }

  /** Met une carte dans la file de son salon ; résolu (true/false) une fois envoyée ou abandonnée. */
  #enqueue(channel, item) {
    let q = this.queues.get(channel.id);
    if (!q) {
      q = { channel, items: [], running: false, dropped: 0 };
      this.queues.set(channel.id, q);
    }
    q.channel = channel;
    const priority = PRIORITY_CATEGORIES.has(item.category);
    if (!priority && q.items.reduce((n, i) => n + (i.priority ? 0 : 1), 0) >= MAX_PENDING) {
      q.dropped += 1;
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const entry = { ...item, priority, resolve };
      // Prioritaire : après les autres cartes prioritaires en attente, devant tout le reste.
      const at = priority ? q.items.findIndex((i) => !i.priority) : -1;
      if (at === -1) q.items.push(entry);
      else q.items.splice(at, 0, entry);
      if (!q.running) this.#drain(q);
    });
  }

  /** Vide la file d'un salon, un message à la fois. */
  async #drain(q) {
    q.running = true;
    try {
      while (q.items.length) {
        await this.#deliver(q.channel, this.#nextBatch(q));
        if (!q.items.length && q.dropped) {
          const n = q.dropped;
          q.dropped = 0;
          await q.channel.send({ embeds: [floodCard(n)] }).catch(() => {});
        }
      }
    } finally {
      q.running = false;
      if (!q.items.length && this.queues.get(q.channel.id) === q) this.queues.delete(q.channel.id);
    }
  }

  /** Prochain envoi : une carte, ou un lot de cartes simples quand elles s'accumulent. */
  #nextBatch(q) {
    const plain = (i) => !i.priority && !i.components?.length && !i.ctx.files?.length && typeof i.ctx.onSent !== 'function';
    const first = q.items.shift();
    if (!plain(first) || q.items.length + 1 < GROUP_FROM) return [first];
    const batch = [first];
    let size = embedSize(first.embed);
    while (batch.length < GROUP_MAX && q.items.length && plain(q.items[0])) {
      const next = embedSize(q.items[0].embed);
      if (size + next > GROUP_CHARS) break;
      size += next;
      batch.push(q.items.shift());
    }
    return batch;
  }

  async #deliver(channel, batch) {
    if (batch.length > 1) {
      const ok = await channel.send({ embeds: fitEmbeds(batch.map((i) => i.embed)) }).then(() => true, (err) => {
        logger.debug(`Impossible d'envoyer ${batch.length} logs groupés :`, err?.message);
        return false;
      });
      for (const i of batch) i.resolve(ok);
      return;
    }
    const [item] = batch;
    try {
      const message = await this.#sendOne(channel, item);
      // Optionnel : l'appelant peut mémoriser le message (ex : fiche de sanction mise à jour plus tard).
      if (typeof item.ctx.onSent === 'function') {
        try {
          item.ctx.onSent(message);
        } catch (err) {
          logger.debug('onSent a échoué :', err?.message);
        }
      }
      item.resolve(true);
    } catch (err) {
      logger.debug(`Impossible d'envoyer un log (${item.category}) pour ${item.guildId}:`, err?.message);
      item.resolve(false);
    }
  }

  async #sendOne(channel, { embed, components, ctx }) {
    const payload = { embeds: [embed] };
    if (components?.length) payload.components = components;
    // Pièces jointes (transcription d'une purge) : sans « Joindre des fichiers », la carte part
    // quand même, sans le fichier et avec une explication (sinon 50013 : log entier perdu).
    if (ctx.files?.length) {
      if (canAttach(channel)) payload.files = ctx.files;
      else withoutFilesNote(embed);
    }
    try {
      return await channel.send(payload);
    } catch (err) {
      if (!payload.files || err?.code !== 50013) throw err;
      delete payload.files;
      withoutFilesNote(embed);
      return channel.send(payload);
    }
  }

  /**
   * État d'un salon de logs : 'ok', 'unset' (non configuré), 'missing' (supprimé),
   * 'noperm' (le bot ne peut pas y écrire), 'announcement' (salon d'annonces : refusé).
   * @param {import('discord.js').Guild} guild
   */
  channelStatus(guild, channelId) {
    if (!channelId) return 'unset';
    const channel = guild.channels?.cache?.get(channelId);
    if (!channel) return 'missing';
    if (channel.type === ChannelType.GuildAnnouncement) return 'announcement';
    const me = guild.members?.me;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(REQUIRED_PERMISSIONS)) return 'noperm';
    return 'ok';
  }
}

module.exports = { LoggingService, LOG_SECTIONS, logSection, logCard, fitList, shouldLog, sourceLessVisible, canAttach, PRIVATE_CONTENT, REQUIRED_PERMISSIONS };
