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
  RoleSelectMenuBuilder,
} = require('discord.js');
const { card, field, wide, ICONS, subtext, code, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { fitList } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { channelIssue } = require('../../services/AnnouncementService');
const { presenceSettings, renderStatus, counts, TYPE_LABELS } = require('../../utils/presence');
const {
  assignableRoleIssue,
  managedVoiceRoles,
  renderThreadName,
  renderBoostMessage,
  boostPayload,
  unknownVariables,
  ARCHIVE_DURATIONS,
  THREAD_MODES,
  DEFAULT_THREAD_NAME,
  DEFAULT_BOOST_MESSAGE,
  BOOST_VARIABLES,
  TEXT_TYPES,
  VOICE_TYPES,
  MAX_CHANNELS,
  MAX_VOICE_LINKS,
  MAX_TEMPLATE,
  MAX_BOOST_MESSAGE,
  CROSSPOST_LIMIT,
} = require('../../services/AutomationService');
const { UserError } = require('../../core/errors');

/**
 * /automatisations : tableau de bord (éphémère, « Gérer le serveur ») de la publication
 * automatique, des fils automatiques, du rôle vocal, du remerciement de boost et de la
 * présence du bot (réglage global, en lecture seule). Les flux RSS ont leur commande (/flux).
 * Vues : home · crosspost · threads · voice · vrchan:<salon> · boost · presence
 */

const SECTION = { emoji: '⚡', label: 'Automatisations' };
const SNOWFLAKE = /^\d{17,20}$/;
const FEATURES = Object.freeze({ crosspost: 'crosspost', threads: 'autoThreads', voice: 'voiceRole', boost: 'boost' });
const SHORT_LABELS = Object.freeze({ crosspost: 'Publication', threads: 'Fils', voice: 'Rôle vocal', boost: 'Boost' });
/** Retour d'un bouton on/off : [activé, désactivé]. */
const TOGGLE_NOTICES = Object.freeze({
  crosspost: ['Publication automatique **activée**.', 'Publication automatique **désactivée**.'],
  threads: ['Fils automatiques **activés**.', 'Fils automatiques **désactivés**.'],
  voice: ['Rôle vocal **activé** : les membres déjà en vocal le reçoivent.', 'Rôle vocal **désactivé** : le rôle est retiré à ceux qui le portent.'],
  boost: ['Remerciement de boost **activé**.', 'Remerciement de boost **désactivé**.'],
});

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const settings = (client, guildId) => client.services.config.get(guildId).automations ?? {};
const save = (client, guildId, patch) => client.services.config.update(guildId, { automations: patch });
const row = (component) => new ActionRowBuilder().addComponents(component);
const dot = (on) => (on ? '🟢' : '🔴');
const mentions = (ids, prefix = '#') => fitList(ids.map((id) => `<${prefix}${id}>`), 1000);
const homeButton = () => actionButton({ command: 'automatisations', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Vue d\'ensemble des automatisations' },
  { value: 'crosspost', label: 'Publication automatique', emoji: '📢', description: 'Publier les messages des salons d\'annonces' },
  { value: 'threads', label: 'Fils automatiques', emoji: '🧵', description: 'Un fil sous chaque message' },
  { value: 'voice', label: 'Rôle vocal', emoji: '🔊', description: 'Rôle porté tant qu\'on est en vocal' },
  { value: 'boost', label: 'Remerciement de boost', emoji: '💎', description: 'Message et rôle pour les boosters' },
  { value: 'presence', label: 'Présence du bot', emoji: '🤖', description: 'Statuts tournants (réglage global)' },
];

function navRow(current) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:automatisations:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

/** Valeur voulue par un bouton « on/off ». */
const target = (state) => {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
};

function textField(interaction, id) {
  try {
    const v = interaction.fields.getTextInputValue(id)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Salons existants et du bon type parmi `ids`. */
function existing(guild, ids, types) {
  const cache = guild.channels?.cache;
  return (ids ?? []).filter((id) => !cache || types.includes(cache.get(id)?.type)).slice(0, MAX_CHANNELS);
}

/** Salons choisis dans un menu (validés : identifiant, type, serveur). */
function picked(interaction, types) {
  const cache = interaction.guild.channels.cache;
  return [...new Set(interaction.values ?? [])].filter((id) => SNOWFLAKE.test(id) && types.includes(cache.get(id)?.type)).slice(0, MAX_CHANNELS);
}

/** Avertissements de permissions du bot dans des salons (null si tout va bien). */
function permissionWarnings(guild, ids, flags, label) {
  const me = guild.members?.me;
  if (!me) return null;
  const bad = ids.filter((id) => {
    const perms = guild.channels.cache.get(id)?.permissionsFor?.(me);
    return perms && !perms.has(flags);
  });
  return bad.length ? `${ICONS.warning} Il me manque ${label} dans ${bad.map((id) => `<#${id}>`).join(', ')}.` : null;
}

/** Membres (en cache) qui portent le rôle sans être en vocal. */
function holdersOutsideVoice(guild, role) {
  return [...(role.members?.values() ?? [])].filter((m) => !m.user?.bot && !guild.voiceStates?.cache?.get(m.id)?.channelId).length;
}

/** Rôle vocal choisi : attribuable ET dédié (sinon il serait retiré à ses porteurs hors vocal). */
function assertVoiceRole(interaction, client, roleId) {
  const { guild } = interaction;
  if (!SNOWFLAKE.test(roleId ?? '')) throw new UserError('Rôle invalide.');
  const role = guild.roles.cache.get(roleId);
  const issue = assignableRoleIssue(guild, role, interaction.member);
  if (issue) throw new UserError(issue);
  const cfg = settings(client, guild.id).voiceRole ?? {};
  if (!managedVoiceRoles(cfg).includes(role.id)) {
    const outside = holdersOutsideVoice(guild, role);
    if (outside) throw new UserError(`**${outside}** membre(s) ont déjà le rôle ${role} sans être en vocal : il leur serait retiré. Créez un rôle dédié (ex : « En vocal »).`);
  }
  return role;
}

/** Retire en arrière-plan les rôles qui ne sont plus « vocaux », puis resynchronise. */
function afterVoiceChange(client, guild, before) {
  const svc = client.services.automations;
  const now = managedVoiceRoles(settings(client, guild.id).voiceRole);
  const dropped = before.filter((id) => !now.includes(id));
  svc.runInBackground((async () => {
    if (dropped.length) await svc.releaseRoles(guild, dropped);
    await svc.reconcileGuild(guild, { fetchMembers: false });
  })());
}

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const cfg = settings(client, guild.id);
  const cp = cfg.crosspost ?? {};
  const th = cfg.autoThreads ?? {};
  const vr = cfg.voiceRole ?? {};
  const bo = cfg.boost ?? {};
  const feeds = client.repositories.feeds;
  const presence = presenceSettings(client.config);
  const anyOn = cp.enabled || th.enabled || vr.enabled || bo.enabled;
  const toggle = (feature, on, emoji) => actionButton({
    command: 'automatisations',
    action: 'toggle',
    args: [feature, on ? 'off' : 'on', 'home'],
    label: `${SHORT_LABELS[feature]} ${on ? '✅' : '❌'}`,
    emoji,
  });
  return {
    embeds: [
      card({
        tone: anyOn ? 'success' : 'neutral',
        section: SECTION,
        icon: '⚡',
        title: 'Automatisations · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          `${dot(cp.enabled)} **Publication automatique** ${cp.enabled ? 'active' : 'désactivée'}${cp.enabled && !(cp.channels ?? []).length ? ` · ${ICONS.warning} *aucun salon*` : ''}`,
          `${dot(th.enabled)} **Fils automatiques** ${th.enabled ? 'actifs' : 'désactivés'}${th.enabled && !(th.channels ?? []).length ? ` · ${ICONS.warning} *aucun salon*` : ''}`,
          `${dot(vr.enabled)} **Rôle vocal** ${vr.enabled ? 'actif' : 'désactivé'}${vr.enabled && !managedVoiceRoles(vr).length ? ` · ${ICONS.warning} *aucun rôle*` : ''}`,
          `${dot(bo.enabled)} **Remerciement de boost** ${bo.enabled ? 'actif' : 'désactivé'}`,
          '',
          subtext('Flux RSS et YouTube : /flux. Logs des boosts : /logs → Membres.'),
        ],
        fields: [
          field('📢', 'Salons publiés', `${(cp.channels ?? []).length}`),
          field('🧵', 'Salons à fils', `${(th.channels ?? []).length}`),
          field(ICONS.voice, 'Rôle vocal', vr.roleId ? `<@&${vr.roleId}>` : `${(vr.channels ?? []).length} salon(s)`),
          field(ICONS.boost, 'Boosts', bo.channelId ? `<#${bo.channelId}>` : '*Aucun salon*'),
          field('📰', 'Flux RSS', feeds ? `${feeds.countEnabled(guild.id)} actif(s) / ${feeds.count(guild.id)}` : '—'),
          field(ICONS.bot, 'Présence', `${presence.statuses.length} statut(s) · ${Math.round(presence.intervalMs / 60_000)} min`),
        ],
        footer: 'Choisissez une section dans le menu',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        toggle('crosspost', cp.enabled, '📢'),
        toggle('threads', th.enabled, '🧵'),
        toggle('voice', vr.enabled, ICONS.voice),
        toggle('boost', bo.enabled, ICONS.boost),
        actionButton({ command: 'automatisations', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function toggleButton(feature, on) {
  return on
    ? actionButton({ command: 'automatisations', action: 'toggle', args: [feature, 'off', feature], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
    : actionButton({ command: 'automatisations', action: 'toggle', args: [feature, 'on', feature], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success });
}

function crosspostView(client, guild, notice) {
  const cp = settings(client, guild.id).crosspost ?? {};
  const channels = existing(guild, cp.channels, [ChannelType.GuildAnnouncement]);
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:automatisations:cpchannels')
    .setPlaceholder('Salons d\'annonces à publier (aucun)')
    .setChannelTypes(ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(MAX_CHANNELS);
  if (channels.length) menu.setDefaultChannels(...channels);
  const waiting = channels.map((id) => [id, client.services.automations?.queueSize(id) ?? 0]).filter(([, n]) => n);
  const warning = permissionWarnings(guild, channels, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages], '**Voir**, **Envoyer** ou **Gérer les messages**');
  return {
    embeds: [
      card({
        tone: cp.enabled ? (warning ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: '📢',
        title: 'Publication automatique',
        description: [
          notice ? `${notice}\n` : null,
          'Chaque nouveau message des salons d\'annonces choisis est **publié** (crosspost) vers les serveurs qui suivent ces salons — messages du bot (flux RSS, annonces…) compris.',
          subtext('Jamais publiés : les avertissements du bot adressés à un membre (AutoMod…) et les messages épinglés automatiquement (/sticky).'),
          subtext(`Limite de Discord : ${CROSSPOST_LIMIT} publications par heure et par salon. Au-delà, les messages attendent leur tour (file d'attente) et un log est envoyé.`),
          warning ? `\n${warning}` : null,
          cp.enabled && !channels.length ? `\n${ICONS.warning} Choisissez au moins un **salon d'annonces** ci-dessous.` : null,
        ],
        fields: [
          field(ICONS.status, 'Statut', cp.enabled ? '🟢 Active' : '🔴 Désactivée'),
          field(ICONS.count, 'Salons', `${channels.length} / ${MAX_CHANNELS}`),
          field(ICONS.loading, 'En attente', waiting.length ? waiting.map(([id, n]) => `<#${id}> · ${n}`).join('\n') : 'Aucun message'),
          wide(ICONS.channel, 'Salons publiés', mentions(channels) ?? '*Aucun*'),
        ],
        footer: 'Permission requise : Gérer les messages (pour publier les messages des autres)',
      }),
    ],
    components: [navRow('crosspost'), row(menu), ...buttonRows(toggleButton('crosspost', cp.enabled), homeButton())],
  };
}

function threadsView(client, guild, notice) {
  const th = settings(client, guild.id).autoThreads ?? {};
  const channels = existing(guild, th.channels, TEXT_TYPES);
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:automatisations:thchannels')
    .setPlaceholder('Salons avec fils automatiques (aucun)')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(MAX_CHANNELS);
  if (channels.length) menu.setDefaultChannels(...channels);
  const mode = Object.hasOwn(THREAD_MODES, th.mode ?? '') ? th.mode : 'all';
  const archive = Object.hasOwn(ARCHIVE_DURATIONS, String(th.archiveMinutes)) ? String(th.archiveMinutes) : '1440';
  const warning = permissionWarnings(guild, channels, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.CreatePublicThreads], '**Voir**, **Lire l\'historique** ou **Créer des fils publics**');
  const sample = renderThreadName(th.nameTemplate, { pseudo: 'Alice', n: 42 });
  return {
    embeds: [
      card({
        tone: th.enabled ? (warning ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: '🧵',
        title: 'Fils automatiques',
        description: [
          notice ? `${notice}\n` : null,
          'Dans les salons choisis, un **fil** est ouvert sous chaque message (ou seulement sous les messages avec une image ou un lien). Les messages des bots sont ignorés.',
          warning ? `\n${warning}` : null,
          th.enabled && !channels.length ? `\n${ICONS.warning} Choisissez au moins un **salon** ci-dessous.` : null,
        ],
        fields: [
          field(ICONS.status, 'Statut', th.enabled ? '🟢 Actifs' : '🔴 Désactivés'),
          field(ICONS.search, 'Messages', THREAD_MODES[mode]),
          field(ICONS.duration, 'Archivage auto', ARCHIVE_DURATIONS[archive]),
          field(ICONS.tag, 'Nom du fil', `${code(truncate(th.nameTemplate || DEFAULT_THREAD_NAME, 100))}\n${subtext(`ex : ${truncate(sample, 80)}`)}`),
          wide(ICONS.channel, 'Salons', mentions(channels) ?? '*Aucun*'),
        ],
        footer: 'Variables du nom : {pseudo} (auteur) et {n} (numéro du fil dans le salon)',
      }),
    ],
    components: [
      navRow('threads'),
      row(menu),
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:automatisations:thmode')
          .setPlaceholder('Messages concernés')
          .addOptions(Object.entries(THREAD_MODES).map(([value, label]) => ({ value, label, emoji: value === 'all' ? '💬' : ICONS.image, default: value === mode }))),
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cmd:automatisations:tharchive')
          .setPlaceholder('Archivage automatique')
          .addOptions(Object.entries(ARCHIVE_DURATIONS).map(([value, label]) => ({ value, label: `Archiver après ${label} d'inactivité`, emoji: ICONS.duration, default: value === archive }))),
      ),
      ...buttonRows(
        toggleButton('threads', th.enabled),
        actionButton({ command: 'automatisations', action: 'thname', label: 'Nom du fil', emoji: ICONS.tag, style: ButtonStyle.Primary }),
        homeButton(),
      ),
    ],
  };
}

function voiceView(client, guild, notice) {
  const vr = settings(client, guild.id).voiceRole ?? {};
  const links = (vr.channels ?? []).slice(0, MAX_VOICE_LINKS);
  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId('cmd:automatisations:vrrole')
    .setPlaceholder('Rôle global (tout salon vocal)')
    .setMinValues(0)
    .setMaxValues(1);
  if (vr.roleId && guild.roles.cache.has(vr.roleId)) roleMenu.setDefaultRoles(vr.roleId);
  const components = [
    navRow('voice'),
    row(roleMenu),
    row(
      new ChannelSelectMenuBuilder()
        .setCustomId('cmd:automatisations:vrpick')
        .setPlaceholder('Rôle propre à un salon vocal…')
        .setChannelTypes(...VOICE_TYPES)
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];
  if (links.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:automatisations:vrdel')
        .setPlaceholder('Retirer une association salon → rôle…')
        .addOptions(links.map((l) => ({
          value: l.channelId,
          label: truncate(`${guild.channels.cache.get(l.channelId)?.name ?? 'salon supprimé'} → ${guild.roles.cache.get(l.roleId)?.name ?? 'rôle supprimé'}`, 100),
          emoji: ICONS.delete,
        }))),
    ));
  }
  components.push(...buttonRows(
    toggleButton('voice', vr.enabled),
    actionButton({ command: 'automatisations', action: 'vrsync', label: 'Resynchroniser', emoji: ICONS.refresh, disabled: !vr.enabled }),
    homeButton(),
  ));
  const broken = managedVoiceRoles(vr).map((id) => [id, assignableRoleIssue(guild, guild.roles.cache.get(id))]).filter(([, issue]) => issue);
  return {
    embeds: [
      card({
        tone: vr.enabled ? (broken.length ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: ICONS.voice,
        title: 'Rôle vocal',
        description: [
          notice ? `${notice}\n` : null,
          'Un rôle est donné tant qu\'un membre est dans un salon vocal, et retiré à sa déconnexion. Rôle **global** (tout salon) et/ou rôle **propre à un salon**. Au démarrage du bot, les rôles sont rattrapés.',
          subtext('Utilisez des rôles dédiés (ex : « En vocal ») : ils sont retirés à tous ceux qui ne sont plus en vocal. Rôles sensibles et rôles au-dessus du mien refusés.'),
          broken.length ? `\n${ICONS.warning} ${broken.map(([, issue]) => issue).join('\n')}` : null,
          vr.enabled && !managedVoiceRoles(vr).length ? `\n${ICONS.warning} Choisissez un **rôle** ci-dessous.` : null,
        ],
        fields: [
          field(ICONS.status, 'Statut', vr.enabled ? '🟢 Actif' : '🔴 Désactivé'),
          field(ICONS.role, 'Rôle global', vr.roleId ? `<@&${vr.roleId}>` : '*Aucun*'),
          field(ICONS.count, 'Salons', `${links.length} / ${MAX_VOICE_LINKS}`),
          wide(ICONS.voice, 'Rôles par salon', links.length ? links.map((l) => `<#${l.channelId}> → <@&${l.roleId}>`).join('\n') : '*Aucun*'),
        ],
        footer: 'Les bots ne reçoivent pas le rôle vocal',
      }),
    ],
    components,
  };
}

function voiceChannelView(client, guild, channelId, notice) {
  if (!SNOWFLAKE.test(channelId ?? '')) throw new UserError('Salon invalide.');
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !VOICE_TYPES.includes(channel.type)) throw new UserError('Choisissez un salon vocal de ce serveur.');
  const vr = settings(client, guild.id).voiceRole ?? {};
  const link = (vr.channels ?? []).find((l) => l.channelId === channelId);
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(`cmd:automatisations:vrset:${channelId}`)
    .setPlaceholder(`Rôle pour ${truncate(channel.name, 60)} (aucun)`)
    .setMinValues(0)
    .setMaxValues(1);
  if (link?.roleId && guild.roles.cache.has(link.roleId)) menu.setDefaultRoles(link.roleId);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.voice,
        title: `Rôle vocal · ${truncate(channel.name, 80)}`,
        description: [
          notice ? `${notice}\n` : null,
          `Rôle porté par les membres présents dans <#${channelId}>${vr.roleId ? `, en plus du rôle global <@&${vr.roleId}>` : ''}. Videz le menu pour retirer l'association.`,
        ],
        fields: [field(ICONS.role, 'Rôle actuel', link?.roleId ? `<@&${link.roleId}>` : '*Aucun*'), field(ICONS.count, 'Associations', `${(vr.channels ?? []).length} / ${MAX_VOICE_LINKS}`)],
      }),
    ],
    components: [
      navRow('voice'),
      row(menu),
      ...buttonRows(actionButton({ command: 'automatisations', action: 'go', args: ['voice'], label: 'Retour', emoji: ICONS.back })),
    ],
  };
}

function boostView(client, guild, notice, user) {
  const bo = settings(client, guild.id).boost ?? {};
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:automatisations:bochannel')
    .setPlaceholder('Salon du remerciement (aucun)')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (bo.channelId && guild.channels.cache.has(bo.channelId)) channelMenu.setDefaultChannels(bo.channelId);
  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId('cmd:automatisations:borole')
    .setPlaceholder('Rôle donné aux boosters (aucun)')
    .setMinValues(0)
    .setMaxValues(1);
  if (bo.roleId && guild.roles.cache.has(bo.roleId)) roleMenu.setDefaultRoles(bo.roleId);
  const issue = bo.channelId ? channelIssue(guild, bo.channelId) : null;
  const roleIssue = bo.roleId ? assignableRoleIssue(guild, guild.roles.cache.get(bo.roleId)) : null;
  const sample = renderBoostMessage(bo.message, { id: user?.id, server: guild.name, boosts: guild.premiumSubscriptionCount ?? 0 });
  const preview = boostPayload(sample, { userId: user?.id, avatar: user?.displayAvatarURL?.() ?? null }).embeds[0];
  return {
    embeds: [
      card({
        tone: bo.enabled ? (issue || roleIssue ? 'warning' : 'success') : 'neutral',
        section: SECTION,
        icon: ICONS.boost,
        title: 'Remerciement de boost',
        description: [
          notice ? `${notice}\n` : null,
          'Quand un membre boost le serveur, un message de remerciement est publié (et un rôle facultatif lui est donné, retiré à la fin du boost). Le log « Nouveau boost » reste dans **/logs → Membres**.',
          issue ? `\n${ICONS.warning} Je ne peux pas publier dans <#${bo.channelId}> : ${issue}.` : null,
          roleIssue ? `\n${ICONS.warning} ${roleIssue}` : null,
          bo.enabled && !bo.channelId && !bo.roleId ? `\n${ICONS.warning} Choisissez un **salon** et/ou un **rôle** ci-dessous.` : null,
        ],
        fields: [
          field(ICONS.status, 'Statut', bo.enabled ? '🟢 Actif' : '🔴 Désactivé'),
          field(ICONS.channel, 'Salon', bo.channelId ? `<#${bo.channelId}>` : '*Aucun*'),
          field(ICONS.role, 'Rôle', bo.roleId ? `<@&${bo.roleId}>` : '*Aucun*'),
        ],
        footer: 'Variables : {membre} {serveur} {boosts} · Aperçu ci-dessous',
      }),
      preview,
    ],
    components: [
      navRow('boost'),
      row(channelMenu),
      row(roleMenu),
      ...buttonRows(
        toggleButton('boost', bo.enabled),
        actionButton({ command: 'automatisations', action: 'bomsg', label: 'Message', emoji: '📝', style: ButtonStyle.Primary }),
        homeButton(),
      ),
    ],
  };
}

function presenceView(client, notice) {
  const presence = presenceSettings(client.config);
  const values = counts(client);
  const current = client.user?.presence?.activities?.[0]?.name;
  const lines = presence.statuses.map((s, i) => `\`${i + 1}.\` **${TYPE_LABELS[s.type] ?? 'Regarde'}** ${truncate(renderStatus(s, values).name, 128).replace(/[*_`~|]/g, '')}`);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.bot,
        title: 'Présence du bot',
        description: [
          notice ? `${notice}\n` : null,
          'Statuts affichés à tour de rôle sous le nom du bot. Réglage **global** (tous les serveurs), réservé à l\'hébergeur du bot.',
          '',
          lines.join('\n'),
          presence.invalid.length ? `\n${ICONS.warning} ${presence.invalid.length} statut(s) ignoré(s) dans PRESENCE_STATUSES (vide, plus de 128 caractères ou plus de 10 statuts).` : null,
        ],
        fields: [
          field(ICONS.refresh, 'Rotation', `Toutes les ${Math.round(presence.intervalMs / 60_000)} min`),
          field(ICONS.settings, 'Source', presence.source === 'env' ? 'Fichier .env' : 'Statuts par défaut'),
          field(ICONS.status, 'En ce moment', current ? truncate(current, 100).replace(/[*_`~|]/g, '') : '—'),
          wide(ICONS.info, 'Modifier', `Variables d'environnement, puis redémarrage du bot :\n${code('PRESENCE_STATUSES="regarde:/help • {serveurs} serveurs | joue:/projet | écoute:{membres} membres"')}\n${code('PRESENCE_INTERVAL_MINUTES=1')} (1 min au minimum)`),
        ],
        footer: 'Variables : {serveurs} {membres} · Types : joue, regarde, écoute',
      }),
    ],
    components: [
      navRow('presence'),
      ...buttonRows(actionButton({ command: 'automatisations', action: 'go', args: ['presence'], label: 'Actualiser', emoji: ICONS.refresh }), homeButton()),
    ],
  };
}

/** Rend une vue (« vrchan:<id> » ou « vrchan.<id> »). */
function render(client, guild, view = 'home', notice, user = null) {
  const [name, arg] = String(view).split(/[:.]/);
  switch (name) {
    case 'crosspost':
      return crosspostView(client, guild, notice);
    case 'threads':
      return threadsView(client, guild, notice);
    case 'voice':
      return voiceView(client, guild, notice);
    case 'vrchan':
      return voiceChannelView(client, guild, arg, notice);
    case 'boost':
      return boostView(client, guild, notice, user);
    case 'presence':
      return presenceView(client, notice);
    default:
      return homeView(client, guild, notice);
  }
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  render,
  data: new SlashCommandBuilder()
    .setName('automatisations')
    .setDescription('Tableau de bord : publication auto, fils automatiques, rôle vocal, boosts, présence du bot.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home', null, interaction.user), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home', null, interaction.user));
    },
    /** cmd:automatisations:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home', null, interaction.user));
    },
    /** cmd:automatisations:toggle:<fonction>:<on|off>:<vue> */
    async toggle(interaction, client, [feature, state, view]) {
      guard(interaction);
      if (!Object.hasOwn(FEATURES, feature ?? '')) throw new UserError('Ce bouton est invalide.');
      const enabled = target(state);
      const { guild } = interaction;
      const key = FEATURES[feature];
      const before = managedVoiceRoles(settings(client, guild.id).voiceRole);
      save(client, guild.id, { [key]: { enabled } });
      const svc = client.services.automations;
      if (feature === 'voice') {
        // Activation : rattrapage des membres déjà en vocal. Désactivation : rôles retirés.
        svc.runInBackground(enabled ? svc.reconcileGuild(guild) : svc.releaseRoles(guild, before));
      }
      const back = view === feature ? feature : 'home';
      await interaction.update(render(client, guild, back, `${ICONS.success} ${TOGGLE_NOTICES[feature][enabled ? 0 : 1]}`, interaction.user));
    },

    // ------------------------------------------------------------ publication automatique

    async cpchannels(interaction, client) {
      guard(interaction);
      const channels = picked(interaction, [ChannelType.GuildAnnouncement]);
      save(client, interaction.guildId, { crosspost: { channels } });
      await interaction.update(crosspostView(client, interaction.guild, `${ICONS.success} ${channels.length} salon(s) d'annonces publié(s) automatiquement.`));
    },

    // ------------------------------------------------------------ fils automatiques

    async thchannels(interaction, client) {
      guard(interaction);
      const channels = picked(interaction, TEXT_TYPES);
      save(client, interaction.guildId, { autoThreads: { channels } });
      await interaction.update(threadsView(client, interaction.guild, `${ICONS.success} ${channels.length} salon(s) avec fils automatiques.`));
    },
    async thmode(interaction, client) {
      guard(interaction);
      const mode = interaction.values?.[0];
      if (!Object.hasOwn(THREAD_MODES, mode ?? '')) throw new UserError('Choix inconnu.');
      save(client, interaction.guildId, { autoThreads: { mode } });
      await interaction.update(threadsView(client, interaction.guild, `${ICONS.success} Fils ouverts pour : **${THREAD_MODES[mode]}**.`));
    },
    async tharchive(interaction, client) {
      guard(interaction);
      const value = interaction.values?.[0];
      if (!Object.hasOwn(ARCHIVE_DURATIONS, value ?? '')) throw new UserError('Durée inconnue.');
      save(client, interaction.guildId, { autoThreads: { archiveMinutes: Number(value) } });
      await interaction.update(threadsView(client, interaction.guild, `${ICONS.success} Archivage après **${ARCHIVE_DURATIONS[value]}** d'inactivité.`));
    },
    async thname(interaction, client) {
      guard(interaction);
      const th = settings(client, interaction.guildId).autoThreads ?? {};
      const input = new TextInputBuilder()
        .setCustomId('template')
        .setLabel('Nom du fil ({pseudo}, {n})')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(MAX_TEMPLATE)
        .setRequired(true)
        .setPlaceholder(DEFAULT_THREAD_NAME)
        .setValue(truncate(th.nameTemplate || DEFAULT_THREAD_NAME, MAX_TEMPLATE));
      await interaction.showModal(new ModalBuilder().setCustomId('cmd:automatisations:thnamesubmit').setTitle('Fils automatiques : nom').addComponents(row(input)));
    },
    async thnamesubmit(interaction, client) {
      guard(interaction);
      // eslint-disable-next-line no-control-regex
      const template = String(textField(interaction, 'template') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!template || template.length > MAX_TEMPLATE) throw new UserError(`Nom du fil : 1 à ${MAX_TEMPLATE} caractères.`);
      const unknown = unknownVariables(template, ['pseudo', 'n']);
      if (unknown.length) throw new UserError(`Variable(s) inconnue(s) : ${unknown.map((v) => `\`{${v}}\``).join(', ')}. Disponibles : \`{pseudo}\` et \`{n}\`.`);
      save(client, interaction.guildId, { autoThreads: { nameTemplate: template } });
      await interaction.update(threadsView(client, interaction.guild, `${ICONS.success} Nom des fils : ${code(truncate(template, 100))}.`));
    },

    // ------------------------------------------------------------ rôle vocal

    /** Rôle global (vide : retiré). */
    async vrrole(interaction, client) {
      guard(interaction);
      const { guild } = interaction;
      const id = interaction.values?.[0] ?? null;
      const cfg = settings(client, guild.id).voiceRole ?? {};
      const before = managedVoiceRoles(cfg);
      if (id) {
        const role = assertVoiceRole(interaction, client, id);
        if ((cfg.channels ?? []).some((l) => l.roleId === role.id)) throw new UserError(`${role} est déjà le rôle d'un salon : choisissez un autre rôle global.`);
      }
      save(client, guild.id, { voiceRole: { roleId: id } });
      afterVoiceChange(client, guild, before);
      await interaction.update(voiceView(client, guild, id ? `${ICONS.success} Rôle global : <@&${id}>.` : `${ICONS.success} Rôle global retiré.`));
    },
    /** Salon vocal choisi : vue de son rôle. */
    async vrpick(interaction, client) {
      guard(interaction);
      await interaction.update(voiceChannelView(client, interaction.guild, interaction.values?.[0]));
    },
    /** cmd:automatisations:vrset:<salon> — rôle d'un salon (vide : association retirée). */
    async vrset(interaction, client, [channelId]) {
      guard(interaction);
      const { guild } = interaction;
      voiceChannelView(client, guild, channelId); // valide le salon
      const id = interaction.values?.[0] ?? null;
      const cfg = settings(client, guild.id).voiceRole ?? {};
      const before = managedVoiceRoles(cfg);
      const others = (cfg.channels ?? []).filter((l) => l.channelId !== channelId);
      if (id) {
        const role = assertVoiceRole(interaction, client, id);
        if (role.id === cfg.roleId) throw new UserError(`${role} est déjà le rôle global : choisissez un rôle propre à ce salon.`);
        if (others.length >= MAX_VOICE_LINKS) throw new UserError(`${MAX_VOICE_LINKS} salons au plus : retirez une association d'abord.`);
      }
      const channels = id ? [...others, { channelId, roleId: id }] : others;
      save(client, guild.id, { voiceRole: { channels } });
      afterVoiceChange(client, guild, before);
      await interaction.update(voiceView(client, guild, id ? `${ICONS.success} <#${channelId}> → <@&${id}>.` : `${ICONS.success} Association de <#${channelId}> retirée.`));
    },
    /** Retire une association salon → rôle. */
    async vrdel(interaction, client) {
      guard(interaction);
      const { guild } = interaction;
      const channelId = interaction.values?.[0];
      const cfg = settings(client, guild.id).voiceRole ?? {};
      const before = managedVoiceRoles(cfg);
      const channels = (cfg.channels ?? []).filter((l) => l.channelId !== channelId);
      if (channels.length === (cfg.channels ?? []).length) throw new UserError('Cette association n\'existe plus.');
      save(client, guild.id, { voiceRole: { channels } });
      afterVoiceChange(client, guild, before);
      await interaction.update(voiceView(client, guild, `${ICONS.success} Association de <#${channelId}> retirée.`));
    },
    /** Rattrapage manuel (en arrière-plan). */
    async vrsync(interaction, client) {
      guard(interaction);
      if (!settings(client, interaction.guildId).voiceRole?.enabled) throw new UserError('Activez d\'abord le rôle vocal.');
      const svc = client.services.automations;
      svc.runInBackground(svc.reconcileGuild(interaction.guild));
      await interaction.update(voiceView(client, interaction.guild, `${ICONS.success} Resynchronisation lancée : les rôles des membres en vocal (et des autres) sont remis à jour.`));
    },

    // ------------------------------------------------------------ boosts

    async bochannel(interaction, client) {
      guard(interaction);
      const { guild } = interaction;
      const id = interaction.values?.[0] ?? null;
      let notice = `${ICONS.success} Salon du remerciement retiré.`;
      if (id) {
        if (!SNOWFLAKE.test(id) || !TEXT_TYPES.includes(guild.channels.cache.get(id)?.type)) throw new UserError('Choisissez un salon textuel de ce serveur.');
        const issue = channelIssue(guild, id);
        notice = issue ? `${ICONS.warning} Salon enregistré, mais je ne peux pas y publier : ${issue}.` : `${ICONS.success} Remerciements publiés dans <#${id}>.`;
      }
      save(client, guild.id, { boost: { channelId: id } });
      await interaction.update(boostView(client, guild, notice, interaction.user));
    },
    async borole(interaction, client) {
      guard(interaction);
      const { guild } = interaction;
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!SNOWFLAKE.test(id)) throw new UserError('Rôle invalide.');
        const issue = assignableRoleIssue(guild, guild.roles.cache.get(id), interaction.member);
        if (issue) throw new UserError(issue);
      }
      save(client, guild.id, { boost: { roleId: id } });
      await interaction.update(boostView(client, guild, id ? `${ICONS.success} Rôle des boosters : <@&${id}>.` : `${ICONS.success} Rôle des boosters retiré.`, interaction.user));
    },
    async bomsg(interaction, client) {
      guard(interaction);
      const bo = settings(client, interaction.guildId).boost ?? {};
      const input = new TextInputBuilder()
        .setCustomId('message')
        .setLabel('Message ({membre}, {serveur}, {boosts})')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(MAX_BOOST_MESSAGE)
        .setRequired(false)
        .setPlaceholder(truncate(DEFAULT_BOOST_MESSAGE, 100))
        .setValue(truncate(bo.message || DEFAULT_BOOST_MESSAGE, MAX_BOOST_MESSAGE));
      await interaction.showModal(new ModalBuilder().setCustomId('cmd:automatisations:bomsgsubmit').setTitle('Remerciement de boost').addComponents(row(input)));
    },
    async bomsgsubmit(interaction, client) {
      guard(interaction);
      const message = textField(interaction, 'message') ?? null;
      if (message && message.length > MAX_BOOST_MESSAGE) throw new UserError(`Message : ${MAX_BOOST_MESSAGE} caractères au plus.`);
      const unknown = unknownVariables(message, Object.keys(BOOST_VARIABLES));
      if (unknown.length) throw new UserError(`Variable(s) inconnue(s) : ${unknown.map((v) => `\`{${v}}\``).join(', ')}. Disponibles : \`{membre}\`, \`{serveur}\`, \`{boosts}\`.`);
      save(client, interaction.guildId, { boost: { message: message === DEFAULT_BOOST_MESSAGE ? null : message } });
      await interaction.update(boostView(client, interaction.guild, `${ICONS.success} Message ${message ? 'enregistré' : 'par défaut rétabli'} : aperçu ci-dessous.`, interaction.user));
    },
  },
};
