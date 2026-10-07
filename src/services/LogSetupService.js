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

/** Permissions accordées au bot dans ses salons de logs. */
const BOT_ALLOW = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory];
/** Interdictions pour le rôle staff (lecture seule). */
const STAFF_DENY = [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads];

/**
 * Permissions des salons de logs : privés, lisibles par le staff, écrits par le bot seul.
 * Sans « Administrateur », Discord n'autorise le bot à accorder/refuser que les
 * permissions qu'il possède : celles qu'il n'a pas sont simplement omises.
 */
function overwrites(guild, staffRoleId) {
  const me = guild.members.me;
  const has = (flag) => me?.permissions?.has?.(flag) !== false;
  const list = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: me.id, allow: BOT_ALLOW.filter(has) },
  ];
  if (staffRoleId && guild.roles.cache.has(staffRoleId)) {
    list.push({ id: staffRoleId, allow: [P.ViewChannel, P.ReadMessageHistory], deny: STAFF_DENY.filter(has) });
  }
  return list;
}

/** Applique les permissions gérées par le bot SANS effacer celles ajoutées à la main. */
async function mergeOverwrites(channel, list, reason) {
  for (const o of list) {
    const options = {};
    for (const f of o.allow ?? []) options[flagName(f)] = true;
    for (const f of o.deny ?? []) options[flagName(f)] = false;
    await channel.permissionOverwrites.edit(o.id, options, { reason }).catch(() => {});
  }
}

const FLAG_NAMES = new Map(Object.entries(P).map(([name, bit]) => [bit, name]));
const flagName = (bit) => FLAG_NAMES.get(bit);

class LogSetupService {
  /** @param {{ config: import('./ConfigService').ConfigService }} deps */
  constructor({ config }) {
    this.config = config;
    /** Serveurs avec une création/suppression en cours (double clic). */
    this.busy = new Set();
  }

  assertCanCreate(guild) {
    const me = guild.members.me;
    const missing = [
      [P.ManageChannels, 'Gérer les salons'],
      [P.ManageRoles, 'Gérer les rôles (permissions des salons)'],
      [P.ViewChannel, 'Voir les salons'],
      [P.SendMessages, 'Envoyer des messages'],
      [P.EmbedLinks, 'Intégrer des liens'],
    ].filter(([flag]) => !me?.permissions.has(flag));
    if (missing.length) throw new UserError(`Il me manque : ${missing.map(([, l]) => `**${l}**`).join(', ')}.`);
  }

  /** Exécute `fn` en empêchant deux opérations simultanées sur le même serveur. */
  async #exclusive(guildId, fn) {
    if (this.busy.has(guildId)) throw new UserError('Une opération sur les salons de logs est déjà en cours. Patientez quelques secondes.');
    this.busy.add(guildId);
    try {
      return await fn();
    } finally {
      this.busy.delete(guildId);
    }
  }

  /**
   * Crée (ou complète) la catégorie « Logs » et ses salons, puis branche les
   * catégories de logs dessus. Les salons déjà créés par le bot sont réutilisés.
   * @returns {Promise<{ category: object, created: object[], reused: object[], mapping: Record<string,string> }>}
   */
  async create(guild, opts) {
    return this.#exclusive(guild.id, () => this.#create(guild, opts));
  }

  async #create(guild, { layout, categories, staffRoleId, reason }) {
    this.assertCanCreate(guild);
    const plan = planChannels(layout, categories);
    if (!plan.length) throw new UserError('Choisissez au moins une catégorie de logs.');
    const cfg = this.config.get(guild.id).logs;
    const perms = overwrites(guild, staffRoleId);
    const auditReason = reason ?? 'Création automatique des salons de logs';
    const known = new Set(cfg.createdChannels ?? []);
    // Chaque étape est enregistrée AUSSITÔT : un échec en cours de route ne laisse
    // aucun salon « orphelin », et une nouvelle tentative les réutilise.
    const remember = (patch) => this.config.update(guild.id, patch);

    let category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
    if (category && category.type !== ChannelType.GuildCategory) category = null;
    if (category) {
      await mergeOverwrites(category, perms, auditReason);
    } else {
      category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: perms, reason: auditReason });
      remember({ logs: { categoryId: category.id, staffRoleId: staffRoleId ?? null } });
    }

    const created = [];
    const reused = [];
    const mapping = {};
    for (const item of plan) {
      // Réutilise uniquement un salon CRÉÉ PAR LE BOT (même nom ou même sujet), jamais un salon de l'utilisateur.
      let channel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && known.has(c.id) && (c.name === item.name || c.topic === item.topic),
      );
      if (channel) {
        if (channel.parentId !== category.id) await channel.setParent(category.id, { lockPermissions: false, reason: auditReason }).catch(() => {});
        await channel.setTopic(item.topic, auditReason).catch(() => {});
        await mergeOverwrites(channel, perms, auditReason);
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
        known.add(channel.id);
        remember({ logs: { createdChannels: [...known] } });
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
      const part = Object.fromEntries(item.categories.map((c) => [c, channel.id]));
      Object.assign(mapping, part);
      remember({ logChannels: part });
    }

    remember({
      logs: {
        categoryId: category.id,
        createdChannels: [...known],
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
    return this.#exclusive(guild.id, async () => {
      this.assertCanCreate(guild);
      const full = this.config.get(guild.id);
      const ids = new Set(full.logs.createdChannels ?? []);
      let removed = 0;
      const failed = [];
      for (const id of ids) {
        const channel = guild.channels.cache.get(id);
        if (!channel) continue; // déjà supprimé
        const ok = await channel.delete(reason).then(() => true, () => false);
        if (ok) removed += 1;
        else failed.push(id);
      }
      // La catégorie n'est supprimée que si elle est vide (vos propres salons restent intacts).
      let categoryId = full.logs.categoryId;
      const category = categoryId ? guild.channels.cache.get(categoryId) : null;
      if (!category) categoryId = null;
      else if (!guild.channels.cache.some((c) => c.parentId === category.id)) {
        if (await category.delete(reason).then(() => true, () => false)) categoryId = null;
      }
      const gone = new Set([...ids].filter((id) => !failed.includes(id)));
      const unplug = Object.fromEntries(Object.entries(full.logChannels ?? {}).filter(([, id]) => gone.has(id)).map(([k]) => [k, null]));
      this.config.update(guild.id, { logChannels: unplug, logs: { categoryId, createdChannels: failed } });
      return removed;
    });
  }
}

module.exports = { LogSetupService, planChannels, overwrites, CATEGORY_NAME };
