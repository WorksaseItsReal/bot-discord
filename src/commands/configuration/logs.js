'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');
const { card, field, wide, ICONS, actionButton, buttonRows, ButtonStyle, subtext } = require('../../utils/ui');
const { truncate, progressBar } = require('../../utils/embeds');
const { LOG_CATEGORIES, CATEGORY_KEYS, LAYOUTS } = require('../../utils/logCatalog');
const { planChannels } = require('../../services/LogSetupService');
const { requirePermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/**
 * /logs : tableau de bord unique des logs (éphémère).
 * Vues : home · cat:<catégorie> · setup · options · confirmRemove
 */

const STATUS = {
  ok: ['🟢', 'Actif'],
  unset: ['⚪', 'Non configuré'],
  missing: ['❌', 'Salon introuvable'],
  noperm: ['🔒', 'Je ne peux pas y écrire'],
  paused: ['⏸️', 'En pause'],
};
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_IGNORED = 25;

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const full = (client, guildId) => client.services.config.get(guildId);

/** État d'une catégorie : pause > salon. */
function categoryState(client, guild, key) {
  const cfg = full(client, guild.id);
  if (cfg.logs?.disabledCategories?.includes(key)) return 'paused';
  return client.services.logging.channelStatus(guild, cfg.logChannels?.[key]);
}

/**
 * Catégories réparables automatiquement : salon supprimé, ou salon créé par le bot
 * dont les permissions ont été cassées (on ne touche jamais aux salons de l'utilisateur).
 */
function repairable(client, guild) {
  const cfg = full(client, guild.id);
  const known = new Set(cfg.logs?.createdChannels ?? []);
  return CATEGORY_KEYS.filter((k) => {
    const s = categoryState(client, guild, k);
    return s === 'missing' || (s === 'noperm' && known.has(cfg.logChannels?.[k]));
  });
}

/** Le salon est-il visible par @everyone (et non créé par le bot) ? */
function isPublic(guild, cfg, channelId) {
  if (!channelId || cfg.logs?.createdChannels?.includes(channelId)) return false;
  const channel = guild.channels?.cache?.get(channelId);
  const everyone = guild.roles?.everyone;
  if (!channel?.permissionsFor || !everyone) return false;
  try {
    return channel.permissionsFor(everyone)?.has?.(PermissionFlagsBits.ViewChannel) === true;
  } catch {
    return false;
  }
}

function enabledEvents(cfg, key) {
  const disabled = new Set(cfg.logs?.disabledEvents ?? []);
  return Object.keys(LOG_CATEGORIES[key].events).filter((e) => !disabled.has(e));
}

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:logs:nav')
      .setPlaceholder('Aller à…')
      .addOptions(
        { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble de toutes les catégories', default: current === 'home' },
        ...CATEGORY_KEYS.map((k) => ({
          value: `cat:${k}`,
          label: `Logs · ${LOG_CATEGORIES[k].label}`,
          emoji: LOG_CATEGORIES[k].emoji,
          description: truncate(LOG_CATEGORIES[k].description, 100),
          default: current === `cat:${k}`,
        })),
        { value: 'setup', label: 'Création automatique des salons', emoji: '⚡', description: 'Créer une catégorie privée et ses salons', default: current === 'setup' },
        { value: 'options', label: 'Options', emoji: '⚙️', description: 'Bots, salons ignorés', default: current === 'options' },
      ),
  );
}

const homeButton = () => actionButton({ command: 'logs', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

function homeView(client, guild, notice) {
  const cfg = full(client, guild.id);
  const on = cfg.logs?.enabled !== false;
  const states = CATEGORY_KEYS.map((k) => [k, categoryState(client, guild, k)]);
  const active = states.filter(([, s]) => s === 'ok').length;
  const problems = states.filter(([, s]) => s === 'missing' || s === 'noperm').length;
  const lines = states.map(([k, s]) => {
    const meta = LOG_CATEGORIES[k];
    const [dot, label] = STATUS[s];
    const channel = cfg.logChannels?.[k] ? `<#${cfg.logChannels[k]}>` : '—';
    const events = enabledEvents(cfg, k).length;
    const total = Object.keys(meta.events).length;
    return `${dot} ${meta.emoji} **${meta.label}** · ${s === 'unset' ? label : channel}${s === 'missing' || s === 'noperm' || s === 'paused' ? ` · *${label}*` : ''} · ${events}/${total} évén.`;
  });
  return {
    embeds: [
      card({
        tone: !on ? 'neutral' : problems ? 'warning' : active ? 'success' : 'info',
        section: { emoji: '📋', label: 'Logs' },
        icon: '📋',
        title: 'Logs · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          on ? '🟢 Les logs sont **actifs**.' : '🔴 Les logs sont **en pause** sur tout le serveur.',
          `\`${progressBar(active / CATEGORY_KEYS.length, 14)}\` **${active}** / ${CATEGORY_KEYS.length} catégories actives`,
          problems ? `${ICONS.warning} **${problems}** catégorie(s) à réparer (salon supprimé ou permission manquante).` : null,
          '',
          ...lines,
        ],
        fields: [
          field('🤖', 'Messages des bots', cfg.logs?.ignoreBots !== false ? 'Ignorés' : 'Journalisés'),
          field(ICONS.channel, 'Salons ignorés', `${cfg.logs?.ignoredChannels?.length ?? 0}`),
          field('👮', 'Rôle staff (lecture)', cfg.logs?.staffRoleId ? `<@&${cfg.logs.staffRoleId}>` : '*Aucun*'),
        ],
        footer: 'Choisissez une catégorie dans le menu · ⚡ pour tout créer automatiquement',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        on
          ? actionButton({ command: 'logs', action: 'toggle', label: 'Tout mettre en pause', emoji: '⏸️', style: ButtonStyle.Danger })
          : actionButton({ command: 'logs', action: 'toggle', label: 'Réactiver les logs', emoji: '▶️', style: ButtonStyle.Success }),
        actionButton({ command: 'logs', action: 'go', args: ['setup'], label: 'Création automatique', emoji: '⚡', style: ButtonStyle.Primary }),
        repairable(client, guild).length
          ? actionButton({ command: 'logs', action: 'repair', label: 'Réparer', emoji: '🛠️', style: ButtonStyle.Success })
          : null,
        actionButton({ command: 'logs', action: 'test', args: ['all'], label: 'Tester', emoji: '🧪' }),
        actionButton({ command: 'logs', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function categoryView(client, guild, key, notice) {
  const meta = LOG_CATEGORIES[key];
  if (!meta) throw new UserError('Catégorie de logs inconnue.');
  const cfg = full(client, guild.id);
  const state = categoryState(client, guild, key);
  const [dot, label] = STATUS[state];
  const enabled = new Set(enabledEvents(cfg, key));
  const channelId = cfg.logChannels?.[key];
  const paused = state === 'paused';

  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`cmd:logs:channel:${key}`)
    .setPlaceholder('Choisir le salon de cette catégorie…')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (channelId && guild.channels?.cache?.has(channelId)) channelMenu.setDefaultChannels(channelId);

  const events = Object.entries(meta.events);
  const hints = {
    missing: 'Le salon a été supprimé : choisissez-en un autre ou utilisez la création automatique.',
    noperm: 'Donnez-moi **Voir le salon**, **Envoyer des messages** et **Intégrer des liens** dans ce salon.',
    unset: 'Choisissez un salon ci-dessous pour activer cette catégorie.',
  };
  return {
    embeds: [
      card({
        tone: state === 'ok' ? 'success' : state === 'missing' || state === 'noperm' ? 'warning' : 'neutral',
        section: { emoji: '📋', label: 'Logs' },
        icon: meta.emoji,
        title: `Logs · ${meta.label}`,
        description: [
          notice ? `${notice}\n` : null,
          meta.description,
          hints[state] ? `\n${ICONS.info} ${hints[state]}` : null,
          isPublic(guild, cfg, channelId) ? `\n${ICONS.warning} **Ce salon est visible par @everyone** : les logs (messages supprimés, IP de raid, etc.) seront publics.` : null,
        ],
        fields: [
          field(ICONS.status, 'État', `${dot} ${label}`),
          field(ICONS.channel, 'Salon', channelId ? `<#${channelId}>` : '—'),
          field(ICONS.count, 'Événements', `${enabled.size} / ${events.length}`),
          wide('📌', 'Événements journalisés', events.map(([e, l]) => `${enabled.has(e) ? '✅' : '❌'} ${l}`).join('\n')),
        ],
        footer: 'Le menu des événements remplace la sélection actuelle',
      }),
    ],
    components: [
      navRow(`cat:${key}`),
      new ActionRowBuilder().addComponents(channelMenu),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cmd:logs:events:${key}`)
          .setPlaceholder('Événements à journaliser…')
          .setMinValues(0)
          .setMaxValues(events.length)
          .addOptions(events.map(([e, l]) => ({ value: e, label: truncate(l, 100), default: enabled.has(e) }))),
      ),
      ...buttonRows(
        paused
          ? actionButton({ command: 'logs', action: 'pause', args: [key], label: 'Reprendre', emoji: '▶️', style: ButtonStyle.Success })
          : actionButton({ command: 'logs', action: 'pause', args: [key], label: 'Mettre en pause', emoji: '⏸️' }),
        channelId ? actionButton({ command: 'logs', action: 'test', args: [key], label: 'Tester', emoji: '🧪', style: ButtonStyle.Primary }) : null,
        homeButton(),
      ),
    ],
  };
}

function setupView(client, guild, notice) {
  const cfg = full(client, guild.id);
  const setup = cfg.logs?.setup ?? {};
  const layoutKey = LAYOUTS[setup.layout] ? setup.layout : 'perCategory';
  const selected = (setup.categories ?? CATEGORY_KEYS).filter((c) => CATEGORY_KEYS.includes(c));
  const plan = planChannels(layoutKey, selected);
  const staff = cfg.logs?.staffRoleId && guild.roles?.cache?.has(cfg.logs.staffRoleId) ? cfg.logs.staffRoleId : null;
  const existing = cfg.logs?.categoryId && guild.channels?.cache?.get(cfg.logs.categoryId);

  const roleMenu = new RoleSelectMenuBuilder().setCustomId('cmd:logs:staff').setPlaceholder('Rôle staff qui pourra lire les logs (optionnel)').setMinValues(0).setMaxValues(1);
  if (staff) roleMenu.setDefaultRoles(staff);

  return {
    embeds: [
      card({
        tone: 'brand',
        section: { emoji: '📋', label: 'Logs' },
        icon: '⚡',
        title: 'Création automatique des salons',
        description: [
          notice ? `${notice}\n` : null,
          'Je crée une catégorie **📋 Logs** privée et ses salons, puis je branche chaque catégorie de logs dessus.',
          '1. Choisissez la **disposition** et les **catégories**.',
          '2. Choisissez le **rôle staff** qui pourra lire (sans écrire).',
          '3. Cliquez sur **Créer les salons**.',
          existing ? `\n${ICONS.info} Une catégorie de logs existe déjà (${existing}) : elle sera complétée, rien ne sera dupliqué.` : null,
        ],
        fields: [
          field(LAYOUTS[layoutKey].emoji, 'Disposition', LAYOUTS[layoutKey].label),
          field('👮', 'Lecture', staff ? `<@&${staff}>` : '*Administrateurs uniquement*'),
          field(ICONS.count, 'Salons prévus', `${plan.length}`),
          wide('🗂️', 'Aperçu', plan.length ? plan.map((p) => `**#${p.name}** ← ${p.categories.map((c) => LOG_CATEGORIES[c].label).join(', ')}`).join('\n') : '*Aucune catégorie choisie.*'),
        ],
        footer: 'Salons privés : @everyone ne les voit pas, seul le bot y écrit',
      }),
    ],
    components: [
      navRow('setup'),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:logs:layout')
          .setPlaceholder('Disposition…')
          .addOptions(Object.entries(LAYOUTS).map(([k, l]) => ({ value: k, label: l.label, emoji: l.emoji, description: truncate(l.description, 100), default: k === layoutKey }))),
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:logs:setupcats')
          .setPlaceholder('Catégories à créer…')
          .setMinValues(1)
          .setMaxValues(CATEGORY_KEYS.length)
          .addOptions(CATEGORY_KEYS.map((k) => ({ value: k, label: LOG_CATEGORIES[k].label, emoji: LOG_CATEGORIES[k].emoji, default: selected.includes(k) }))),
      ),
      new ActionRowBuilder().addComponents(roleMenu),
      ...buttonRows(
        actionButton({ command: 'logs', action: 'create', label: 'Créer les salons', emoji: '✅', style: ButtonStyle.Success, disabled: !plan.length }),
        cfg.logs?.createdChannels?.length
          ? actionButton({ command: 'logs', action: 'go', args: ['confirmRemove'], label: 'Supprimer les salons créés', emoji: ICONS.delete, style: ButtonStyle.Danger })
          : null,
        homeButton(),
      ),
    ],
  };
}

function confirmRemoveView(client, guild) {
  const cfg = full(client, guild.id);
  const channels = (cfg.logs?.createdChannels ?? []).filter((id) => guild.channels?.cache?.has(id));
  return {
    embeds: [
      card({
        tone: 'danger',
        section: { emoji: '📋', label: 'Logs' },
        icon: ICONS.warning,
        title: 'Supprimer les salons de logs ?',
        description: [
          `Les **${channels.length}** salon(s) créés par le bot et leur historique seront **définitivement supprimés** :`,
          channels.map((id) => `<#${id}>`).join(' ') || '*Aucun salon trouvé.*',
          '',
          subtext('Les salons que vous avez choisis vous-même ne sont pas touchés.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'logs', action: 'remove', label: 'Oui, supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'logs', action: 'go', args: ['setup'], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

function optionsView(client, guild, notice) {
  const cfg = full(client, guild.id);
  const cache = guild.channels?.cache;
  const allowed = [...TEXT_TYPES, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildCategory];
  const ignored = (cfg.logs?.ignoredChannels ?? []).filter((id) => !cache || allowed.includes(cache.get(id)?.type)).slice(0, MAX_IGNORED);
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:logs:ignore')
    .setPlaceholder('Salons ou catégories dont les messages ne sont pas journalisés')
    .setChannelTypes(...allowed)
    .setMinValues(0)
    .setMaxValues(MAX_IGNORED);
  if (ignored.length) menu.setDefaultChannels(...ignored);
  const bots = cfg.logs?.ignoreBots !== false;
  return {
    embeds: [
      card({
        tone: 'info',
        section: { emoji: '📋', label: 'Logs' },
        icon: ICONS.settings,
        title: 'Options des logs',
        description: [
          notice ? `${notice}\n` : null,
          'Réduisez le bruit : les messages des salons ignorés (et de leurs fils) ne sont pas journalisés. Ignorer une **catégorie** ignore tous ses salons.',
        ],
        fields: [
          field('🤖', 'Messages des bots', bots ? 'Ignorés' : 'Journalisés'),
          field(ICONS.channel, 'Salons ignorés', `${ignored.length} / ${MAX_IGNORED}`),
        ],
        footer: 'Les salons de logs ne sont jamais journalisés eux-mêmes',
      }),
    ],
    components: [
      navRow('options'),
      new ActionRowBuilder().addComponents(menu),
      ...buttonRows(
        actionButton({ command: 'logs', action: 'bots', label: bots ? 'Journaliser les bots' : 'Ignorer les bots', emoji: '🤖' }),
        homeButton(),
      ),
    ],
  };
}

function render(client, guild, view = 'home', notice) {
  const [name, arg] = String(view).split(/[:.]/);
  if (name === 'cat') return categoryView(client, guild, arg, notice);
  if (name === 'setup') return setupView(client, guild, notice);
  if (name === 'options') return optionsView(client, guild, notice);
  if (name === 'confirmRemove') return confirmRemoveView(client, guild);
  return homeView(client, guild, notice);
}

/** Envoie une carte de test dans le salon d'une catégorie. @returns {Promise<string>} statut */
async function sendTest(client, guild, key, actor) {
  const cfg = full(client, guild.id);
  const channel = cfg.logChannels?.[key] ? guild.channels.cache.get(cfg.logChannels[key]) : null;
  if (!channel) return cfg.logChannels?.[key] ? 'missing' : 'unset';
  const meta = LOG_CATEGORIES[key];
  try {
    await channel.send({
      embeds: [
        card({
          tone: 'info',
          section: { emoji: meta.emoji, label: `Logs · ${meta.label}` },
          icon: '🧪',
          title: 'Log de test',
          description: `Ce salon reçoit bien les logs **${meta.label}**.`,
          fields: [field(ICONS.user, 'Demandé par', `${actor}`), field(ICONS.count, 'Événements actifs', `${enabledEvents(cfg, key).length}`)],
        }),
      ],
    });
    return 'ok';
  } catch {
    return 'noperm';
  }
}

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  render,
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Ouvre le tableau de bord des logs : salons, événements, création automatique.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:logs:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** Interrupteur global. */
    async toggle(interaction, client) {
      guard(interaction);
      const on = full(client, interaction.guildId).logs?.enabled !== false;
      client.services.config.update(interaction.guildId, { logs: { enabled: !on } });
      await interaction.update(render(client, interaction.guild, 'home', `${ICONS.success} Logs ${on ? 'mis en pause' : 'réactivés'}.`));
    },
    /** cmd:logs:channel:<catégorie> — sélecteur de salon. */
    async channel(interaction, client, [key]) {
      guard(interaction);
      if (!LOG_CATEGORIES[key]) throw new UserError('Catégorie de logs inconnue.');
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!/^\d{17,20}$/.test(id)) throw new UserError('Salon invalide.');
        const ch = interaction.guild.channels.cache.get(id);
        if (!ch || !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel du serveur.');
      }
      client.services.config.update(interaction.guildId, { logChannels: { [key]: id } });
      const status = client.services.logging.channelStatus(interaction.guild, id);
      const notice = !id
        ? `${ICONS.success} Catégorie **${LOG_CATEGORIES[key].label}** débranchée.`
        : status === 'noperm'
          ? `${ICONS.warning} Salon enregistré, mais je ne peux pas y écrire : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`
          : `${ICONS.success} Logs **${LOG_CATEGORIES[key].label}** → <#${id}>.`;
      await interaction.update(categoryView(client, interaction.guild, key, notice));
    },
    /** cmd:logs:events:<catégorie> — événements journalisés (remplace la sélection). */
    async events(interaction, client, [key]) {
      guard(interaction);
      const meta = LOG_CATEGORIES[key];
      if (!meta) throw new UserError('Catégorie de logs inconnue.');
      const all = Object.keys(meta.events);
      const chosen = new Set((interaction.values ?? []).filter((e) => all.includes(e)));
      const others = (full(client, interaction.guildId).logs?.disabledEvents ?? []).filter((e) => !all.includes(e));
      client.services.config.update(interaction.guildId, { logs: { disabledEvents: [...others, ...all.filter((e) => !chosen.has(e))] } });
      await interaction.update(categoryView(client, interaction.guild, key, `${ICONS.success} ${chosen.size} événement(s) journalisé(s) sur ${all.length}.`));
    },
    /** cmd:logs:pause:<catégorie> */
    async pause(interaction, client, [key]) {
      guard(interaction);
      if (!LOG_CATEGORIES[key]) throw new UserError('Catégorie de logs inconnue.');
      const set = new Set(full(client, interaction.guildId).logs?.disabledCategories ?? []);
      const paused = !set.has(key);
      paused ? set.add(key) : set.delete(key);
      client.services.config.update(interaction.guildId, { logs: { disabledCategories: [...set] } });
      await interaction.update(categoryView(client, interaction.guild, key, `${ICONS.success} Catégorie ${paused ? 'mise en pause (le salon est conservé)' : 'réactivée'}.`));
    },
    /** cmd:logs:test:<catégorie|all> */
    async test(interaction, client, [key]) {
      guard(interaction);
      const keys = key === 'all' ? CATEGORY_KEYS.filter((k) => full(client, interaction.guildId).logChannels?.[k]) : [key];
      if (key !== 'all' && !LOG_CATEGORIES[key]) throw new UserError('Catégorie de logs inconnue.');
      if (!keys.length) throw new UserError('Aucun salon de logs configuré. Utilisez la création automatique ⚡.');
      await interaction.deferUpdate();
      const results = [];
      for (const k of keys) results.push([k, await sendTest(client, interaction.guild, k, interaction.user)]);
      const notice = results.map(([k, s]) => `${s === 'ok' ? ICONS.success : ICONS.error} ${LOG_CATEGORIES[k].emoji} ${LOG_CATEGORIES[k].label} : ${s === 'ok' ? 'reçu' : STATUS[s][1].toLowerCase()}`).join('\n');
      await interaction.editReply(render(client, interaction.guild, key === 'all' ? 'home' : `cat:${key}`, `🧪 **Test des logs**\n${notice}`));
    },
    /** Disposition de la création automatique. */
    async layout(interaction, client) {
      guard(interaction);
      const layout = interaction.values?.[0];
      if (!LAYOUTS[layout]) throw new UserError('Disposition inconnue.');
      client.services.config.update(interaction.guildId, { logs: { setup: { layout } } });
      await interaction.update(setupView(client, interaction.guild));
    },
    /** Catégories de la création automatique. */
    async setupcats(interaction, client) {
      guard(interaction);
      const categories = (interaction.values ?? []).filter((c) => CATEGORY_KEYS.includes(c));
      client.services.config.update(interaction.guildId, { logs: { setup: { categories } } });
      await interaction.update(setupView(client, interaction.guild));
    },
    /** Rôle staff (lecture des salons créés). */
    async staff(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id && (!/^\d{17,20}$/.test(id) || id === interaction.guildId)) throw new UserError('Choisissez un rôle staff (pas @everyone).');
      client.services.config.update(interaction.guildId, { logs: { staffRoleId: id } });
      await interaction.update(setupView(client, interaction.guild));
    },
    /** Création des salons. */
    async create(interaction, client) {
      guard(interaction);
      const cfg = full(client, interaction.guildId).logs;
      await interaction.deferUpdate();
      const result = await client.services.logSetup.create(interaction.guild, {
        layout: cfg.setup?.layout,
        categories: cfg.setup?.categories ?? CATEGORY_KEYS,
        staffRoleId: cfg.staffRoleId,
        reason: `Salons de logs créés par ${interaction.user.tag}`,
      });
      const notice = [
        `${ICONS.success} **Salons de logs prêts** dans ${result.category}.`,
        result.created.length ? `🆕 Créés : ${result.created.map((c) => `${c}`).join(' ')}` : null,
        result.reused.length ? `♻️ Réutilisés : ${result.reused.map((c) => `${c}`).join(' ')}` : null,
      ].filter(Boolean).join('\n');
      await interaction.editReply(render(client, interaction.guild, 'home', notice));
    },
    /** Réparation : recrée les salons supprimés et rétablit les permissions des salons du bot. */
    async repair(interaction, client) {
      guard(interaction);
      const cfg = full(client, interaction.guildId).logs;
      const categories = repairable(client, interaction.guild);
      if (!categories.length) {
        await interaction.update(render(client, interaction.guild, 'home', `${ICONS.success} Rien à réparer.`));
        return;
      }
      await interaction.deferUpdate();
      const result = await client.services.logSetup.create(interaction.guild, {
        layout: cfg.setup?.layout,
        categories,
        staffRoleId: cfg.staffRoleId,
        reason: `Salons de logs réparés par ${interaction.user.tag}`,
      });
      const notice = `🛠️ **${categories.length}** catégorie(s) réparée(s)${result.created.length ? ` · ${result.created.length} salon(s) recréé(s)` : ''}.`;
      await interaction.editReply(render(client, interaction.guild, 'home', notice));
    },
    /** Suppression (après confirmation) des salons créés par le bot. */
    async remove(interaction, client) {
      guard(interaction);
      await interaction.deferUpdate();
      const n = await client.services.logSetup.remove(interaction.guild, `Salons de logs supprimés par ${interaction.user.tag}`);
      await interaction.editReply(render(client, interaction.guild, 'setup', `${ICONS.success} ${n} salon(s) de logs supprimé(s).`));
    },
    /** Salons ignorés (remplace la liste). */
    async ignore(interaction, client) {
      guard(interaction);
      const ids = (interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id)).slice(0, MAX_IGNORED);
      client.services.config.update(interaction.guildId, { logs: { ignoredChannels: ids } });
      await interaction.update(optionsView(client, interaction.guild, `${ICONS.success} ${ids.length} salon(s) ignoré(s).`));
    },
    /** Messages des bots : ignorés / journalisés. */
    async bots(interaction, client) {
      guard(interaction);
      const ignore = full(client, interaction.guildId).logs?.ignoreBots !== false;
      client.services.config.update(interaction.guildId, { logs: { ignoreBots: !ignore } });
      await interaction.update(optionsView(client, interaction.guild, `${ICONS.success} Messages des bots ${ignore ? 'journalisés' : 'ignorés'}.`));
    },
  },
};
