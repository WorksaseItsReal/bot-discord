'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, field, ICONS, code, status, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { fitList } = require('../../services/LoggingService');
const { needPermission } = require('../../services/ModerationService');

/** Filtres disponibles et leur libellé français (l'ordre est celui d'affichage). */
const FILTER_LABELS = {
  antiSpam: 'Anti-spam',
  antiFlood: 'Anti-flood',
  antiLink: 'Anti-liens',
  antiInvite: 'Anti-invitations',
  antiMassMention: 'Mentions de masse',
  antiCaps: 'Majuscules',
  badWords: 'Mots interdits',
  antiRepeat: 'Répétitions',
  antiEmojiSpam: 'Spam d\'emojis',
  antiDuplicate: 'Doublons',
};
const FILTERS = Object.keys(FILTER_LABELS);

const ACTION_LABELS = { delete: 'Suppression', warn: 'Avertissement', timeout: 'Timeout' };

/** « 🟢 **Anti-spam** · Timeout (5m) ». Pur. */
function filterLine(name, fc = {}) {
  const action = ACTION_LABELS[fc.action] ?? fc.action ?? ACTION_LABELS.delete;
  return `${fc.enabled ? '🟢' : '🔴'} **${FILTER_LABELS[name] ?? name}** · ${action}${fc.action === 'timeout' && fc.duration ? ` (${fc.duration})` : ''}`;
}

/** Panneau d'état AutoMod (éphémère) avec l'interrupteur global. */
function renderPanel(client, guildId, notice) {
  const cfg = client.services.config.get(guildId).automod;
  const active = FILTERS.filter((f) => cfg.filters[f]?.enabled).length;
  return {
    embeds: [
      card({
        tone: cfg.enabled ? 'success' : 'neutral',
        section: 'automod',
        icon: ICONS.automod,
        title: 'AutoMod',
        description: [
          notice ? `${ICONS.success} ${notice}` : null,
          cfg.enabled ? '🟢 Le filtrage automatique est **actif**.' : '🔴 Le filtrage automatique est **désactivé**.',
          '',
          ...FILTERS.map((f) => filterLine(f, cfg.filters[f])),
        ],
        fields: [
          field(ICONS.count, 'Filtres actifs', `**${active}** / ${FILTERS.length}`),
          field(ICONS.channel, 'Salons ignorés', fitList(cfg.ignoredChannels.map((c) => `<#${c}>`), 1000) ?? '*Aucun*'),
          field(ICONS.role, 'Rôles ignorés', fitList(cfg.ignoredRoles.map((r) => `<@&${r}>`), 1000) ?? '*Aucun*'),
        ],
        footer: 'Les membres avec « Gérer les messages » ne sont jamais filtrés.',
      }),
    ],
    components: buttonRows(
      cfg.enabled
        ? actionButton({ command: 'automod', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
        : actionButton({ command: 'automod', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
    ),
  };
}

function badwordCard(words, notice) {
  const list = [...words];
  return card({
    tone: 'info',
    section: 'automod',
    icon: '🚫',
    title: 'Mots interdits',
    description: [
      notice ? `${ICONS.success} ${notice}` : null,
      list.length ? truncate(list.map((w) => code(w)).join(' · '), 3800) : '*Aucun mot interdit.*',
    ],
    fields: [field(ICONS.count, 'Mots', `**${list.length}**`)],
  });
}

module.exports = {
  category: 'automod',
  filterLine,
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configuration de l\'AutoMod.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('enable').setDescription('Active l\'AutoMod.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive l\'AutoMod.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche la configuration AutoMod.'))
    .addSubcommand((s) =>
      s.setName('filter').setDescription('Active/désactive un filtre.')
        .addStringOption((o) => o.setName('nom').setDescription('Filtre').setRequired(true).addChoices(...FILTERS.map((f) => ({ name: FILTER_LABELS[f], value: f }))))
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addStringOption((o) => o.setName('action').setDescription('Sanction').addChoices({ name: 'Suppression', value: 'delete' }, { name: 'Avertissement', value: 'warn' }, { name: 'Timeout', value: 'timeout' }))
        .addStringOption((o) => o.setName('duree').setDescription('Durée du timeout (ex: 10m)')))
    .addSubcommand((s) =>
      s.setName('ignore').setDescription('Ajoute/retire un salon ou rôle ignoré.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon à (dé)ignorer').addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle à (dé)ignorer')))
    .addSubcommandGroup((g) =>
      g.setName('badword').setDescription('Gestion des mots interdits')
        .addSubcommand((s) => s.setName('add').setDescription('Ajoute un mot interdit.').addStringOption((o) => o.setName('mot').setDescription('Mot').setRequired(true).setMaxLength(100)))
        .addSubcommand((s) => s.setName('remove').setDescription('Retire un mot interdit.').addStringOption((o) => o.setName('mot').setDescription('Mot').setRequired(true).setMaxLength(100)))
        .addSubcommand((s) => s.setName('list').setDescription('Liste les mots interdits.'))),

  async execute(interaction, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (group === 'badword') return handleBadword(interaction, config, guildId, sub);

    if (sub === 'enable' || sub === 'disable') {
      config.update(guildId, { automod: { enabled: sub === 'enable' } });
      return interaction.reply({ ...renderPanel(client, guildId, `AutoMod **${sub === 'enable' ? 'activé' : 'désactivé'}**.`), ephemeral: true });
    }

    if (sub === 'status') {
      return interaction.reply({ ...renderPanel(client, guildId), ephemeral: true });
    }

    if (sub === 'filter') {
      const name = interaction.options.getString('nom');
      const enabled = interaction.options.getBoolean('actif');
      const action = interaction.options.getString('action');
      const duration = interaction.options.getString('duree');
      const patch = { enabled };
      if (action) patch.action = action;
      if (duration) patch.duration = duration;
      config.update(guildId, { automod: { filters: { [name]: patch } } });
      const notice = `Filtre **${FILTER_LABELS[name] ?? name}** ${enabled ? 'activé' : 'désactivé'}.`;
      return interaction.reply({ ...renderPanel(client, guildId, notice), ephemeral: true });
    }

    if (sub === 'ignore') {
      const channel = interaction.options.getChannel('salon');
      const role = interaction.options.getRole('role');
      if (!channel && !role) return interaction.reply({ embeds: [status.warn('Indiquez un salon ou un rôle.')], ephemeral: true });
      const cfg = config.get(guildId).automod;
      const msgs = [];
      if (channel) {
        const set = new Set(cfg.ignoredChannels);
        set.has(channel.id) ? set.delete(channel.id) : set.add(channel.id);
        config.update(guildId, { automod: { ignoredChannels: [...set] } });
        msgs.push(`${channel} ${set.has(channel.id) ? 'est désormais ignoré' : 'n\'est plus ignoré'}.`);
      }
      if (role) {
        const set = new Set(config.get(guildId).automod.ignoredRoles);
        set.has(role.id) ? set.delete(role.id) : set.add(role.id);
        config.update(guildId, { automod: { ignoredRoles: [...set] } });
        msgs.push(`${role} ${set.has(role.id) ? 'est désormais ignoré' : 'n\'est plus ignoré'}.`);
      }
      return interaction.reply({ ...renderPanel(client, guildId, msgs.join(' ')), ephemeral: true });
    }
  },

  buttons: {
    /** cmd:automod:toggle:<on|off> — « Gérer le serveur » revérifiée (permission de la commande). */
    async toggle(interaction, client, [state]) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw needPermission('ManageGuild');
      const enabled = state === 'on';
      client.services.config.update(interaction.guildId, { automod: { enabled } });
      await interaction.update(renderPanel(client, interaction.guildId, `AutoMod **${enabled ? 'activé' : 'désactivé'}**.`));
    },
  },
};

function handleBadword(interaction, config, guildId, sub) {
  const cfg = config.get(guildId).automod.filters.badWords;
  const words = new Set(cfg.words || []);
  if (sub === 'list') {
    return interaction.reply({ embeds: [badwordCard(words)], ephemeral: true });
  }
  const word = interaction.options.getString('mot').toLowerCase();
  if (sub === 'add') words.add(word);
  else words.delete(word);
  // Seul l'ajout active le filtre : retirer un mot ne doit pas réactiver un filtre désactivé.
  const patch = sub === 'add' ? { words: [...words], enabled: true } : { words: [...words] };
  config.update(guildId, { automod: { filters: { badWords: patch } } });
  return interaction.reply({ embeds: [badwordCard(words, `Mot ${code(word)} ${sub === 'add' ? 'ajouté' : 'retiré'}.`)], ephemeral: true });
}
