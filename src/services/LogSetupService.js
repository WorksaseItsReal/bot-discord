'use strict';

const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { UserError } = require('../core/errors');
const { LOG_CATEGORIES, CATEGORY_KEYS, LAYOUTS, channelName } = require('../utils/logCatalog');
const { card, ICONS, subtext } = require('../utils/ui');
const { createLogger } = require('../core/logger');

const logger = createLogger('logs');
const CATEGORY_NAME = '📋 Logs';

/**
 * Plan de création (pur, testé) : salons à créer et catégories de logs de chacun.
 * @returns {Array<{ name: string, categories: string[], topic: string }>}
 */
function planChannels(layoutKey, selected) {
  const layout = LAYOUTS[layoutKey] ?? LAYOUTS.perCategory;
  const valid = CATEGORY_KEYS.filter((c) => selected.includes(c));
  return layout.groups(valid).map((g) => ({
    name: channelName(g.emoji, g.name),
    categories: g.categories,
    topic: `Logs : ${g.categories.map((c) => LOG_CATEGORIES[c].label).join(', ')}. Salon géré par le bot.`.slice(0, 1024),
  }));
}

/** Permissions des salons de logs : privés, lisibles par le staff, écrits par le bot seul. */
function overwrites(guild, staffRoleId) {
  const list = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: guild.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory] },
  ];
  if (staffRoleId && guild.roles.cache.has(staffRoleId)) {
    list.push({
      id: staffRoleId,
      allow: [P.ViewChannel, P.ReadMessageHistory],
      deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads],
    });
  }
  return list;
}

class LogSetupService {
  /** @param {{ config: import('./ConfigService').ConfigService }} deps */
  constructor({ config }) {
    this.config = config;
  }

  assertCanCreate(guild) {
    const me = guild.members.me;
    const missing = [
      [P.ManageChannels, 'Gérer les salons'],
      [P.ManageRoles, 'Gérer les rôles (permissions des salons)'],
    ].filter(([flag]) => !me?.permissions.has(flag));
    if (missing.length) throw new UserError(`Il me manque : ${missing.map(([, l]) => `**${l}**`).join(', ')}.`);
  }

  /**
   * Crée (ou complète) la catégorie « Logs » et ses salons, puis branche les
   * catégories de logs dessus. Les salons déjà créés par le bot sont réutilisés.
   * @returns {Promise<{ category: object, created: object[], reused: object[], mapping: Record<string,string> }>}
   */
  async create(guild, { layout, categories, staffRoleId, reason }) {
    this.assertCanCreate(guild);
    const plan = planChannels(layout, categories);
    if (!plan.length) throw new UserError('Choisissez au moins une catégorie de logs.');
    const cfg = this.config.get(guild.id).logs;
    const perms = overwrites(guild, staffRoleId);
    const auditReason = reason ?? 'Création automatique des salons de logs';

    let category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
    if (category && category.type !== ChannelType.GuildCategory) category = null;
    if (category) {
      await category.permissionOverwrites.set(perms, auditReason).catch(() => {});
    } else {
      category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: perms, reason: auditReason });
    }

    const created = [];
    const reused = [];
    const mapping = {};
    for (const item of plan) {
      // Réutilise un salon déjà créé par le bot : même nom, ou même rôle (sujet) si Discord a retouché le nom.
      const known = new Set(cfg.createdChannels ?? []);
      let channel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.parentId === category.id && (c.name === item.name || (known.has(c.id) && c.topic === item.topic)),
      );
      if (channel) {
        await channel.edit({ topic: item.topic, permissionOverwrites: perms, reason: auditReason }).catch(() => {});
        reused.push(channel);
      } else {
        channel = await guild.channels.create({
          name: item.name,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: item.topic,
          permissionOverwrites: perms,
          reason: auditReason,
        });
        created.push(channel);
        await channel
          .send({
            embeds: [
              card({
                tone: 'brand',
                section: { emoji: '📋', label: 'Logs' },
                icon: ICONS.success,
                title: 'Salon de logs prêt',
                description: [
                  'Ce salon recevra les logs suivants :',
                  ...item.categories.map((c) => `› ${LOG_CATEGORIES[c].emoji} **${LOG_CATEGORIES[c].label}** — ${LOG_CATEGORIES[c].description}`),
                  '',
                  subtext('Réglez les événements journalisés avec /logs.'),
                ],
              }),
            ],
          })
          .catch(() => {});
      }
      for (const c of item.categories) mapping[c] = channel.id;
    }

    const ids = new Set([...(cfg.createdChannels ?? []), ...created.map((c) => c.id), ...reused.map((c) => c.id)]);
    this.config.update(guild.id, {
      logChannels: mapping,
      logs: {
        categoryId: category.id,
        createdChannels: [...ids],
        staffRoleId: staffRoleId ?? null,
        disabledCategories: (cfg.disabledCategories ?? []).filter((c) => !mapping[c]),
      },
    });
    logger.info(`Salons de logs créés sur ${guild.id} : ${created.length} nouveau(x), ${reused.length} réutilisé(s)`);
    return { category, created, reused, mapping };
  }

  /**
   * Supprime les salons (et la catégorie) créés par le bot et débranche les logs concernés.
   * @returns {Promise<number>} nombre de salons supprimés
   */
  async remove(guild, reason = 'Suppression des salons de logs') {
    this.assertCanCreate(guild);
    const full = this.config.get(guild.id);
    const ids = new Set(full.logs.createdChannels ?? []);
    let removed = 0;
    for (const id of ids) {
      const channel = guild.channels.cache.get(id);
      if (channel) removed += await channel.delete(reason).then(() => 1, () => 0);
    }
    const category = full.logs.categoryId ? guild.channels.cache.get(full.logs.categoryId) : null;
    if (category && !guild.channels.cache.some((c) => c.parentId === category.id)) await category.delete(reason).catch(() => {});
    const unplug = Object.fromEntries(Object.entries(full.logChannels ?? {}).filter(([, id]) => ids.has(id)).map(([k]) => [k, null]));
    this.config.update(guild.id, { logChannels: unplug, logs: { categoryId: null, createdChannels: [] } });
    return removed;
  }
}

module.exports = { LogSetupService, planChannels, overwrites, CATEGORY_NAME };
