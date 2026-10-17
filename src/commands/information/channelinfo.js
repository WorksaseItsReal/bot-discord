'use strict';

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, linkButton, buttonRows, actionButton, status, fitEmbeds, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp, formatDuration } = require('../../utils/time');
const { truncate } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');
const { assertCanManageChannel } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');
const { ChannelRenewService, CONFIRM_WORD } = require('../../services/ChannelRenewService');
const { logCard } = require('../../services/LoggingService');
const { assertInvoker, snowflake } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

/**
 * /channel : informations d'un salon (`info`, ouvert à tous) et gestion des salons
 * (`creer`, `supprimer`, `cloner`, `renommer`, `sujet`, `nsfw`, `renouveler`) — « Gérer les salons »
 * exigée sur le salon visé (revérifiée par le bot), confirmation avant toute suppression.
 * Chaque action de gestion est pré-contrôlée par Secur / AntiRaid AVANT Discord (le journal
 * d'audit l'attribue au bot), puis signalée au nom de l'auteur après succès.
 * `renouveler` recrée le salon à l'identique et reporte la configuration (ChannelRenewService),
 * après une confirmation forte (mot à recopier) ; jamais délégable (permissions natives).
 *
 * Changement d'usage : l'ancien `/channel [salon]` s'écrit désormais `/channel info [salon]`.
 */

/** Type de salon → [icône, libellé]. */
const TYPES = {
  [ChannelType.GuildText]: ['#️⃣', 'Textuel'],
  [ChannelType.GuildVoice]: [ICONS.voice, 'Vocal'],
  [ChannelType.GuildCategory]: [ICONS.category, 'Catégorie'],
  [ChannelType.GuildAnnouncement]: ['📢', 'Annonces'],
  [ChannelType.GuildForum]: ['🗨️', 'Forum'],
  [ChannelType.GuildMedia]: [ICONS.image, 'Médias'],
  [ChannelType.GuildStageVoice]: ['🎙️', 'Conférence'],
  [ChannelType.PublicThread]: ['🧵', 'Fil public'],
  [ChannelType.PrivateThread]: ['🧵', 'Fil privé'],
  [ChannelType.AnnouncementThread]: ['🧵', 'Fil d\'annonces'],
};

const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
/** Salons gérables par les sous-commandes de gestion (pas les fils). */
const MANAGED_TYPES = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildStageVoice, ChannelType.GuildMedia];
/** Salons renouvelables (ni catégorie, ni fil). */
const RENEW_TYPES = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildStageVoice, ChannelType.GuildMedia];
/** Salons avec un sujet. */
const TOPIC_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia];
/** Salons pouvant être marqués NSFW. */
const NSFW_TYPES = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildStageVoice, ChannelType.GuildMedia];
/** Types proposés par /channel creer. */
const CREATE_TYPES = {
  texte: ChannelType.GuildText,
  vocal: ChannelType.GuildVoice,
  annonces: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  categorie: ChannelType.GuildCategory,
  conference: ChannelType.GuildStageVoice,
};
const MAX_TOPIC = 1024;

function typeMeta(channel) {
  return TYPES[channel.type] ?? [ICONS.channel, `Type ${channel.type}`];
}

/** Champs propres au type de salon. */
function specificFields(channel) {
  if (VOICE_TYPES.has(channel.type)) {
    return [
      field(ICONS.members, 'Connectés', `**${channel.members?.size ?? 0}**${channel.userLimit ? ` / ${channel.userLimit}` : ''}`),
      field('🎚️', 'Débit', channel.bitrate ? `\`${Math.round(channel.bitrate / 1000)} kbps\`` : null),
      field(ICONS.count, 'Limite', channel.userLimit ? `**${channel.userLimit}** membres` : 'Illimitée'),
    ];
  }
  if (channel.type === ChannelType.GuildCategory) {
    return [field(ICONS.channel, 'Salons', `**${channel.children?.cache?.size ?? 0}**`)];
  }
  const out = [];
  if ('rateLimitPerUser' in channel) {
    out.push(field(ICONS.duration, 'Mode lent', channel.rateLimitPerUser ? `\`${formatDuration(channel.rateLimitPerUser * 1000)}\`` : 'Désactivé'));
  }
  if ('nsfw' in channel) out.push(field('🔞', 'NSFW', channel.nsfw ? 'Oui' : 'Non'));
  if (channel.threads?.cache) out.push(field('🧵', 'Fils actifs', `**${channel.threads.cache.filter((t) => !t.archived).size}**`));
  return out;
}

const channelUrl = (guild, channel) => `https://discord.com/channels/${guild.id}/${channel.id}`;

/** Nom de salon saisi : 1 à 100 caractères, sans saut de ligne. Pur. */
function cleanChannelName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('Le nom du salon ne peut pas être vide.');
  if ([...name].length > 100) throw new UserError('Nom trop long (100 caractères au maximum).');
  return name;
}

/** Salon d'une option (cache du serveur prioritaire), ou le salon courant. */
function pickChannel(interaction, option = 'salon', { required = false } = {}) {
  const picked = interaction.options.getChannel(option, required);
  const channel = picked ? interaction.guild.channels.cache.get(picked.id) ?? picked : interaction.channel;
  if (!channel || (channel.guildId && channel.guildId !== interaction.guildId)) throw new UserError('Salon introuvable sur ce serveur.');
  return channel;
}

/** Gestion : « Gérer les salons » (membre, revérifiée sur le salon) et salon gérable par le bot. */
function assertManageable(interaction, channel) {
  requirePermission(interaction, 'ManageChannels');
  if (channel.isThread?.()) throw new UserError('Les fils se gèrent depuis leur salon parent : choisissez un salon.');
  assertCanManageChannel(interaction.member, channel);
  if (channel.manageable === false) throw new UserError(`Je ne peux pas gérer ${channel} : il me faut la permission **Gérer les salons** sur ce salon.`);
}

/**
 * Création d'un salon (creer, cloner) : « Gérer les salons » dans la catégorie d'arrivée
 * (permissions propres) ; à la racine, au niveau du serveur. Une surcharge sur un seul
 * salon ne permet pas d'en créer d'autres (comme dans Discord).
 */
function assertCanCreateIn(interaction, parent) {
  if (parent) {
    assertCanManageChannel(interaction.member, parent);
    return;
  }
  if (interaction.member?.permissions?.has && !interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserError('Il vous faut la permission **Gérer les salons** sur le serveur pour créer un salon hors catégorie.');
  }
}

/** Carte de résultat d'une action de gestion. */
function actionCard({ tone = 'success', icon, title, description, channel, moderator, fields = [] }) {
  return card({
    tone,
    section: 'information',
    icon,
    title,
    description,
    fields: [
      channel ? field(ICONS.channel, 'Salon', `${channel}`) : null,
      ...fields,
      field(ICONS.moderator, 'Par', moderator ? `${moderator}` : '—'),
    ],
  });
}

const reasonOf = (interaction, verb) => truncate(`${verb} par ${interaction.user.tag}`, 400);

/**
 * Pré-contrôle Secur / AntiRaid AVANT tout appel à Discord : l'action, signée par le bot dans le
 * journal d'audit, échapperait sinon à la détection. Refus d'emblée (UserError) au seuil.
 */
function preCheck(interaction, type) {
  interaction.client?.services?.secur?.assertAllowed?.(interaction, type);
}

/** Signalement APRÈS succès, au nom de l'auteur (best-effort, ne lève jamais). */
async function reportAction(interaction, type) {
  try {
    await interaction.client?.services?.moderation?.reportDestructiveAction?.(interaction.guild, interaction.user, type);
  } catch {
    /* la détection ne fait jamais échouer l'action déjà faite */
  }
}

// ---------------------------------------------------------------- sous-commandes

async function info(interaction) {
  const channel = pickChannel(interaction);
  const [typeIcon, typeLabel] = typeMeta(channel);
  const everyone = interaction.guild.roles.everyone;
  const isPublic = channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.ViewChannel);

  const fields = [
    field(ICONS.id, 'Identifiant', code(channel.id)),
    field(ICONS.status, 'Type', `${typeIcon} ${typeLabel}`),
    field(ICONS.category, 'Catégorie', channel.parent ? channel.parent.name : '*Aucune*'),
    field(ICONS.date, 'Créé', channel.createdTimestamp ? `${discordTimestamp(channel.createdTimestamp, 'D')}\n${discordTimestamp(channel.createdTimestamp, 'R')}` : null),
    field(isPublic === false ? ICONS.lock : ICONS.visible, 'Visibilité', isPublic == null ? null : isPublic ? 'Public' : 'Privé'),
    field(ICONS.list, 'Position', channel.rawPosition != null ? `**${channel.rawPosition + 1}**` : null),
    ...specificFields(channel),
  ];
  if (channel.topic) fields.push(wide(ICONS.reason, 'Sujet', channel.topic));

  await interaction.reply({
    embeds: [
      card({
        tone: 'brand',
        section: 'information',
        icon: typeIcon,
        title: channel.name,
        description: [`${channel}`, subtext(`${typeLabel}${channel.parent ? ` dans ${channel.parent.name}` : ''}`)],
        fields,
      }),
    ],
    components: buttonRows(linkButton('Ouvrir', channelUrl(interaction.guild, channel), ICONS.link)),
  });
}

async function create(interaction) {
  requirePermission(interaction, 'ManageChannels');
  const guild = interaction.guild;
  const name = cleanChannelName(interaction.options.getString('nom'));
  const typeKey = interaction.options.getString('type') ?? 'texte';
  const type = CREATE_TYPES[typeKey];
  if (type == null) throw new UserError('Type de salon inconnu.');
  const pickedParent = interaction.options.getChannel('categorie');
  const parent = pickedParent ? guild.channels.cache.get(pickedParent.id) ?? pickedParent : null;
  const topic = interaction.options.getString('sujet')?.trim() || null;
  if (parent && parent.type !== ChannelType.GuildCategory) throw new UserError('La catégorie choisie n\'en est pas une.');
  if (parent && type === ChannelType.GuildCategory) throw new UserError('Une catégorie ne peut pas être rangée dans une autre catégorie.');
  if (topic && !TOPIC_TYPES.includes(type)) throw new UserError('Seuls les salons textuels, d\'annonces et les forums ont un sujet.');
  assertCanCreateIn(interaction, parent);
  const me = guild.members.me;
  const botPerms = parent ? parent.permissionsFor?.(me) : me?.permissions;
  if (botPerms && !botPerms.has(PermissionFlagsBits.ManageChannels)) throw new UserError('Il me manque la permission **Gérer les salons** pour créer ce salon.');
  preCheck(interaction, 'channelCreate');
  await interaction.deferReply({ ephemeral: true });
  const channel = await guild.channels.create({ name, type, parent: parent?.id ?? undefined, topic: topic ?? undefined, reason: reasonOf(interaction, 'Créé') });
  const [icon, label] = typeMeta(channel);
  await interaction.editReply({
    embeds: [actionCard({
      icon: ICONS.success,
      title: 'Salon créé',
      description: `${icon} ${channel} (${label.toLowerCase()}) est prêt${parent ? ` dans **${parent.name}**` : ''}.`,
      channel,
      moderator: interaction.user,
      fields: [field(ICONS.id, 'Identifiant', code(channel.id)), topic ? wide(ICONS.reason, 'Sujet', truncate(topic, 1024)) : null],
    })],
    components: buttonRows(linkButton('Ouvrir', channelUrl(guild, channel), ICONS.link)),
  });
  await reportAction(interaction, 'channelCreate');
}

async function remove(interaction) {
  const guild = interaction.guild;
  const channel = pickChannel(interaction, 'salon', { required: true });
  assertManageable(interaction, channel);
  if (channel.id === interaction.channelId) throw new UserError('Lancez cette commande depuis un autre salon : je ne peux pas supprimer le salon où vous êtes en train de répondre.');
  if ([guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId].includes(channel.id)) {
    throw new UserError(`${channel} est requis par la communauté du serveur (règles, annonces de Discord) : changez-le d'abord dans les paramètres du serveur.`);
  }
  if (channel.deletable === false) throw new UserError(`Je ne peux pas supprimer ${channel} : il me faut la permission **Gérer les salons** sur ce salon.`);
  preCheck(interaction, 'channelDelete');
  const children = channel.type === ChannelType.GuildCategory ? channel.children?.cache?.size ?? 0 : 0;
  const name = channel.name;
  const [icon, label] = typeMeta(channel);
  const ok = await confirm(interaction, {
    description: [
      `Supprimer définitivement ${icon} ${channel} (${label.toLowerCase()}) ? Ses messages seront perdus.`,
      children ? `Ses **${children}** salon(s) resteront, sans catégorie.` : null,
    ].filter(Boolean).join('\n'),
    confirmLabel: 'Supprimer',
  });
  if (!ok) return;
  // Relu après la confirmation : supprimé entre-temps ?
  if (!guild.channels.cache.has(channel.id)) throw new UserError('Ce salon a déjà été supprimé.');
  // Revérifié après la confirmation (jusqu'à 30 s) : la fenêtre de détection a pu se remplir.
  preCheck(interaction, 'channelDelete');
  await channel.delete(reasonOf(interaction, 'Supprimé'));
  try {
    await interaction.editReply({
      embeds: [actionCard({
        tone: 'danger',
        icon: ICONS.delete,
        title: 'Salon supprimé',
        description: `Le salon **${truncate(name, 100)}** a été supprimé.`,
        moderator: interaction.user,
        fields: [field(ICONS.status, 'Type', `${icon} ${label}`), field(ICONS.id, 'Identifiant', code(channel.id))],
      })],
      components: [],
    });
  } finally {
    // Suppression signée par le bot dans l'audit log : le MODÉRATEUR est signalé à l'AntiRaid
    // (suppressions de salons en masse), après la réponse, MÊME si elle échoue (message disparu…).
    await reportAction(interaction, 'channelDelete');
  }
}

async function clone(interaction) {
  const guild = interaction.guild;
  const source = pickChannel(interaction);
  assertManageable(interaction, source);
  const name = interaction.options.getString('nom') ? cleanChannelName(interaction.options.getString('nom')) : undefined;
  const parent = source.parent;
  // La copie est un NOUVEAU salon : même contrôle que /channel creer (catégorie ou serveur).
  assertCanCreateIn(interaction, parent);
  const me = guild.members.me;
  const botPerms = parent ? parent.permissionsFor?.(me) : me?.permissions;
  if (botPerms && !botPerms.has(PermissionFlagsBits.ManageChannels)) throw new UserError('Il me manque la permission **Gérer les salons** pour créer la copie.');
  preCheck(interaction, 'channelCreate');
  await interaction.deferReply({ ephemeral: true });
  // « name » absent : la copie garde le nom d'origine (une clé à undefined l'effacerait).
  const copy = await source.clone({ ...(name ? { name } : {}), reason: reasonOf(interaction, `Copie de #${source.name}`) });
  await interaction.editReply({
    embeds: [actionCard({
      icon: '🧬',
      title: 'Salon cloné',
      description: `${copy} est une copie de ${source} (type, sujet, permissions et réglages ; sans les messages).`,
      channel: copy,
      moderator: interaction.user,
      fields: [field(ICONS.id, 'Identifiant', code(copy.id))],
    })],
    components: buttonRows(linkButton('Ouvrir', channelUrl(guild, copy), ICONS.link)),
  });
  await reportAction(interaction, 'channelCreate');
}

async function rename(interaction) {
  const channel = pickChannel(interaction);
  assertManageable(interaction, channel);
  const name = cleanChannelName(interaction.options.getString('nom'));
  const before = channel.name;
  if (name === before) throw new UserError(`${channel} s'appelle déjà ainsi.`);
  preCheck(interaction, 'channelUpdate');
  // Discord limite les renommages d'un salon (2 toutes les 10 minutes) : la requête peut attendre.
  await interaction.deferReply({ ephemeral: true });
  const updated = await channel.setName(name, reasonOf(interaction, 'Renommé'));
  await interaction.editReply({
    embeds: [actionCard({
      icon: '✏️',
      title: 'Salon renommé',
      description: `**${truncate(before, 100)}** s'appelle désormais ${updated ?? channel}.`,
      channel: updated ?? channel,
      moderator: interaction.user,
      fields: [field(ICONS.tag, 'Nouveau nom', code(truncate((updated ?? channel).name, 100)))],
    })],
  });
  await reportAction(interaction, 'channelUpdate');
}

async function topic(interaction) {
  const channel = pickChannel(interaction);
  assertManageable(interaction, channel);
  if (!TOPIC_TYPES.includes(channel.type) || typeof channel.setTopic !== 'function') throw new UserError('Seuls les salons textuels, d\'annonces et les forums ont un sujet.');
  const text = interaction.options.getString('texte')?.trim() || null;
  if (text && [...text].length > MAX_TOPIC) throw new UserError(`Sujet trop long (${MAX_TOPIC} caractères au maximum).`);
  if ((channel.topic ?? null) === text) throw new UserError(text ? 'Ce salon a déjà ce sujet.' : 'Ce salon n\'a déjà pas de sujet.');
  preCheck(interaction, 'channelUpdate');
  // Discord limite les changements de nom et de sujet (2 toutes les 10 minutes) : la requête peut attendre.
  await interaction.deferReply({ ephemeral: true });
  await channel.setTopic(text, reasonOf(interaction, 'Sujet modifié'));
  await interaction.editReply({
    embeds: [actionCard({
      icon: ICONS.reason,
      title: text ? 'Sujet modifié' : 'Sujet retiré',
      description: text ? `Le sujet de ${channel} a été mis à jour.` : `${channel} n'a plus de sujet.`,
      channel,
      moderator: interaction.user,
      fields: [text ? wide(ICONS.reason, 'Sujet', truncate(text, 1024)) : null],
    })],
  });
  await reportAction(interaction, 'channelUpdate');
}

async function nsfw(interaction) {
  const channel = pickChannel(interaction);
  assertManageable(interaction, channel);
  if (!NSFW_TYPES.includes(channel.type) || typeof channel.setNSFW !== 'function') throw new UserError('Ce type de salon ne peut pas être marqué NSFW.');
  const on = interaction.options.getBoolean('actif', true);
  if (Boolean(channel.nsfw) === on) throw new UserError(`${channel} est déjà ${on ? 'réservé aux adultes (NSFW)' : 'tout public'}.`);
  preCheck(interaction, 'channelUpdate');
  // Modification du salon : la requête peut attendre une limite de Discord (délai de 3 s).
  await interaction.deferReply({ ephemeral: true });
  await channel.setNSFW(on, reasonOf(interaction, on ? 'NSFW activé' : 'NSFW désactivé'));
  await interaction.editReply({
    embeds: [actionCard({
      tone: on ? 'caution' : 'success',
      icon: '🔞',
      title: on ? 'Salon NSFW' : 'Salon tout public',
      description: on ? `${channel} est désormais réservé aux adultes : Discord demande une confirmation d'âge.` : `${channel} n'est plus marqué NSFW.`,
      channel,
      moderator: interaction.user,
    })],
  });
  await reportAction(interaction, 'channelUpdate');
}

// ---------------------------------------------------------------- /channel renouveler

const RENEW_ICON = '♻️';

/** Liste à puces bornée pour un champ (1 024 caractères). Pur. */
function boundedList(items, empty) {
  if (!items.length) return empty;
  const out = [];
  let used = 0;
  for (const [i, item] of items.entries()) {
    const line = `› ${item}`;
    if (used + line.length + 1 > 960) {
      out.push(subtext(`… et ${items.length - i} autre(s)`));
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

/** Carte du bilan avant confirmation : ce qui est reporté, ce qui est perdu. Pur. */
function renewPlanView(channel, plan, ownerId) {
  const [icon, label] = typeMeta(channel);
  return {
    embeds: [card({
      tone: 'warning',
      section: 'information',
      icon: RENEW_ICON,
      title: `Renouveler #${truncate(channel.name, 90)} ?`,
      description: [
        `${icon} ${channel} (${label.toLowerCase()}) sera **recréé à l'identique** — même place, même catégorie, mêmes permissions, sujet, mode lent et NSFW — puis l'original sera **supprimé**.`,
        subtext(`Confirmation forte : il faudra recopier ${CONFIRM_WORD}. Un renouvellement toutes les 30 s par serveur au plus.`),
      ],
      fields: [
        wide(ICONS.success, 'Reporté sur le nouveau salon', boundedList(plan.carried, '*Aucun réglage du bot ne vise ce salon.*')),
        wide(ICONS.delete, 'Perdu', boundedList(plan.lost, '—')),
      ],
    })],
    components: buttonRows(
      actionButton({ command: 'channel', action: 'renewform', args: [channel.id, ownerId], label: 'Renouveler', emoji: RENEW_ICON, style: ButtonStyle.Danger }),
      actionButton({ command: 'channel', action: 'renewcancel', args: [ownerId], label: 'Annuler', emoji: ICONS.error }),
    ),
  };
}

function renewModal(channelId, ownerId) {
  return new ModalBuilder()
    .setCustomId(`cmd:channel:renew:${channelId}:${ownerId}`)
    .setTitle('Renouveler le salon')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('confirmation').setLabel(`Tapez ${CONFIRM_WORD} pour confirmer`).setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(20).setPlaceholder(CONFIRM_WORD),
    ));
}

/** Carte du résultat (réponse à l'auteur, et carte publique si c'était le salon courant). */
function renewResultCard({ created, name, plan, notes, moderator, publicCard = false }) {
  if (publicCard) {
    return card({
      tone: 'info',
      section: 'information',
      icon: RENEW_ICON,
      title: 'Salon renouvelé',
      description: `Ce salon a été renouvelé par ${moderator} : l'historique a été vidé, les permissions et réglages sont conservés.`,
    });
  }
  return card({
    tone: 'success',
    section: 'information',
    icon: RENEW_ICON,
    title: 'Salon renouvelé',
    description: `${created} remplace **#${truncate(name, 90)}** : même place, mêmes permissions et réglages ; l'historique a été vidé.`,
    fields: [
      wide(ICONS.success, 'Reporté', boundedList(plan.carried, '*Aucun réglage à reporter.*')),
      notes.length ? wide(ICONS.warning, 'À vérifier', boundedList(notes, '—')) : null,
      field(ICONS.id, 'Nouvel identifiant', code(created.id)),
      field(ICONS.moderator, 'Par', `${moderator}`),
    ],
  });
}

async function renewCommand(interaction, client) {
  const channel = pickChannel(interaction);
  const plan = new ChannelRenewService({ client }).check(interaction, channel);
  await interaction.reply({ ...renewPlanView(channel, plan, interaction.user.id), ephemeral: true });
}

/** cmd:channel:renew:<channelId>:<ownerId> — formulaire soumis : renouvellement (revérifié). */
async function renewSubmit(interaction, client, [rawChannelId, ownerId]) {
  assertInvoker(interaction, ownerId);
  const channelId = snowflake(rawChannelId, 'salon');
  let typed = '';
  try {
    typed = interaction.fields.getTextInputValue('confirmation') ?? '';
  } catch {
    typed = '';
  }
  if (typed.trim().toUpperCase() !== CONFIRM_WORD) {
    throw new UserError(`Confirmation incorrecte : tapez exactement \`${CONFIRM_WORD}\`. Le salon n'a pas été touché.`);
  }
  const guild = interaction.guild;
  const result = await new ChannelRenewService({ client }).renew(interaction, channelId, { onLocked: () => interaction.deferUpdate() });
  const { created, name, plan, notes, wasCurrent, oldId } = result;
  // 7. Réponse (le message d'origine a pu disparaître avec l'ancien salon).
  await interaction.editReply({
    embeds: [renewResultCard({ created, name, plan, notes, moderator: interaction.user })],
    components: buttonRows(linkButton('Ouvrir', channelUrl(guild, created), ICONS.link)),
  }).catch(() => {});
  if (wasCurrent) {
    await created.send({ embeds: fitEmbeds([renewResultCard({ moderator: interaction.user, publicCard: true })], { guildId: guild.id }), allowedMentions: { parse: [] } }).catch(() => {});
  }
  // Suppression signée par le bot : l'AUTEUR est signalé (une action).
  await reportAction(interaction, 'channelDelete');
  // 8. PUIS le log.
  await client.services?.logging?.send?.(guild.id, 'channels', logCard({
    category: 'channels',
    tone: 'caution',
    icon: RENEW_ICON,
    title: 'Salon renouvelé',
    description: `**#${truncate(name, 90)}** a été recréé à l'identique : ${created}. L'historique a été vidé.`,
    fields: [
      field(ICONS.moderator, 'Par', `${interaction.user}`),
      field(ICONS.id, 'Ancien identifiant', code(oldId)),
      field(ICONS.count, 'Réglages reportés', `**${plan.carried.length}**`),
    ],
    id: created.id,
  }), undefined, { event: 'channelRenew' });
}

const HANDLERS = { info, creer: create, supprimer: remove, cloner: clone, renommer: rename, sujet: topic, nsfw, renouveler: renewCommand };

module.exports = {
  category: 'information',
  cleanChannelName,
  CREATE_TYPES,
  renewPlanView,
  renewResultCard,
  data: new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Informations d\'un salon et gestion des salons (créer, supprimer, cloner…).')
    .addSubcommand((s) =>
      s.setName('info').setDescription('Affiche les informations d\'un salon.')
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon à inspecter (par défaut : le salon actuel)')))
    .addSubcommand((s) =>
      s.setName('creer').setDescription('Crée un salon (Gérer les salons).')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du nouveau salon').setRequired(true).setMaxLength(100))
        .addStringOption((o) =>
          o.setName('type').setDescription('Type de salon (textuel par défaut)').addChoices(
            { name: 'Textuel', value: 'texte' },
            { name: 'Vocal', value: 'vocal' },
            { name: 'Annonces', value: 'annonces' },
            { name: 'Forum', value: 'forum' },
            { name: 'Catégorie', value: 'categorie' },
            { name: 'Conférence', value: 'conference' },
          ))
        .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie où ranger le salon').addChannelTypes(ChannelType.GuildCategory))
        .addStringOption((o) => o.setName('sujet').setDescription('Sujet du salon (textuel, annonces, forum)').setMaxLength(MAX_TOPIC)))
    .addSubcommand((s) =>
      s.setName('supprimer').setDescription('Supprime un salon, après confirmation (Gérer les salons).')
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon à supprimer définitivement').setRequired(true).addChannelTypes(...MANAGED_TYPES)))
    .addSubcommand((s) =>
      s.setName('cloner').setDescription('Crée une copie d\'un salon, sans ses messages (Gérer les salons).')
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon à copier (par défaut : le salon actuel)').addChannelTypes(...MANAGED_TYPES))
        .addStringOption((o) => o.setName('nom').setDescription('Nom de la copie (par défaut : le même)').setMaxLength(100)))
    .addSubcommand((s) =>
      s.setName('renommer').setDescription('Renomme un salon (Gérer les salons).')
        .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom du salon').setRequired(true).setMaxLength(100))
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon à renommer (par défaut : le salon actuel)').addChannelTypes(...MANAGED_TYPES)))
    .addSubcommand((s) =>
      s.setName('sujet').setDescription('Modifie ou retire le sujet d\'un salon (Gérer les salons).')
        .addStringOption((o) => o.setName('texte').setDescription('Nouveau sujet (vide : retire le sujet)').setMaxLength(MAX_TOPIC))
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon concerné (par défaut : le salon actuel)').addChannelTypes(...TOPIC_TYPES)))
    .addSubcommand((s) =>
      s.setName('nsfw').setDescription('Réserve un salon aux adultes, ou le rend tout public (Gérer les salons).')
        .addBooleanOption((o) => o.setName('actif').setDescription('Oui : réservé aux adultes · Non : tout public').setRequired(true))
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon concerné (par défaut : le salon actuel)').addChannelTypes(...NSFW_TYPES)))
    .addSubcommand((s) =>
      s.setName('renouveler').setDescription('Recrée un salon à l\'identique, sans ses messages, après confirmation (Gérer les salons).')
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon à recréer vide (par défaut : le salon actuel)').addChannelTypes(...RENEW_TYPES))),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client = interaction.client) {
    const handler = HANDLERS[interaction.options.getSubcommand()];
    if (!handler) throw new UserError('Sous-commande inconnue.');
    return handler(interaction, client);
  },

  buttons: {
    /** cmd:channel:renewform:<channelId>:<ownerId> — revérifie tout, puis ouvre la confirmation forte. */
    async renewform(interaction, client, [rawChannelId, ownerId]) {
      assertInvoker(interaction, ownerId);
      const channelId = snowflake(rawChannelId, 'salon');
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel) throw new UserError('Ce salon n\'existe plus (déjà renouvelé ou supprimé).');
      new ChannelRenewService({ client }).check(interaction, channel);
      await interaction.showModal(renewModal(channelId, ownerId));
    },
    /** cmd:channel:renewcancel:<ownerId> */
    async renewcancel(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.update({ embeds: [status.warn('Renouvellement annulé. Rien n\'a été modifié.')], components: [] });
    },
    /** cmd:channel:renew:<channelId>:<ownerId> (formulaire) */
    renew: renewSubmit,
  },
};
