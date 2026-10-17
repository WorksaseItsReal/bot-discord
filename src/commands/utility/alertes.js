'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const { card, field, ICONS, subtext, bullets, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { fitList } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { PAUSE, MAX_BLOCKED } = require('../../services/HighlightService');
const { MIN_KEYWORD, MAX_KEYWORD, MAX_KEYWORDS } = require('../../utils/highlights');
const { UserError } = require('../../core/errors');

/**
 * /alertes : alertes de mots-clés en MP (chaque membre gère les siennes, réponses éphémères)
 *   ajouter · retirer · liste · pause · bloquer salon · bloquer membre
 * et /alertes config (« Gérer le serveur ») : activation par serveur des outils des
 * membres (absences /afk, alertes, snipe /snipe).
 * Les boutons et menus de la vue « liste » agissent toujours sur les alertes de CELUI qui
 * clique : aucun identifiant de membre n'est encodé dans les customId.
 */

const SECTION = { emoji: '🔔', label: 'Alertes' };
const CONFIG_SECTION = { emoji: '🧰', label: 'Outils des membres' };
const SNOWFLAKE = /^\d{17,20}$/;
/** Salons bloquables : tout salon du serveur (une catégorie bloque ses salons, un salon ses fils). */
const BLOCKABLE_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildCategory,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];
const row = (component) => new ActionRowBuilder().addComponents(component);
const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const hl = (client) => client.services.highlights;

/** Mot-clé saisi, affiché sans casser la mise en forme. */
const quote = (text) => `\`${truncate(String(text ?? '').replace(/`/g, 'ˋ'), 60)}\``;

/** Valeur voulue par un bouton « on/off ». */
function target(state) {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
}

function textField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id)?.trim() || null;
  } catch {
    return null;
  }
}

function assertEnabled(client, guildId) {
  if (!hl(client).enabled(guildId)) throw new UserError('Les alertes de mots-clés sont désactivées sur ce serveur.');
}

// ---------------------------------------------------------------- vue personnelle

function stateLine(entry) {
  if (entry.paused === PAUSE.auto) return '⏸️ **En pause automatique** : vos messages privés semblent fermés (3 envois refusés). Ouvrez-les puis cliquez sur « Reprendre ».';
  if (entry.paused) return '⏸️ Vos alertes sont **en pause**.';
  return '🟢 Vos alertes sont **actives**.';
}

/** Vue « liste » : mots-clés, blocages, pause (éphémère, propre au membre). */
function listView(client, guild, userId, notice = null) {
  const svc = hl(client);
  const entry = svc.entry(guild.id, userId);
  const enabled = svc.enabled(guild.id);
  const cache = guild.channels?.cache;
  const channels = entry.blockedChannels.filter((id) => !cache || cache.has(id)).slice(0, MAX_BLOCKED);
  const users = entry.blockedUsers.filter((id) => SNOWFLAKE.test(id)).slice(0, MAX_BLOCKED);

  const components = [];
  if (entry.words.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:alertes:remove')
        .setPlaceholder('Retirer un mot-clé…')
        .addOptions(entry.words.slice(0, MAX_KEYWORDS).map((w) => ({ value: w, label: truncate(w, 100), emoji: '🗑️' }))),
    ));
  }
  const chanMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:alertes:chans')
    .setPlaceholder('Salons bloqués (aucun)')
    .setChannelTypes(...BLOCKABLE_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_BLOCKED);
  if (channels.length) chanMenu.setDefaultChannels(...channels);
  const userMenu = new UserSelectMenuBuilder()
    .setCustomId('cmd:alertes:users')
    .setPlaceholder('Membres bloqués (aucun)')
    .setMinValues(0)
    .setMaxValues(MAX_BLOCKED);
  if (users.length) userMenu.setDefaultUsers(...users);
  components.push(row(chanMenu), row(userMenu));
  components.push(...buttonRows(
    actionButton({ command: 'alertes', action: 'add', label: 'Ajouter', emoji: '➕', style: ButtonStyle.Primary, disabled: !enabled || entry.words.length >= MAX_KEYWORDS }),
    entry.paused
      ? actionButton({ command: 'alertes', action: 'pause', args: ['off'], label: 'Reprendre', emoji: '▶️', style: ButtonStyle.Success })
      : actionButton({ command: 'alertes', action: 'pause', args: ['on'], label: 'Mettre en pause', emoji: '⏸️' }),
    actionButton({ command: 'alertes', action: 'view', label: 'Actualiser', emoji: ICONS.refresh }),
  ));

  return {
    embeds: [
      card({
        tone: !enabled || entry.paused ? 'neutral' : 'info',
        section: SECTION,
        icon: '🔔',
        title: 'Vos alertes de mots-clés',
        description: [
          notice ? `${notice}\n` : null,
          enabled ? stateLine(entry) : `${ICONS.warning} Les alertes sont **désactivées** sur ce serveur : vos mots-clés sont conservés.`,
          '',
          entry.words.length ? bullets(entry.words.map(quote)) : '*Aucun mot-clé : cliquez sur « Ajouter » ou utilisez /alertes ajouter.*',
          '',
          subtext(`Un message privé quand un autre membre écrit l'un de ces mots (mot entier, majuscules et accents ignorés) dans un salon que vous pouvez lire. Au plus une alerte toutes les 5 minutes par salon, aucune si vous y avez écrit dans les 5 dernières minutes.`),
        ],
        fields: [
          field(ICONS.count, 'Mots-clés', `${entry.words.length} / ${MAX_KEYWORDS}`),
          field('🚫', 'Salons bloqués', fitList(channels.map((id) => `<#${id}>`), 1000) ?? '*Aucun*'),
          field('🙈', 'Membres bloqués', fitList(users.map((id) => `<@${id}>`), 1000) ?? '*Aucun*'),
        ],
        footer: 'Bloquer une catégorie bloque ses salons ; les fils suivent leur salon',
        timestamp: false,
      }),
    ],
    components,
  };
}

function addModal() {
  return new ModalBuilder()
    .setCustomId('cmd:alertes:addsubmit')
    .setTitle('Nouveau mot-clé')
    .addComponents(row(
      new TextInputBuilder()
        .setCustomId('mot')
        .setLabel(`Mot-clé (${MIN_KEYWORD} à ${MAX_KEYWORD} caractères)`)
        .setStyle(TextInputStyle.Short)
        .setMinLength(MIN_KEYWORD)
        .setMaxLength(MAX_KEYWORD)
        .setRequired(true)
        .setPlaceholder('gadget'),
    ));
}

// ---------------------------------------------------------------- configuration du serveur

const FEATURES = {
  afk: { label: 'AFK', emoji: '💤', patch: (v) => ({ afk: { enabled: v } }), done: (v) => `Absences (/afk) **${v ? 'activées' : 'désactivées'}**.` },
  nick: { label: 'Pseudo [AFK]', emoji: '🏷️', patch: (v) => ({ afk: { nickname: v } }), done: (v) => `Préfixe « [AFK] » sur le pseudo **${v ? 'activé' : 'désactivé'}**.` },
  highlights: { label: 'Alertes', emoji: '🔔', patch: (v) => ({ highlights: { enabled: v } }), done: (v) => `Alertes de mots-clés **${v ? 'activées' : 'désactivées'}**.` },
  snipe: { label: 'Snipe', emoji: '🔎', patch: (v) => ({ snipe: { enabled: v } }), done: (v) => `Snipe **${v ? 'activé' : 'désactivé'}**${v ? '' : ' (mémoire vidée)'}.` },
};

function toolsOf(client, guildId) {
  const t = client.services.config.get(guildId).memberTools ?? {};
  return {
    afk: t.afk?.enabled !== false,
    nick: t.afk?.nickname !== false,
    highlights: t.highlights?.enabled !== false,
    snipe: t.snipe?.enabled !== false,
  };
}

const onOff = (on, yes = 'Actif', no = 'Désactivé') => (on ? `🟢 ${yes}` : `🔴 ${no}`);

/** Tableau de bord « Outils des membres » (éphémère, « Gérer le serveur »). */
function configView(client, guild, notice = null) {
  const on = toolsOf(client, guild.id);
  const stats = hl(client).stats(guild.id);
  const absent = client.services.afk.count(guild.id);
  const canNick = guild.members?.me?.permissions?.has(PermissionFlagsBits.ManageNicknames) ?? true;
  return {
    embeds: [
      card({
        tone: on.afk || on.highlights || on.snipe ? 'success' : 'neutral',
        section: CONFIG_SECTION,
        icon: ICONS.settings,
        title: 'Outils des membres · Configuration',
        description: [
          notice ? `${notice}\n` : null,
          `${on.afk ? '🟢' : '🔴'} **AFK** · /afk signale une absence ; ceux qui mentionnent le membre sont prévenus.`,
          `${on.highlights ? '🟢' : '🔴'} **Alertes** · /alertes envoie un MP quand un mot-clé est écrit.`,
          `${on.snipe ? '🟢' : '🔴'} **Snipe** · /snipe montre aux modérateurs le dernier message supprimé ou modifié (10 min).`,
          '',
          subtext('Désactiver l\'AFK ou les alertes conserve les données des membres (un membre absent revient toujours en écrivant) ; désactiver le snipe vide sa mémoire.'),
        ],
        fields: [
          field('💤', 'AFK', `${onOff(on.afk)}\n${subtext(`${absent} absent(s)`)}`),
          field('🏷️', 'Pseudo [AFK]', `${onOff(on.nick, 'Ajouté', 'Inchangé')}${on.nick && !canNick ? `\n${ICONS.warning} *Il me manque « Gérer les pseudos »*` : ''}`),
          field('🔔', 'Alertes', `${onOff(on.highlights)}\n${subtext(`${stats.members} membre(s) · ${stats.words} mot(s)-clé(s)`)}`),
          field('🔎', 'Snipe', `${onOff(on.snipe)}\n${subtext('« Gérer les messages » · salons ignorés des logs exclus')}`),
        ],
        footer: 'Chaque bouton active ou désactive une fonction',
        timestamp: false,
      }),
    ],
    components: buttonRows(
      ...Object.entries(FEATURES).map(([key, f]) => actionButton({ command: 'alertes', action: 'cfg', args: [key, on[key] ? 'off' : 'on'], label: `${f.label} ${on[key] ? '✅' : '❌'}`, emoji: f.emoji })),
      actionButton({ command: 'alertes', action: 'cfgview', label: 'Actualiser', emoji: ICONS.refresh }),
    ),
  };
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'utility',
  cooldown: 3_000,
  listView,
  configView,
  data: new SlashCommandBuilder()
    .setName('alertes')
    .setDescription('Alertes de mots-clés en message privé (et réglages des outils des membres).')
    .addSubcommand((s) => s.setName('ajouter').setDescription('Ajoute un mot-clé à surveiller (10 au plus).')
      .addStringOption((o) => o.setName('mot').setDescription(`Mot ou expression (${MIN_KEYWORD} à ${MAX_KEYWORD} caractères)`).setRequired(true).setMinLength(MIN_KEYWORD).setMaxLength(MAX_KEYWORD)))
    .addSubcommand((s) => s.setName('retirer').setDescription('Retire un de vos mots-clés.')
      .addStringOption((o) => o.setName('mot').setDescription('Mot-clé à retirer').setRequired(true).setMaxLength(MAX_KEYWORD).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Affiche et gère vos mots-clés et blocages.'))
    .addSubcommand((s) => s.setName('pause').setDescription('Met en pause ou reprend vos alertes.'))
    .addSubcommandGroup((g) => g.setName('bloquer').setDescription('Bloque ou débloque un salon ou un membre.')
      .addSubcommand((s) => s.setName('salon').setDescription('Plus d\'alerte venant de ce salon (relancer pour débloquer).')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon ou catégorie d\'où ne viendra plus aucune alerte').setRequired(true).addChannelTypes(...BLOCKABLE_TYPES)))
      .addSubcommand((s) => s.setName('membre').setDescription('Plus d\'alerte venant de ce membre (relancer pour débloquer).')
        .addUserOption((o) => o.setName('membre').setDescription('Membre dont les messages ne vous alerteront plus').setRequired(true))))
    .addSubcommand((s) => s.setName('config').setDescription('Active ou désactive l\'AFK, les alertes et le snipe (administrateurs).')),

  async autocomplete(interaction, client) {
    const focused = String(interaction.options.getFocused() ?? '').toLowerCase();
    const words = hl(client).entry(interaction.guildId, interaction.user.id).words;
    await interaction.respond(words.filter((w) => w.toLowerCase().includes(focused)).slice(0, 25).map((w) => ({ name: truncate(w, 100), value: w })));
  },

  async execute(interaction, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const { guild, user } = interaction;
    const svc = hl(client);
    const reply = (notice) => interaction.reply({ ...listView(client, guild, user.id, notice), ephemeral: true });

    if (sub === 'config' && !group) {
      guard(interaction);
      return interaction.reply({ ...configView(client, guild), ephemeral: true });
    }
    if (sub === 'ajouter') {
      assertEnabled(client, guild.id);
      const { word, entry } = svc.addWord(guild.id, user.id, interaction.options.getString('mot'));
      return reply(`${ICONS.success} Mot-clé ${quote(word)} ajouté (${entry.words.length} / ${MAX_KEYWORDS}).`);
    }
    if (sub === 'retirer') {
      const { word } = svc.removeWord(guild.id, user.id, interaction.options.getString('mot'));
      return reply(`${ICONS.success} Mot-clé ${quote(word)} retiré.`);
    }
    if (sub === 'liste') return reply();
    if (sub === 'pause') {
      const paused = !svc.entry(guild.id, user.id).paused;
      svc.setPaused(guild.id, user.id, paused);
      return reply(`${ICONS.success} Alertes **${paused ? 'mises en pause' : 'reprises'}**.`);
    }
    if (group === 'bloquer' && sub === 'salon') {
      const picked = interaction.options.getChannel('salon');
      const channel = guild.channels.cache.get(picked?.id);
      if (!channel) throw new UserError('Choisissez un salon de ce serveur.');
      const { blocked } = svc.toggleChannel(guild.id, user.id, channel.id);
      return reply(`${ICONS.success} ${channel} ${blocked ? 'bloqué : plus aucune alerte n\'en viendra' : 'débloqué'}.`);
    }
    if (group === 'bloquer' && sub === 'membre') {
      const target = interaction.options.getUser('membre');
      if (target.id === user.id) throw new UserError('Vos propres messages ne déclenchent jamais d\'alerte.');
      if (target.bot) throw new UserError('Les messages des bots ne déclenchent jamais d\'alerte.');
      const { blocked } = svc.toggleUser(guild.id, user.id, target.id);
      return reply(`${ICONS.success} ${target} ${blocked ? 'bloqué : ses messages ne vous alerteront plus' : 'débloqué'}.`);
    }
    throw new UserError('Sous-commande inconnue.');
  },

  buttons: {
    /** Actualise la vue « liste ». */
    async view(interaction, client) {
      await interaction.update(listView(client, interaction.guild, interaction.user.id));
    },
    /** Formulaire « nouveau mot-clé ». */
    async add(interaction, client) {
      assertEnabled(client, interaction.guildId);
      await interaction.showModal(addModal());
    },
    async addsubmit(interaction, client) {
      assertEnabled(client, interaction.guildId);
      const { word, entry } = hl(client).addWord(interaction.guildId, interaction.user.id, textField(interaction, 'mot'));
      const view = listView(client, interaction.guild, interaction.user.id, `${ICONS.success} Mot-clé ${quote(word)} ajouté (${entry.words.length} / ${MAX_KEYWORDS}).`);
      if (interaction.isFromMessage?.()) await interaction.update(view);
      else await interaction.reply({ ...view, ephemeral: true });
    },
    /** Menu « Retirer un mot-clé » (valeur : le mot-clé). */
    async remove(interaction, client) {
      const { word } = hl(client).removeWord(interaction.guildId, interaction.user.id, interaction.values?.[0]);
      await interaction.update(listView(client, interaction.guild, interaction.user.id, `${ICONS.success} Mot-clé ${quote(word)} retiré.`));
    },
    /** cmd:alertes:pause:<on|off> */
    async pause(interaction, client, [state]) {
      const paused = target(state);
      hl(client).setPaused(interaction.guildId, interaction.user.id, paused);
      await interaction.update(listView(client, interaction.guild, interaction.user.id, `${ICONS.success} Alertes **${paused ? 'mises en pause' : 'reprises'}**.`));
    },
    /** Salons bloqués (remplace la liste). */
    async chans(interaction, client) {
      const cache = interaction.guild.channels.cache;
      const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id) && cache.has(id)).slice(0, MAX_BLOCKED);
      hl(client).setBlockedChannels(interaction.guildId, interaction.user.id, ids);
      await interaction.update(listView(client, interaction.guild, interaction.user.id, `${ICONS.success} ${ids.length} salon(s) bloqué(s).`));
    },
    /** Membres bloqués (remplace la liste ; vous-même et les bots sont ignorés). */
    async users(interaction, client) {
      const resolved = interaction.users;
      const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id) && id !== interaction.user.id && !resolved?.get(id)?.bot).slice(0, MAX_BLOCKED);
      hl(client).setBlockedUsers(interaction.guildId, interaction.user.id, ids);
      await interaction.update(listView(client, interaction.guild, interaction.user.id, `${ICONS.success} ${ids.length} membre(s) bloqué(s).`));
    },

    // ------------------------------------------------------------ configuration (« Gérer le serveur »)

    async cfgview(interaction, client) {
      guard(interaction);
      await interaction.update(configView(client, interaction.guild));
    },
    /** cmd:alertes:cfg:<afk|nick|highlights|snipe>:<on|off> */
    async cfg(interaction, client, [feature, state]) {
      guard(interaction);
      const f = Object.hasOwn(FEATURES, feature ?? '') ? FEATURES[feature] : null;
      if (!f) throw new UserError('Ce bouton est invalide.');
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { memberTools: f.patch(enabled) });
      if (feature === 'snipe' && !enabled) client.services.snipe.clearGuild(interaction.guildId);
      await interaction.update(configView(client, interaction.guild, `${ICONS.success} ${f.done(enabled)}`));
    },
  },
};
