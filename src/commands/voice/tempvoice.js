'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { card, field, wide, ICONS, code, subtext, bullets, status, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { parentOverwrites } = require('../../services/TempVoiceService');
const tv = require('../../utils/tempVoice');
const { UserError } = require('../../core/errors');

/**
 * /tempvoice : configuration des vocaux temporaires (statut + tableau de bord éphémère)
 * ET panneau de contrôle posté dans le chat de chaque vocal temporaire.
 *
 * Tableau de bord (« Gérer les salons ») — vues : home · salons · defaults
 * Panneau (propriétaire ou modérateur) : lock · hide · rename · limit · claim · kick ·
 *   ban · permit · transfer · bitrate · region
 */

function assertManageChannels(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserError('Il faut la permission **Gérer les salons** pour configurer les vocaux temporaires.');
  }
}
const guard = assertManageChannels;
const tvConfig = (client, guildId) => client.services.config.get(guildId).tempVoice ?? {};
const SNOWFLAKE = /^\d{17,20}$/;
/** Permissions dont le bot a besoin (au niveau du serveur) pour gérer les vocaux. */
const BOT_NEEDS = [
  [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
  [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
  [PermissionFlagsBits.MoveMembers, 'Déplacer des membres'],
];

// ================================================================ statut

/** Panneau d'état du système de vocaux temporaires (+ boutons). */
function statusPanel(client, guild, { notice } = {}) {
  const cfg = tvConfig(client, guild.id);
  const active = client.services.tempVoice.listByGuild?.(guild.id) ?? [];
  const hubOk = cfg.hubChannelId && guild.channels.cache.has(cfg.hubChannelId);
  const enabled = Boolean(cfg.enabled && cfg.hubChannelId);
  const shown = active.slice(0, 10).map((r) => `<#${r.channel_id}> · <@${r.owner_id}>`);
  return {
    embeds: [
      card({
        tone: enabled ? (hubOk ? 'info' : 'warning') : 'neutral',
        section: 'voice',
        icon: ICONS.voice,
        title: 'Vocaux temporaires',
        description: [
          notice ?? null,
          enabled
            ? `Rejoignez ${hubOk ? `<#${cfg.hubChannelId}>` : 'le salon hub'} pour créer automatiquement votre propre vocal, supprimé dès qu'il est vide.`
            : 'Le système est **désactivé**. Configurez-le avec `/tempvoice setup` ou `/tempvoice config`.',
          enabled && !hubOk ? `${ICONS.warning} Le salon hub configuré est introuvable : relancez \`/tempvoice setup\`.` : null,
        ],
        fields: [
          field(ICONS.status, 'État', enabled ? '🟢 Activé' : '⚫ Désactivé'),
          field(ICONS.voice, 'Hub', cfg.hubChannelId ? `<#${cfg.hubChannelId}>` : '—'),
          field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Celle du hub*'),
          field(ICONS.tag, 'Nom des salons', code(cfg.nameTemplate || tv.DEFAULT_TEMPLATE)),
          field(ICONS.count, 'Vocaux actifs', `**${active.length}**`),
          active.length ? wide(ICONS.list, 'En cours', `${bullets(shown)}${active.length > 10 ? `\n${subtext(`+${active.length - 10} autre(s)`)}` : ''}`) : null,
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'tempvoice', action: 'refresh', label: 'Actualiser', emoji: ICONS.refresh }),
      cfg.hubChannelId
        ? actionButton({
            command: 'tempvoice',
            action: 'toggle',
            label: enabled ? 'Désactiver' : 'Activer',
            emoji: enabled ? '⏸️' : '▶️',
            style: enabled ? ButtonStyle.Danger : ButtonStyle.Success,
          })
        : null,
    ),
  };
}

// ================================================================ tableau de bord

const SECTION = { emoji: ICONS.voice, label: 'Vocaux temporaires' };

function navRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:tempvoice:nav')
      .setPlaceholder('Aller à…')
      .addOptions(
        { value: 'home', label: 'Accueil', emoji: '🏠', description: 'État du système et vocaux en cours', default: current === 'home' },
        { value: 'salons', label: 'Salon créateur et catégorie', emoji: ICONS.voice, description: 'Où rejoindre et où créer les vocaux', default: current === 'salons' },
        { value: 'defaults', label: 'Réglages par défaut', emoji: ICONS.settings, description: 'Nom, limite, préférences, panneau', default: current === 'defaults' },
      ),
  );
}

const homeButton = () => actionButton({ command: 'tempvoice', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

function hubState(guild, cfg) {
  if (!cfg.hubChannelId) return 'unset';
  return guild.channels?.cache?.get(cfg.hubChannelId)?.type === ChannelType.GuildVoice ? 'ok' : 'missing';
}

function missingBotPermissions(guild) {
  const perms = guild.members?.me?.permissions;
  if (!perms?.has) return [];
  return BOT_NEEDS.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
}

function sampleName(client, guild, cfg) {
  return tv.defaultName(cfg.nameTemplate || tv.DEFAULT_TEMPLATE, { pseudo: 'Bob', username: 'bob', n: 1 }, client.services.config.get(guild.id));
}

function homeView(client, guild, notice) {
  const cfg = tvConfig(client, guild.id);
  const hub = hubState(guild, cfg);
  const enabled = Boolean(cfg.enabled && cfg.hubChannelId);
  const active = client.services.tempVoice.listByGuild?.(guild.id) ?? [];
  const missing = missingBotPermissions(guild);
  const prefs = client.services.tempVoice.tempVoice?.countPrefs?.(guild.id) ?? 0;
  const shown = active.slice(0, 10).map((r) => `<#${r.channel_id}> · <@${r.owner_id}>${r.locked ? ` ${ICONS.lock}` : ''}${r.hidden ? ` ${ICONS.hidden}` : ''}`);
  return {
    embeds: [
      card({
        tone: !enabled ? 'neutral' : hub !== 'ok' || missing.length ? 'warning' : 'success',
        section: SECTION,
        icon: ICONS.voice,
        title: 'Vocaux temporaires · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          enabled ? '🟢 Les vocaux temporaires sont **actifs**.' : '🔴 Les vocaux temporaires sont **désactivés**.',
          hub === 'ok'
            ? `Rejoindre <#${cfg.hubChannelId}> crée un vocal personnel, avec un **panneau de contrôle** pour son propriétaire. Il est supprimé dès qu'il est vide.`
            : hub === 'missing'
              ? `${ICONS.warning} Le salon créateur a été supprimé : choisissez-en un autre ou créez-le automatiquement.`
              : `${ICONS.info} Choisissez un **salon créateur** (ou créez-le automatiquement) pour commencer.`,
          missing.length ? `${ICONS.warning} Il me manque : ${missing.map((p) => `**${p}**`).join(', ')}.` : null,
        ],
        fields: [
          field(ICONS.voice, 'Salon créateur', cfg.hubChannelId ? `<#${cfg.hubChannelId}>` : '*Aucun*'),
          field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Celle du salon créateur*'),
          field(ICONS.tag, 'Nom par défaut', `${code(cfg.nameTemplate || tv.DEFAULT_TEMPLATE)}\n${subtext(`ex. : ${sampleName(client, guild, cfg)}`)}`),
          field(ICONS.members, 'Limite par défaut', cfg.defaultLimit ? `**${cfg.defaultLimit}** places` : 'Illimitée'),
          field('💾', 'Préférences', cfg.rememberPrefs !== false ? `Mémorisées (${prefs})` : 'Non mémorisées'),
          field('🎛️', 'Panneau de contrôle', cfg.panel !== false ? 'Activé' : 'Désactivé'),
          wide(ICONS.list, `Vocaux en cours (${active.length})`, active.length ? `${bullets(shown)}${active.length > 10 ? `\n${subtext(`+${active.length - 10} autre(s)`)}` : ''}` : '*Aucun*'),
        ],
        footer: 'Choisissez une section dans le menu',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        enabled
          ? actionButton({ command: 'tempvoice', action: 'power', args: ['off'], label: 'Désactiver', emoji: '⏸️', style: ButtonStyle.Danger })
          : actionButton({ command: 'tempvoice', action: 'power', args: ['on'], label: 'Activer', emoji: '▶️', style: ButtonStyle.Success, disabled: hub !== 'ok' }),
        hub !== 'ok' ? actionButton({ command: 'tempvoice', action: 'createhub', label: 'Créer le salon créateur', emoji: '⚡', style: ButtonStyle.Primary }) : null,
        actionButton({ command: 'tempvoice', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function salonsView(client, guild, notice) {
  const cfg = tvConfig(client, guild.id);
  const hub = hubState(guild, cfg);
  const hubMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:tempvoice:hub')
    .setPlaceholder('Salon vocal « créateur »…')
    .setChannelTypes(ChannelType.GuildVoice)
    .setMinValues(1)
    .setMaxValues(1);
  if (hub === 'ok') hubMenu.setDefaultChannels(cfg.hubChannelId);
  const catMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:tempvoice:category')
    .setPlaceholder('Catégorie des vocaux (vide : celle du salon créateur)')
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(0)
    .setMaxValues(1);
  if (cfg.categoryId && guild.channels?.cache?.has(cfg.categoryId)) catMenu.setDefaultChannels(cfg.categoryId);
  return {
    embeds: [
      card({
        tone: hub === 'ok' ? 'info' : 'warning',
        section: SECTION,
        icon: ICONS.voice,
        title: 'Salon créateur et catégorie',
        description: [
          notice ? `${notice}\n` : null,
          'Les membres rejoignent le **salon créateur** : un vocal personnel est créé dans la **catégorie** choisie et ils y sont déplacés.',
          `${ICONS.info} Les vocaux reprennent les permissions de la catégorie : une catégorie privée reste privée.`,
        ],
        fields: [
          field(ICONS.voice, 'Salon créateur', cfg.hubChannelId ? `<#${cfg.hubChannelId}>${hub === 'missing' ? '\n*introuvable*' : ''}` : '*Aucun*'),
          field(ICONS.category, 'Catégorie', cfg.categoryId ? `<#${cfg.categoryId}>` : '*Celle du salon créateur*'),
        ],
        footer: '⚡ crée un salon « ➕ Créer un vocal » dans la catégorie choisie',
      }),
    ],
    components: [
      navRow('salons'),
      new ActionRowBuilder().addComponents(hubMenu),
      new ActionRowBuilder().addComponents(catMenu),
      ...buttonRows(
        actionButton({ command: 'tempvoice', action: 'createhub', label: 'Créer le salon créateur', emoji: '⚡', style: ButtonStyle.Primary }),
        homeButton(),
      ),
    ],
  };
}

function defaultsView(client, guild, notice) {
  const cfg = tvConfig(client, guild.id);
  const remember = cfg.rememberPrefs !== false;
  const panel = cfg.panel !== false;
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.settings,
        title: 'Réglages par défaut',
        description: [
          notice ? `${notice}\n` : null,
          'Réglages appliqués à chaque nouveau vocal. Les noms passent par le filtre de **mots interdits** de l\'AutoMod s\'il est actif.',
          '',
          '**Variables du nom**',
          bullets([`${code('{pseudo}')} pseudo du membre sur le serveur`, `${code('{username}')} nom d'utilisateur`, `${code('{n}')} numéro du vocal`]),
        ],
        fields: [
          field(ICONS.tag, 'Nom par défaut', `${code(cfg.nameTemplate || tv.DEFAULT_TEMPLATE)}\n${subtext(`ex. : ${sampleName(client, guild, cfg)}`)}`),
          field(ICONS.members, 'Limite par défaut', cfg.defaultLimit ? `**${cfg.defaultLimit}** places` : 'Illimitée'),
          field('💾', 'Préférences', remember ? 'Mémorisées' : 'Non mémorisées'),
          field('🎛️', 'Panneau de contrôle', panel ? 'Activé' : 'Désactivé'),
          wide('💡', 'Préférences mémorisées', 'Le **nom**, la **limite** et le **verrou** choisis par un propriétaire sont réappliqués à ses prochains vocaux.'),
        ],
      }),
    ],
    components: [
      navRow('defaults'),
      ...buttonRows(
        actionButton({ command: 'tempvoice', action: 'name', label: 'Nom par défaut', emoji: '✏️', style: ButtonStyle.Primary }),
        actionButton({ command: 'tempvoice', action: 'deflimit', label: 'Limite par défaut', emoji: ICONS.members }),
        actionButton({ command: 'tempvoice', action: 'remember', args: [remember ? 'off' : 'on'], label: remember ? 'Oublier les préférences' : 'Mémoriser les préférences', emoji: '💾' }),
        actionButton({ command: 'tempvoice', action: 'panelopt', args: [panel ? 'off' : 'on'], label: panel ? 'Désactiver le panneau' : 'Activer le panneau', emoji: '🎛️' }),
        homeButton(),
      ),
    ],
  };
}

function render(client, guild, view = 'home', notice) {
  const name = String(view).split(/[:.]/)[0];
  if (name === 'salons') return salonsView(client, guild, notice);
  if (name === 'defaults') return defaultsView(client, guild, notice);
  return homeView(client, guild, notice);
}

// ================================================================ formulaires

function input(id, label, { value, placeholder, max = 100, required = true } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(required);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
}

const renameModal = (current) =>
  new ModalBuilder().setCustomId('cmd:tempvoice:renamesubmit').setTitle('Renommer le vocal').addComponents(input('name', 'Nouveau nom du salon', { value: current, max: tv.NAME_MAX }));
const limitModal = (current) =>
  new ModalBuilder().setCustomId('cmd:tempvoice:limitsubmit').setTitle('Limite de places').addComponents(input('limit', 'Places (0 = illimité, 99 maximum)', { value: current ?? 0, max: 2 }));
const nameModal = (current) =>
  new ModalBuilder()
    .setCustomId('cmd:tempvoice:namesubmit')
    .setTitle('Nom par défaut des vocaux')
    .addComponents(input('template', 'Modèle ({pseudo}, {username}, {n})', { value: current, max: 80, placeholder: tv.DEFAULT_TEMPLATE }));
const defLimitModal = (current) =>
  new ModalBuilder().setCustomId('cmd:tempvoice:deflimitsubmit').setTitle('Limite par défaut').addComponents(input('limit', 'Places (0 = illimité, 99 maximum)', { value: current ?? 0, max: 2 }));

function textField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id) ?? '';
  } catch {
    return '';
  }
}

/** Valeur cible d'un interrupteur (jamais d'inversion à l'aveugle). */
function target(value) {
  if (value !== 'on' && value !== 'off') throw new UserError('Ce bouton est invalide.');
  return value === 'on';
}

// ================================================================ panneau : contrôles

/** Permissions du membre AU NIVEAU DU SERVEUR (les overwrites du vocal ne comptent pas). */
function guildPermissions(interaction) {
  const m = interaction.member;
  if (m?.permissions instanceof PermissionsBitField && m.guild) return m.permissions;
  const cached = interaction.guild?.members?.cache?.get(interaction.user?.id);
  return cached?.permissions ?? null;
}

/** Modérateur : peut gérer tous les vocaux temporaires. */
function isStaff(interaction) {
  const perms = guildPermissions(interaction);
  return Boolean(perms?.has?.(PermissionFlagsBits.MoveMembers) || perms?.has?.(PermissionFlagsBits.ManageChannels));
}

/** Vocal temporaire du panneau (le chat du vocal = le salon de l'interaction). */
function panelContext(interaction, client) {
  const service = client.services?.tempVoice;
  const channel = interaction.guild?.channels?.cache?.get(interaction.channelId) ?? null;
  const record = channel && service?.record ? service.record(channel.id) : null;
  if (!record) throw new UserError('Ce panneau ne correspond plus à un vocal temporaire actif.');
  return { service, channel, record, staff: isStaff(interaction) };
}

/** Propriétaire ou modérateur, sinon refus (éphémère). */
function controlContext(interaction, client) {
  const ctx = panelContext(interaction, client);
  if (ctx.record.owner_id !== interaction.user.id && !ctx.staff) {
    throw new UserError(`Seul le propriétaire de ce vocal (<@${ctx.record.owner_id}>) ou un modérateur peut faire cela.`);
  }
  return ctx;
}

/** Valeurs d'un menu de membres (snowflakes uniquement). */
function pickedIds(interaction, max = 10) {
  const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id)).slice(0, max);
  if (!ids.length) throw new UserError('Choisissez au moins un membre.');
  return ids;
}

const mentions = (ids) => ids.map((id) => `<@${id}>`).join(', ');

/** Réponse au menu éphémère + mise à jour du panneau du salon. */
async function settlePicker(interaction, ctx, message, notice) {
  await interaction.editReply({ embeds: [status.ok(message)], components: [] });
  await ctx.service.refreshPanel(ctx.channel, notice).catch(() => {});
}

function userPicker(action, placeholder, max) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(`cmd:tempvoice:${action}`).setPlaceholder(placeholder).setMinValues(1).setMaxValues(max),
  );
}

// ================================================================ commande

module.exports = {
  category: 'voice',
  cooldown: 3_000,
  botPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MoveMembers],
  statusPanel,
  render,
  data: new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Configure les salons vocaux temporaires (join-to-create).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Active le système avec un salon hub.')
        .addChannelOption((o) => o.setName('hub').setDescription('Salon vocal "Créer un vocal"').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie où créer les vocaux').addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((s) => s.setName('config').setDescription('Ouvre le tableau de bord : salon créateur, catégorie, nom et limite par défaut.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive les vocaux temporaires.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du système.')),

  async execute(interaction, client) {
    guard(interaction);
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'config') {
      return interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
    }
    if (sub === 'setup') {
      const hub = interaction.options.getChannel('hub');
      const category = interaction.options.getChannel('categorie');
      config.update(guildId, { tempVoice: { enabled: true, hubChannelId: hub.id, categoryId: category?.id ?? null } });
      return interaction.reply({
        ...statusPanel(client, interaction.guild, { notice: `${ICONS.success} **Vocaux temporaires activés.**` }),
        ephemeral: true,
      });
    }
    if (sub === 'disable') {
      config.update(guildId, { tempVoice: { enabled: false } });
      return interaction.reply({
        ...statusPanel(client, interaction.guild, { notice: `${ICONS.info} **Vocaux temporaires désactivés.** Les vocaux existants restent jusqu'à ce qu'ils se vident.` }),
        ephemeral: true,
      });
    }
    return interaction.reply({ ...statusPanel(client, interaction.guild), ephemeral: true });
  },

  buttons: {
    // ------------------------------------------------------------ statut

    /** cmd:tempvoice:refresh — réaffiche l'état. */
    async refresh(interaction, client) {
      guard(interaction);
      await interaction.update(statusPanel(client, interaction.guild));
    },
    /** cmd:tempvoice:toggle — active/désactive (ancien panneau d'état, hub déjà configuré). */
    async toggle(interaction, client) {
      guard(interaction);
      const { config } = client.services;
      const cfg = tvConfig(client, interaction.guildId);
      if (!cfg.hubChannelId) throw new UserError('Aucun salon hub configuré : utilisez `/tempvoice setup`.');
      const enabled = !cfg.enabled;
      config.update(interaction.guildId, { tempVoice: { enabled } });
      await interaction.update(
        statusPanel(client, interaction.guild, { notice: enabled ? `${ICONS.success} **Vocaux temporaires activés.**` : `${ICONS.info} **Vocaux temporaires désactivés.**` }),
      );
    },

    // ------------------------------------------------------------ tableau de bord

    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:tempvoice:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** cmd:tempvoice:power:<on|off> */
    async power(interaction, client, [value]) {
      guard(interaction);
      const enabled = target(value);
      if (enabled && hubState(interaction.guild, tvConfig(client, interaction.guildId)) !== 'ok') throw new UserError('Choisissez d\'abord un salon créateur.');
      client.services.config.update(interaction.guildId, { tempVoice: { enabled } });
      await interaction.update(render(client, interaction.guild, 'home', enabled ? `${ICONS.success} Vocaux temporaires **activés**.` : `${ICONS.info} Vocaux temporaires **désactivés** (les vocaux existants restent jusqu'à ce qu'ils se vident).`));
    },
    /** Sélecteur du salon créateur. */
    async hub(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!SNOWFLAKE.test(id ?? '')) throw new UserError('Salon invalide.');
      const channel = interaction.guild.channels.cache.get(id);
      if (channel?.type !== ChannelType.GuildVoice) throw new UserError('Choisissez un salon vocal du serveur.');
      if (client.services.tempVoice.record?.(id)) throw new UserError('Un vocal temporaire ne peut pas servir de salon créateur.');
      const cfg = tvConfig(client, interaction.guildId);
      client.services.config.update(interaction.guildId, { tempVoice: { hubChannelId: id, enabled: cfg.hubChannelId ? Boolean(cfg.enabled) : true } });
      await interaction.update(salonsView(client, interaction.guild, `${ICONS.success} Salon créateur : <#${id}>.`));
    },
    /** Sélecteur de la catégorie (vide : celle du salon créateur). */
    async category(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!SNOWFLAKE.test(id)) throw new UserError('Catégorie invalide.');
        if (interaction.guild.channels.cache.get(id)?.type !== ChannelType.GuildCategory) throw new UserError('Choisissez une catégorie du serveur.');
      }
      client.services.config.update(interaction.guildId, { tempVoice: { categoryId: id } });
      await interaction.update(salonsView(client, interaction.guild, id ? `${ICONS.success} Les vocaux seront créés dans <#${id}>.` : `${ICONS.success} Les vocaux seront créés dans la catégorie du salon créateur.`));
    },
    /** Crée le salon « ➕ Créer un vocal » (permissions de la catégorie conservées). */
    async createhub(interaction, client) {
      guard(interaction);
      const cfg = tvConfig(client, interaction.guildId);
      const guild = interaction.guild;
      const parent = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? guild.channels.cache.get(cfg.categoryId) : null;
      await interaction.deferUpdate();
      const channel = await guild.channels.create({
        name: '➕ Créer un vocal',
        type: ChannelType.GuildVoice,
        parent: parent?.id ?? null,
        permissionOverwrites: parentOverwrites(parent),
        reason: `Salon créateur des vocaux temporaires (par ${interaction.user.tag ?? interaction.user.id})`,
      });
      client.services.config.update(interaction.guildId, { tempVoice: { hubChannelId: channel.id, enabled: true } });
      await interaction.editReply(render(client, guild, 'home', `${ICONS.success} Salon créateur ${channel} créé : les vocaux temporaires sont **actifs**.`));
    },
    /** cmd:tempvoice:name — formulaire du nom par défaut. */
    async name(interaction, client) {
      guard(interaction);
      await interaction.showModal(nameModal(tvConfig(client, interaction.guildId).nameTemplate || tv.DEFAULT_TEMPLATE));
    },
    async namesubmit(interaction, client) {
      guard(interaction);
      const template = tv.assertName(textField(interaction, 'template'), client.services.config.get(interaction.guildId));
      if (tv.formatName(template, { pseudo: 'x'.repeat(32), username: 'x'.repeat(32), n: 999 }).length > tv.NAME_MAX) {
        throw new UserError(`Ce modèle peut dépasser **${tv.NAME_MAX}** caractères une fois rempli : raccourcissez-le.`);
      }
      client.services.config.update(interaction.guildId, { tempVoice: { nameTemplate: template } });
      await interaction.update(defaultsView(client, interaction.guild, `${ICONS.success} Nom par défaut : ${code(template)}.`));
    },
    /** cmd:tempvoice:deflimit — formulaire de la limite par défaut. */
    async deflimit(interaction, client) {
      guard(interaction);
      await interaction.showModal(defLimitModal(tvConfig(client, interaction.guildId).defaultLimit));
    },
    async deflimitsubmit(interaction, client) {
      guard(interaction);
      const limit = tv.parseLimit(textField(interaction, 'limit'));
      client.services.config.update(interaction.guildId, { tempVoice: { defaultLimit: limit } });
      await interaction.update(defaultsView(client, interaction.guild, `${ICONS.success} Limite par défaut : **${limit ? `${limit} places` : 'illimitée'}**.`));
    },
    /** cmd:tempvoice:remember:<on|off> */
    async remember(interaction, client, [value]) {
      guard(interaction);
      const on = target(value);
      client.services.config.update(interaction.guildId, { tempVoice: { rememberPrefs: on } });
      await interaction.update(defaultsView(client, interaction.guild, on ? `${ICONS.success} Les préférences des propriétaires seront **mémorisées**.` : `${ICONS.info} Les préférences ne sont plus **ni mémorisées ni réappliquées**.`));
    },
    /** cmd:tempvoice:panelopt:<on|off> */
    async panelopt(interaction, client, [value]) {
      guard(interaction);
      const on = target(value);
      client.services.config.update(interaction.guildId, { tempVoice: { panel: on } });
      await interaction.update(defaultsView(client, interaction.guild, on ? `${ICONS.success} Panneau de contrôle **activé** pour les prochains vocaux.` : `${ICONS.info} Panneau de contrôle **désactivé** pour les prochains vocaux.`));
    },

    // ------------------------------------------------------------ panneau du vocal

    /** cmd:tempvoice:lock:<on|off> */
    async lock(interaction, client, [value]) {
      const ctx = controlContext(interaction, client);
      const on = target(value);
      await interaction.deferUpdate();
      await ctx.service.setAccess(ctx.channel, 'lock', on, interaction.user.id);
      await interaction.editReply(ctx.service.panel(ctx.channel, on ? `${ICONS.lock} Salon **verrouillé** par ${interaction.user} : les membres présents gardent l'accès.` : `${ICONS.unlock} Salon **déverrouillé** par ${interaction.user}.`));
    },
    /** cmd:tempvoice:hide:<on|off> */
    async hide(interaction, client, [value]) {
      const ctx = controlContext(interaction, client);
      const on = target(value);
      await interaction.deferUpdate();
      await ctx.service.setAccess(ctx.channel, 'hide', on, interaction.user.id);
      await interaction.editReply(ctx.service.panel(ctx.channel, on ? `${ICONS.hidden} Salon **masqué** par ${interaction.user}.` : `${ICONS.visible} Salon de nouveau **visible**.`));
    },
    async rename(interaction, client) {
      const ctx = controlContext(interaction, client);
      await interaction.showModal(renameModal(ctx.channel.name));
    },
    async renamesubmit(interaction, client) {
      const ctx = controlContext(interaction, client);
      // Validation avant tout appel lent : l'erreur s'affiche immédiatement en éphémère.
      tv.assertName(textField(interaction, 'name'), client.services.config.get(interaction.guildId));
      await interaction.deferUpdate();
      const { name, queued } = await ctx.service.rename(ctx.channel, textField(interaction, 'name'), interaction.user.id);
      const notice = queued
        ? `${ICONS.loading} Discord limite les renommages (${tv.RENAME_LIMIT} toutes les 10 minutes) : le nom **${name}** sera appliqué dès que possible.`
        : `✏️ Salon renommé en **${name}**.`;
      await interaction.editReply(ctx.service.panel(ctx.channel, notice));
    },
    async limit(interaction, client) {
      const ctx = controlContext(interaction, client);
      await interaction.showModal(limitModal(ctx.channel.userLimit));
    },
    async limitsubmit(interaction, client) {
      const ctx = controlContext(interaction, client);
      const limit = tv.parseLimit(textField(interaction, 'limit'));
      await interaction.deferUpdate();
      await ctx.service.setLimit(ctx.channel, limit, interaction.user.id);
      await interaction.editReply(ctx.service.panel(ctx.channel, `${ICONS.members} Limite : **${limit ? `${limit} places` : 'illimitée'}**.`));
    },
    /** Réclamer un salon dont le propriétaire est parti (tout membre connecté). */
    async claim(interaction, client) {
      const ctx = panelContext(interaction, client);
      if (ctx.record.owner_id === interaction.user.id) throw new UserError('Vous êtes déjà propriétaire de ce salon.');
      if (ctx.channel.members?.has?.(ctx.record.owner_id)) throw new UserError(`Le propriétaire <@${ctx.record.owner_id}> est toujours connecté : demandez-lui un transfert.`);
      if (!ctx.channel.members?.has?.(interaction.user.id)) throw new UserError('Rejoignez ce salon vocal pour pouvoir le réclamer.');
      await interaction.deferUpdate();
      await ctx.service.claim(ctx.channel, interaction.user.id);
      await interaction.editReply(ctx.service.panel(ctx.channel, `${ICONS.owner} ${interaction.user} a réclamé le salon et en est le nouveau propriétaire.`));
    },
    /** Expulser : menu des membres connectés. */
    async kick(interaction, client) {
      const ctx = controlContext(interaction, client);
      const members = [...(ctx.channel.members?.values?.() ?? [])].filter((m) => m.id !== interaction.user.id).slice(0, 25);
      if (!members.length) throw new UserError('Personne d\'autre n\'est connecté à ce salon.');
      await interaction.reply({
        embeds: [tv.pickerCard('Expulser du vocal', '🚪', 'Choisissez les membres à **déconnecter**. Ils pourront revenir, sauf si le salon est verrouillé.')],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('cmd:tempvoice:kicksel')
              .setPlaceholder('Membres à expulser…')
              .setMinValues(1)
              .setMaxValues(members.length)
              .addOptions(members.map((m) => ({ value: m.id, label: truncate(m.displayName ?? m.user?.username ?? m.id, 100), description: truncate(m.user?.username ?? m.id, 100), emoji: m.user?.bot ? ICONS.bot : ICONS.user }))),
          ),
        ],
        ephemeral: true,
      });
    },
    async kicksel(interaction, client) {
      const ctx = controlContext(interaction, client);
      const ids = pickedIds(interaction, 25);
      await interaction.deferUpdate();
      const { done, refused } = await ctx.service.kick(ctx.channel, ids, { actorId: interaction.user.id, staff: ctx.staff });
      if (!done.length) throw new UserError(refused.length ? 'Vous ne pouvez pas expulser ces membres (modérateurs ou propriétaire).' : 'Ces membres ne sont plus connectés.');
      await settlePicker(interaction, ctx, `${done.length} membre(s) expulsé(s) : ${mentions(done)}.${refused.length ? `\n${ICONS.warning} Ignoré(s) : ${mentions(refused)}.` : ''}`, `🚪 ${mentions(done)} expulsé(s) par ${interaction.user}.`);
    },
    /** Bannir du salon : menu des membres du serveur. */
    async ban(interaction, client) {
      controlContext(interaction, client);
      await interaction.reply({
        embeds: [tv.pickerCard('Bannir du vocal', ICONS.ban, 'Les membres choisis ne pourront plus **rejoindre** ce salon (ceux présents sont déconnectés). Utilisez ✅ **Autoriser** pour lever un bannissement.')],
        components: [userPicker('bansel', 'Membres à bannir du salon…', 10)],
        ephemeral: true,
      });
    },
    async bansel(interaction, client) {
      const ctx = controlContext(interaction, client);
      const ids = pickedIds(interaction);
      await interaction.deferUpdate();
      const { done, refused } = await ctx.service.ban(ctx.channel, ids, { actorId: interaction.user.id, staff: ctx.staff });
      if (!done.length) throw new UserError('Vous ne pouvez pas bannir ces membres (vous-même, le propriétaire, un modérateur ou moi).');
      await settlePicker(interaction, ctx, `${done.length} membre(s) banni(s) du salon : ${mentions(done)}.${refused.length ? `\n${ICONS.warning} Ignoré(s) : ${mentions(refused)}.` : ''}`, `${ICONS.ban} ${mentions(done)} banni(s) du salon par ${interaction.user}.`);
    },
    /** Autoriser : voir et rejoindre le salon, même verrouillé ou masqué. */
    async permit(interaction, client) {
      controlContext(interaction, client);
      await interaction.reply({
        embeds: [tv.pickerCard('Autoriser dans le vocal', ICONS.success, 'Les membres choisis pourront **voir et rejoindre** ce salon, même verrouillé ou masqué. Leur éventuel bannissement est levé.')],
        components: [userPicker('permitsel', 'Membres à autoriser…', 10)],
        ephemeral: true,
      });
    },
    async permitsel(interaction, client) {
      const ctx = controlContext(interaction, client);
      const ids = pickedIds(interaction);
      await interaction.deferUpdate();
      const { done } = await ctx.service.permit(ctx.channel, ids);
      if (!done.length) throw new UserError('Aucun membre valide.');
      await settlePicker(interaction, ctx, `${done.length} membre(s) autorisé(s) : ${mentions(done)}.`, `${ICONS.success} ${mentions(done)} autorisé(s) par ${interaction.user}.`);
    },
    /** Transférer la propriété à un membre connecté. */
    async transfer(interaction, client) {
      controlContext(interaction, client);
      await interaction.reply({
        embeds: [tv.pickerCard('Transférer la propriété', ICONS.owner, 'Choisissez le **nouveau propriétaire** : il doit être connecté à ce salon.')],
        components: [userPicker('transfersel', 'Nouveau propriétaire…', 1)],
        ephemeral: true,
      });
    },
    async transfersel(interaction, client) {
      const ctx = controlContext(interaction, client);
      const [id] = pickedIds(interaction, 1);
      if (id === ctx.record.owner_id) throw new UserError('Ce membre est déjà propriétaire du salon.');
      if (!ctx.channel.members?.has?.(id)) throw new UserError('Le nouveau propriétaire doit être connecté à ce salon.');
      await interaction.deferUpdate();
      await ctx.service.transfer(ctx.channel, id);
      await settlePicker(interaction, ctx, `<@${id}> est le nouveau propriétaire du salon.`, `${ICONS.owner} Propriété transférée à <@${id}> par ${interaction.user}.`);
    },
    /** Menu du débit (selon le niveau de boost). */
    async bitrate(interaction, client) {
      const ctx = controlContext(interaction, client);
      const kbps = Number(interaction.values?.[0]);
      if (!Number.isInteger(kbps)) throw new UserError('Débit invalide.');
      await interaction.deferUpdate();
      await ctx.service.setBitrate(ctx.channel, kbps);
      await interaction.editReply(ctx.service.panel(ctx.channel, `🎚️ Débit : **${kbps} kb/s**.`));
    },
    /** Menu de la région RTC. */
    async region(interaction, client) {
      const ctx = controlContext(interaction, client);
      const region = interaction.values?.[0] ?? 'auto';
      if (region !== 'auto' && !tv.REGION_IDS.has(region)) throw new UserError('Région inconnue.');
      await interaction.deferUpdate();
      await ctx.service.setRegion(ctx.channel, region);
      await interaction.editReply(ctx.service.panel(ctx.channel, `🌍 Région : **${tv.regionLabel(region === 'auto' ? null : region)}**.`));
    },
  },
};
