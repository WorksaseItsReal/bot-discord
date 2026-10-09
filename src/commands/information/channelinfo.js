'use strict';

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, linkButton, buttonRows } = require('../../utils/ui');
const { discordTimestamp, formatDuration } = require('../../utils/time');
const { truncate } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');
const { assertCanManageChannel } = require('../../services/LockdownService');
const { requirePermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/**
 * /channel : informations d'un salon (`info`, ouvert à tous) et gestion des salons
 * (`creer`, `supprimer`, `cloner`, `renommer`, `sujet`, `nsfw`) — « Gérer les salons »
 * exigée sur le salon visé (revérifiée par le bot), confirmation avant toute suppression.
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
  // Création dans une catégorie : « Gérer les salons » vérifiée dans cette catégorie (permissions propres) ;
  // à la racine : au niveau du serveur (une surcharge sur le salon courant ne suffit pas).
  if (parent) assertCanManageChannel(interaction.member, parent);
  else if (interaction.member?.permissions?.has && !interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserError('Il vous faut la permission **Gérer les salons** sur le serveur pour créer un salon hors catégorie.');
  }
  const me = guild.members.me;
  const botPerms = parent ? parent.permissionsFor?.(me) : me?.permissions;
  if (botPerms && !botPerms.has(PermissionFlagsBits.ManageChannels)) throw new UserError('Il me manque la permission **Gérer les salons** pour créer ce salon.');
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
  await channel.delete(reasonOf(interaction, 'Supprimé'));
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
}

async function clone(interaction) {
  const guild = interaction.guild;
  const source = pickChannel(interaction);
  assertManageable(interaction, source);
  const name = interaction.options.getString('nom') ? cleanChannelName(interaction.options.getString('nom')) : undefined;
  const parent = source.parent;
  const me = guild.members.me;
  const botPerms = parent ? parent.permissionsFor?.(me) : me?.permissions;
  if (botPerms && !botPerms.has(PermissionFlagsBits.ManageChannels)) throw new UserError('Il me manque la permission **Gérer les salons** pour créer la copie.');
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
}

async function rename(interaction) {
  const channel = pickChannel(interaction);
  assertManageable(interaction, channel);
  const name = cleanChannelName(interaction.options.getString('nom'));
  const before = channel.name;
  if (name === before) throw new UserError(`${channel} s'appelle déjà ainsi.`);
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
}

async function topic(interaction) {
  const channel = pickChannel(interaction);
  assertManageable(interaction, channel);
  if (!TOPIC_TYPES.includes(channel.type) || typeof channel.setTopic !== 'function') throw new UserError('Seuls les salons textuels, d\'annonces et les forums ont un sujet.');
  const text = interaction.options.getString('texte')?.trim() || null;
  if (text && [...text].length > MAX_TOPIC) throw new UserError(`Sujet trop long (${MAX_TOPIC} caractères au maximum).`);
  if ((channel.topic ?? null) === text) throw new UserError(text ? 'Ce salon a déjà ce sujet.' : 'Ce salon n\'a déjà pas de sujet.');
  await channel.setTopic(text, reasonOf(interaction, 'Sujet modifié'));
  await interaction.reply({
    embeds: [actionCard({
      icon: ICONS.reason,
      title: text ? 'Sujet modifié' : 'Sujet retiré',
      description: text ? `Le sujet de ${channel} a été mis à jour.` : `${channel} n'a plus de sujet.`,
      channel,
      moderator: interaction.user,
      fields: [text ? wide(ICONS.reason, 'Sujet', truncate(text, 1024)) : null],
    })],
    ephemeral: true,
  });
}

async function nsfw(interaction) {
  const channel = pickChannel(interaction);
  assertManageable(interaction, channel);
  if (!NSFW_TYPES.includes(channel.type) || typeof channel.setNSFW !== 'function') throw new UserError('Ce type de salon ne peut pas être marqué NSFW.');
  const on = interaction.options.getBoolean('actif', true);
  if (Boolean(channel.nsfw) === on) throw new UserError(`${channel} est déjà ${on ? 'réservé aux adultes (NSFW)' : 'tout public'}.`);
  await channel.setNSFW(on, reasonOf(interaction, on ? 'NSFW activé' : 'NSFW désactivé'));
  await interaction.reply({
    embeds: [actionCard({
      tone: on ? 'caution' : 'success',
      icon: '🔞',
      title: on ? 'Salon NSFW' : 'Salon tout public',
      description: on ? `${channel} est désormais réservé aux adultes : Discord demande une confirmation d'âge.` : `${channel} n'est plus marqué NSFW.`,
      channel,
      moderator: interaction.user,
    })],
    ephemeral: true,
  });
}

const HANDLERS = { info, creer: create, supprimer: remove, cloner: clone, renommer: rename, sujet: topic, nsfw };

module.exports = {
  category: 'information',
  cleanChannelName,
  CREATE_TYPES,
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
        .addChannelOption((o) => o.setName('salon').setDescription('Le salon concerné (par défaut : le salon actuel)').addChannelTypes(...NSFW_TYPES))),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const handler = HANDLERS[interaction.options.getSubcommand()];
    if (!handler) throw new UserError('Sous-commande inconnue.');
    return handler(interaction);
  },
};
