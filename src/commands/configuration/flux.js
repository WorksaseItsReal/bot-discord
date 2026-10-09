'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const { card, field, wide, ICONS, subtext, code, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { requirePermission } = require('../../services/ModerationService');
const { channelIssue, assertMentionAllowed } = require('../../services/AnnouncementService');
const { logCard } = require('../../services/LoggingService');
const { itemPayload, MAX_FEEDS_PER_GUILD, MAX_ERRORS } = require('../../services/FeedService');
const { isYoutubeFeed } = require('../../utils/feeds');
const { UserError } = require('../../core/errors');

/**
 * /flux : flux RSS / Atom et chaînes YouTube publiés dans un salon (ManageGuild).
 *  - ajouter : première lecture immédiate (l'historique n'est jamais publié) ;
 *  - retirer, liste (détail : pause / réactivation, test, suppression), tester (aperçu).
 * Les flux sont relus toutes les 10 min par le SchedulerService (services/FeedService.js).
 */

const SECTION = { emoji: '📰', label: 'Flux RSS' };
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_FILTER = 50;
const FEED_ID = /^\d{1,9}$/;

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const row = (component) => new ActionRowBuilder().addComponents(component);
const plain = (text, max = 100) => escapeMarkdown(truncate(String(text ?? '').replace(/\s+/g, ' '), max));
const feedName = (r) => plain(r.title || r.url, 80);

/** Erreur de lecture (FeedError / FetchError) → UserError lisible. */
function readable(err, prefix = 'Flux illisible') {
  if (err instanceof UserError) return err;
  if (err?.name === 'FeedError' || err?.name === 'FetchError') return new UserError(`${prefix} : ${err.message}.`);
  return err;
}

/** Filtre saisi : 1 à 50 caractères, une ligne. Pur. */
function parseFilter(raw) {
  if (raw == null) return null;
  // eslint-disable-next-line no-control-regex
  const text = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > MAX_FILTER) throw new UserError(`Filtre : ${MAX_FILTER} caractères au plus.`);
  return text;
}

function findFeed(client, guildId, raw) {
  if (!FEED_ID.test(String(raw ?? ''))) throw new UserError('Flux introuvable : choisissez-le dans la liste proposée (voir `/flux liste`).');
  const feed = client.repositories.feeds.get(guildId, Number(raw));
  if (!feed) throw new UserError('Ce flux n\'existe plus.');
  return feed;
}

const stateDot = (r) => (!r.enabled ? '🔴' : r.errors ? '🟠' : '🟢');
const stateLabel = (r) => (!r.enabled ? (r.errors >= MAX_ERRORS ? 'Désactivé (erreurs)' : 'En pause') : r.errors ? `Actif · ${r.errors} erreur(s)` : 'Actif');

function feedLine(r) {
  const extras = [`<#${r.channel_id}>`, r.role_id ? `<@&${r.role_id}>` : null, r.filter ? `${ICONS.search} « ${plain(r.filter, 50)} »` : null].filter(Boolean).join(' · ');
  const when = !r.enabled && r.last_error
    ? `${ICONS.warning} ${plain(r.last_error, 120)}`
    : r.last_checked_at ? `lu ${discordTimestamp(r.last_checked_at, 'R')} · ${r.posted_count} publié(s)` : 'pas encore lu';
  return `${stateDot(r)} ${code(`#${r.id}`)} **${feedName(r)}** → ${extras}\n${subtext(when)}`;
}

// ---------------------------------------------------------------- vues

function listView(client, guild, notice) {
  const rows = client.repositories.feeds.list(guild.id, MAX_FEEDS_PER_GUILD);
  const components = [];
  if (rows.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:flux:pick')
        .setPlaceholder('Voir un flux…')
        .addOptions(rows.map((r) => ({
          value: String(r.id),
          label: truncate(`#${r.id} · ${String(r.title || r.url).replace(/\s+/g, ' ')}`, 100),
          description: truncate(`#${guild.channels.cache.get(r.channel_id)?.name ?? 'salon supprimé'} · ${stateLabel(r)}`, 100),
          emoji: stateDot(r),
        }))),
    ));
  }
  components.push(...buttonRows(actionButton({ command: 'flux', action: 'list', label: 'Actualiser', emoji: ICONS.refresh })));
  return {
    embeds: [
      card({
        tone: rows.some((r) => !r.enabled && r.errors >= MAX_ERRORS) ? 'warning' : 'info',
        section: SECTION,
        icon: '📰',
        title: 'Flux suivis',
        description: [
          notice ? `${notice}\n` : null,
          rows.length ? truncate(rows.map(feedLine).join('\n'), 3800) : '*Aucun flux suivi. Ajoutez-en un avec `/flux ajouter` (RSS, Atom ou chaîne YouTube).*',
        ],
        fields: [field(ICONS.count, 'Flux', `${rows.length} / ${MAX_FEEDS_PER_GUILD}`), field(ICONS.refresh, 'Lecture', 'Toutes les 10 min')],
        footer: `Un flux est désactivé après ${MAX_ERRORS} erreurs consécutives`,
      }),
    ],
    components,
  };
}

function detailView(client, guild, id, notice, preview = null) {
  const r = findFeed(client, guild.id, id);
  const issue = channelIssue(guild, r.channel_id);
  const embeds = [
    card({
      tone: !r.enabled ? 'neutral' : r.errors ? 'warning' : 'success',
      section: SECTION,
      icon: isYoutubeFeed(r.url) ? '▶️' : '📰',
      title: truncate(r.title || 'Flux sans titre', 200),
      description: [
        notice ? `${notice}\n` : null,
        `${stateDot(r)} **${stateLabel(r)}**`,
        issue ? `${ICONS.warning} Salon inutilisable : ${issue}.` : null,
      ],
      fields: [
        field(ICONS.channel, 'Salon', `<#${r.channel_id}>`),
        field('📣', 'Rôle mentionné', r.role_id ? `<@&${r.role_id}>` : '*Aucun*'),
        field(ICONS.search, 'Filtre', r.filter ? `« ${plain(r.filter, 50)} »` : '*Aucun*'),
        field(ICONS.time, 'Dernière lecture', r.last_checked_at ? discordTimestamp(r.last_checked_at, 'R') : '*Jamais*'),
        field(ICONS.date, 'Dernière publication', r.last_posted_at ? discordTimestamp(r.last_posted_at, 'R') : '*Aucune*'),
        field(ICONS.stats, 'Publiés · erreurs', `${r.posted_count} · ${r.errors} / ${MAX_ERRORS}`),
        wide(ICONS.link, 'Adresse', code(truncate(r.url, 500))),
        r.last_error ? wide(ICONS.reason, 'Dernière erreur', plain(r.last_error, 500)) : null,
      ],
      footer: `Flux #${r.id}`,
    }),
  ];
  if (preview) embeds.push(preview);
  return {
    embeds,
    components: buttonRows(
      r.enabled
        ? actionButton({ command: 'flux', action: 'toggle', args: [r.id, 'off'], label: 'Mettre en pause', emoji: '⏸️' })
        : actionButton({ command: 'flux', action: 'toggle', args: [r.id, 'on'], label: 'Réactiver', emoji: '▶️', style: ButtonStyle.Success }),
      actionButton({ command: 'flux', action: 'test', args: [r.id], label: 'Tester', emoji: '🧪', style: ButtonStyle.Primary }),
      actionButton({ command: 'flux', action: 'confirm', args: [r.id], label: 'Retirer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'flux', action: 'list', label: 'Liste', emoji: ICONS.back }),
    ),
  };
}

function confirmView(client, guild, id) {
  const r = findFeed(client, guild.id, id);
  return {
    embeds: [card({ tone: 'danger', section: SECTION, icon: ICONS.warning, title: 'Retirer ce flux ?', description: `Le flux **${feedName(r)}** ne sera plus publié dans <#${r.channel_id}>.` })],
    components: buttonRows(
      actionButton({ command: 'flux', action: 'del', args: [r.id], label: 'Oui, retirer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'flux', action: 'view', args: [r.id], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

/** Aperçu du dernier article (exactement la carte qui serait publiée). */
function previewEmbed(feed, url) {
  const item = feed.items[0];
  if (!item) return card({ tone: 'neutral', section: SECTION, icon: ICONS.info, title: 'Aperçu', description: '*Ce flux ne contient aucun article pour l\'instant.*' });
  return itemPayload(item, { feedTitle: feed.title, youtube: isYoutubeFeed(url) }).embeds[0];
}

function summaryCard(feed, url, { title = 'Lecture réussie', notice = null } = {}) {
  return card({
    tone: 'success',
    section: SECTION,
    icon: ICONS.success,
    title,
    description: [
      notice,
      `**${plain(feed.title, 200)}** · ${feed.format === 'atom' ? 'Atom' : 'RSS'}${isYoutubeFeed(url) ? ' (YouTube)' : ''}`,
      subtext('Aperçu du dernier article ci-dessous : c\'est la carte qui sera publiée.'),
    ],
    fields: [field(ICONS.count, 'Articles lus', `${feed.items.length}`), field(ICONS.date, 'Dernier article', feed.items[0]?.date ? discordTimestamp(feed.items[0].date, 'R') : '—'), wide(ICONS.link, 'Adresse', code(truncate(url, 500)))],
  });
}

async function logFeed(client, guild, { title, description, user, tone = 'info', fields = [] }) {
  const embed = logCard({ category: 'server', tone, icon: '📰', title, description, user, fields });
  await client.services.logging.send(guild.id, 'server', embed, undefined, { event: 'feeds' }).catch(() => {});
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  parseFilter,
  listView,
  data: new SlashCommandBuilder()
    .setName('flux')
    .setDescription('Publie les nouveautés de flux RSS, Atom ou de chaînes YouTube dans vos salons.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s
      .setName('ajouter')
      .setDescription('Suit un flux RSS / Atom ou une chaîne YouTube dans un salon.')
      .addStringOption((o) => o.setName('url').setDescription('Adresse du flux, youtube.com/channel/UC… ou identifiant UC… de la chaîne').setRequired(true).setMaxLength(500))
      .addChannelOption((o) => o.setName('salon').setDescription('Salon où publier les nouveautés').setRequired(true).addChannelTypes(...TEXT_TYPES))
      .addRoleOption((o) => o.setName('role_mention').setDescription('Rôle à mentionner à chaque nouveauté (facultatif)'))
      .addStringOption((o) => o.setName('filtre_mot').setDescription('Ne publier que les articles contenant ce mot (facultatif)').setMaxLength(MAX_FILTER)))
    .addSubcommand((s) => s
      .setName('retirer')
      .setDescription('Arrête de suivre un flux.')
      .addStringOption((o) => o.setName('flux').setDescription('Flux à retirer (voir /flux liste)').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Affiche les flux suivis sur ce serveur et leur état.'))
    .addSubcommand((s) => s
      .setName('tester')
      .setDescription('Lit un flux maintenant et montre son dernier article (rien n\'est publié).')
      .addStringOption((o) => o.setName('flux').setDescription('Flux suivi à tester (voir /flux liste)').setAutocomplete(true))
      .addStringOption((o) => o.setName('url').setDescription('Ou une adresse de flux à essayer avant de l\'ajouter').setMaxLength(500))),

  async execute(interaction, client) {
    guard(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'liste') return interaction.reply({ ...listView(client, interaction.guild), ephemeral: true });
    if (sub === 'retirer') return remove(interaction, client);
    if (sub === 'tester') return test(interaction, client);
    return add(interaction, client);
  },

  async autocomplete(interaction, client) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.respond([]);
    const focused = String(interaction.options.getFocused() ?? '').toLowerCase().trim();
    const rows = client.repositories.feeds.list(interaction.guildId, MAX_FEEDS_PER_GUILD);
    const choices = rows
      .filter((r) => !focused || `#${r.id} ${r.title ?? ''} ${r.url}`.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((r) => ({ name: truncate(`#${r.id} · ${String(r.title || r.url).replace(/\s+/g, ' ')}`, 100), value: String(r.id) }));
    return interaction.respond(choices);
  },

  buttons: {
    /** Menu « Voir un flux ». */
    async pick(interaction, client) {
      guard(interaction);
      await interaction.update(detailView(client, interaction.guild, interaction.values?.[0]));
    },
    /** cmd:flux:list */
    async list(interaction, client) {
      guard(interaction);
      await interaction.update(listView(client, interaction.guild));
    },
    /** cmd:flux:view:<id> */
    async view(interaction, client, [id]) {
      guard(interaction);
      await interaction.update(detailView(client, interaction.guild, id));
    },
    /** cmd:flux:toggle:<id>:<on|off> */
    async toggle(interaction, client, [id, state]) {
      guard(interaction);
      if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
      const r = findFeed(client, interaction.guildId, id);
      const repo = client.repositories.feeds;
      if (state === 'on') repo.enable(interaction.guildId, r.id);
      else repo.pause(interaction.guildId, r.id);
      await interaction.update(detailView(client, interaction.guild, r.id, state === 'on' ? `${ICONS.success} Flux **réactivé** : il sera relu au prochain passage.` : `${ICONS.success} Flux **mis en pause**.`));
    },
    /** cmd:flux:test:<id> — lecture immédiate (aperçu, rien n'est publié). */
    async test(interaction, client, [id]) {
      guard(interaction);
      const r = findFeed(client, interaction.guildId, id);
      await interaction.deferUpdate();
      let result;
      try {
        result = await client.services.feeds.preview(r.url);
      } catch (err) {
        throw readable(err);
      }
      await interaction.editReply(detailView(client, interaction.guild, r.id, `${ICONS.success} Lecture réussie : **${result.feed.items.length}** article(s). Aperçu du dernier ci-dessous.`, previewEmbed(result.feed, result.url)));
    },
    /** cmd:flux:confirm:<id> */
    async confirm(interaction, client, [id]) {
      guard(interaction);
      await interaction.update(confirmView(client, interaction.guild, id));
    },
    /** cmd:flux:del:<id> — après confirmation. */
    async del(interaction, client, [id]) {
      guard(interaction);
      const r = findFeed(client, interaction.guildId, id);
      client.repositories.feeds.delete(interaction.guildId, r.id);
      await interaction.update(listView(client, interaction.guild, `${ICONS.success} Flux **${feedName(r)}** retiré.`));
      await logFeed(client, interaction.guild, { title: 'Flux RSS retiré', description: `${interaction.user} a retiré le flux **${feedName(r)}** (<#${r.channel_id}>).`, user: interaction.user, tone: 'neutral' });
    },
  },
};

async function add(interaction, client) {
  const guild = interaction.guild;
  const input = interaction.options.getString('url', true);
  const picked = interaction.options.getChannel('salon', true);
  const channel = guild.channels.cache.get(picked.id);
  const role = interaction.options.getRole('role_mention');
  const filter = parseFilter(interaction.options.getString('filtre_mot'));
  if (!channel || !TEXT_TYPES.includes(channel.type)) throw new UserError('Choisissez un salon textuel ou d\'annonces de ce serveur.');
  const issue = channelIssue(guild, channel.id);
  if (issue) throw new UserError(`Je ne peux pas publier dans <#${channel.id}> : ${issue}.`);
  // Jamais @everyone / @here depuis un flux (contenu externe).
  if (role?.id === guild.id) throw new UserError('Un flux ne peut pas mentionner **@everyone** : choisissez un rôle dédié (ex : « Notifications »).');
  if (role) assertMentionAllowed(guild, role.id, interaction.memberPermissions);
  if (client.repositories.feeds.count(guild.id) >= MAX_FEEDS_PER_GUILD) throw new UserError(`**${MAX_FEEDS_PER_GUILD}** flux au plus par serveur : retirez-en un d'abord (\`/flux retirer\`).`);

  await interaction.deferReply({ ephemeral: true });
  let result;
  try {
    result = await client.services.feeds.add({ guild, channelId: channel.id, input, roleId: role?.id ?? null, filter, by: interaction.user.id });
  } catch (err) {
    throw readable(err, 'Flux refusé');
  }
  const { row: feedRow, feed } = result;
  const me = guild.members.me;
  const silentRole = role && !role.mentionable && me && !channel.permissionsFor?.(me)?.has(PermissionFlagsBits.MentionEveryone);
  await interaction.editReply({
    embeds: [
      card({
        tone: 'success',
        section: SECTION,
        icon: ICONS.success,
        title: 'Flux ajouté',
        description: [
          `**${plain(feed.title, 200)}** sera publié dans <#${channel.id}>.`,
          `Les **${feed.items.length}** article(s) actuels sont marqués comme lus : seules les **nouveautés** seront publiées (lecture toutes les 10 min).`,
          silentRole ? `\n${ICONS.warning} Le rôle ${role} n'est pas mentionnable et il me manque **Mentionner @everyone, @here et tous les rôles** : la mention ne notifiera personne.` : null,
        ],
        fields: [
          field(ICONS.id, 'Flux', code(`#${feedRow.id}`)),
          field('📣', 'Rôle mentionné', role ? `${role}` : '*Aucun*'),
          field(ICONS.search, 'Filtre', filter ? `« ${plain(filter, 50)} »` : '*Aucun*'),
          wide(ICONS.link, 'Adresse', code(truncate(feedRow.url, 500))),
        ],
        footer: 'Gérez vos flux avec /flux liste',
      }),
      previewEmbed(feed, feedRow.url),
    ],
  });
  await logFeed(client, guild, {
    title: 'Flux RSS ajouté',
    description: `${interaction.user} publie le flux **${plain(feed.title, 200)}** dans <#${channel.id}>.`,
    user: interaction.user,
    tone: 'success',
    fields: [field(ICONS.id, 'Flux', `#${feedRow.id}`), wide(ICONS.link, 'Adresse', truncate(feedRow.url, 500))],
  });
}

async function remove(interaction, client) {
  const r = findFeed(client, interaction.guildId, interaction.options.getString('flux', true));
  client.repositories.feeds.delete(interaction.guildId, r.id);
  await interaction.reply({ embeds: [card({ tone: 'success', section: SECTION, icon: ICONS.success, title: 'Flux retiré', description: `Le flux **${feedName(r)}** n'est plus publié dans <#${r.channel_id}>.` })], ephemeral: true });
  await logFeed(client, interaction.guild, { title: 'Flux RSS retiré', description: `${interaction.user} a retiré le flux **${feedName(r)}** (<#${r.channel_id}>).`, user: interaction.user, tone: 'neutral' });
}

async function test(interaction, client) {
  const id = interaction.options.getString('flux');
  const url = interaction.options.getString('url');
  if (!id && !url) throw new UserError('Indiquez un flux suivi (`flux`) ou une adresse (`url`).');
  const target = id ? findFeed(client, interaction.guildId, id).url : url;
  await interaction.deferReply({ ephemeral: true });
  let result;
  try {
    result = await client.services.feeds.preview(target);
  } catch (err) {
    throw readable(err);
  }
  await interaction.editReply({ embeds: [summaryCard(result.feed, result.url), previewEmbed(result.feed, result.url)] });
}
