'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, Collection,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} = require('discord.js');
const { status, TONES, ICONS, linkButton, buttonRows, field, wide } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { parseColor } = require('../../utils/projectFormat');
const { LIMITS } = require('../../utils/embeds');
const { SlidingWindow } = require('../../utils/rate');
const { canRead } = require('../../utils/channelAccess');
const { phishingScore } = require('../../utils/automod/phishing');
const { fetchDiscordFile } = require('../../utils/discordCdn');
const { logCard, truncateContent, PRIVATE_CONTENT } = require('../../services/LoggingService');

/** Longueur maximale d'une URL d'image ou de miniature dans un embed. */
const MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------- /embed texte (+say)

/** Salons où /embed texte peut parler : texte, annonces, fils, chat d'un salon vocal. */
const SAY_CHANNEL_TYPES = Object.freeze([
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread,
  ChannelType.PrivateThread, ChannelType.AnnouncementThread, ChannelType.GuildVoice,
]);
const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
const MAX_SAY_LENGTH = 2000;
const SAY_COOLDOWN_MS = 5_000;
const SAY_GUILD_LIMIT = 10;
const SAY_GUILD_WINDOW_MS = 60_000;
const MAX_USER_MENTIONS = 10;
const MAX_ROLE_MENTIONS = 10;
/** Taille de fichier par défaut si Discord n'indique pas la limite du serveur (10 Mio). */
const DEFAULT_ATTACHMENT_LIMIT = 10 * 1024 * 1024;
/** Filtres de STYLE de l'AutoMod non appliqués à un texte publié par le bot (majuscules, emojis, pavé). */
const STYLE_FILTERS = new Set(['antiCaps', 'antiEmojiSpam', 'antiWall']);
/** Fenêtres d'envoi par serveur (10 par minute), bornées. */
const sayWindows = new Map();
const GRANT = Symbol.for('gadget.grant');

/**
 * Lien de message Discord → { guildId, channelId, messageId }, ou null. Pur.
 */
function parseMessageLink(raw) {
  const m = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?>?$/i.exec(String(raw ?? '').trim());
  return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
}

/**
 * Mentions autorisées d'un message de /embed texte (jamais déduites du contenu seul). Pur.
 *  - users : les 10 premiers <@id> distincts ;
 *  - roles : seulement si `mentionRoles`, et rôle mentionnable (ou « Mentionner @everyone » de
 *    l'auteur dans le salon cible) ; jamais un rôle géré ; 10 au plus ;
 *  - parse ['everyone'] : seulement si `notifyAll` ET permission NATIVE de l'auteur dans la cible ;
 *  - repliedUser : false.
 * @param {{ content?: string, mentionRoles?: boolean, notifyAll?: boolean,
 *   authorPerms?: import('discord.js').PermissionsBitField|null, guild?: import('discord.js').Guild|null }} opts
 */
function computeAllowedMentions({ content = '', mentionRoles = false, notifyAll = false, authorPerms = null, guild = null } = {}) {
  const text = String(content ?? '');
  const canEveryone = Boolean(authorPerms?.has?.(PermissionFlagsBits.MentionEveryone));
  const users = [];
  for (const m of text.matchAll(/<@!?(\d{17,20})>/g)) {
    if (!users.includes(m[1])) users.push(m[1]);
    if (users.length >= MAX_USER_MENTIONS) break;
  }
  const roles = [];
  if (mentionRoles) {
    for (const m of text.matchAll(/<@&(\d{17,20})>/g)) {
      const id = m[1];
      if (roles.includes(id) || id === guild?.id) continue;
      const role = guild?.roles?.cache?.get(id);
      if (!role || role.managed) continue;
      if (role.mentionable || canEveryone) roles.push(id);
      if (roles.length >= MAX_ROLE_MENTIONS) break;
    }
  }
  return { parse: notifyAll && canEveryone ? ['everyone'] : [], users, roles, repliedUser: false };
}

/** Nom de fichier sûr pour un envoi (lettres, chiffres, . _ -), 100 caractères au plus. Pur. */
function safeFileName(name) {
  const clean = String(name ?? '').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._]+/, '').slice(-100);
  return clean && /[^._]/.test(clean) ? clean : 'fichier';
}

/** Fenêtre d'envoi du serveur (10 messages par minute) : lève une UserError si pleine. */
function hitGuildRate(guildId, now = Date.now()) {
  let win = sayWindows.get(guildId);
  if (!win) {
    if (sayWindows.size >= 1_000) for (const [id, w] of sayWindows) if (!w.count(now)) sayWindows.delete(id);
    win = new SlidingWindow(SAY_GUILD_WINDOW_MS);
    sayWindows.set(guildId, win);
  }
  if (win.count(now) >= SAY_GUILD_LIMIT) throw new UserError(`Ce serveur a déjà publié **${SAY_GUILD_LIMIT}** messages via le bot dans la dernière minute : réessayez dans un instant.`);
  win.hit(now);
}

/** Salon cible résolu (cache, sinon Discord), dans CE serveur. */
async function resolveSayChannel(guild, channelId) {
  if (!channelId) return null;
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  return guild.channels.fetch(channelId).catch(() => null);
}

/**
 * Le texte serait-il bloqué par l'AutoMod pour l'auteur ? Filtres de contenu (mots interdits,
 * invitations, arnaques, liens, mentions massives, zalgo) avec leurs exemptions propres ; la
 * dispense générale « Gérer les messages » ne s'applique PAS : le message est signé par le bot,
 * que l'AutoMod ignore. Salons ignorés par l'AutoMod : rien n'est bloqué. Lève une UserError.
 */
function assertAutomodAllows(client, interaction, channel, text) {
  if (!text) return;
  const cfg = client.services.config.get(interaction.guildId).automod;
  if (!cfg?.enabled || !client.services.automod?.inspect) return;
  const ignored = cfg.ignoredChannels ?? [];
  if (ignored.includes(channel.id) || (channel.parentId && ignored.includes(channel.parentId))) return;
  const filters = Object.fromEntries(Object.entries(cfg.filters ?? {}).filter(([k]) => !STYLE_FILTERS.has(k)));
  const message = {
    guild: interaction.guild,
    author: interaction.user,
    member: interaction.member,
    channel,
    content: text,
    mentions: null,
    attachments: new Collection(),
    stickers: new Collection(),
  };
  const hit = client.services.automod.inspect(message, filters, { temporal: false });
  if (hit) throw new UserError(`Message refusé : l'AutoMod le bloquerait (${hit.reason}${hit.detail ? ` — ${String(hit.detail).slice(0, 80)}` : ''}).`);
}

/** /embed texte : le bot publie un message texte (voir la spécification en tête de fichier). */
async function sayText(interaction, client) {
  const { guild } = interaction;
  const raw = interaction.options.getString('message') ?? '';
  const text = raw.trim() ? raw : '';
  const attachment = interaction.options.getAttachment('fichier');
  const link = interaction.options.getString('repondre_a');
  const mentionRoles = interaction.options.getBoolean('mentionner_roles') ?? false;
  const notifyAll = interaction.options.getBoolean('notifier_tous') ?? false;
  const picked = interaction.options.getChannel('salon');

  if (!text && !attachment) throw new UserError('Écrivez un message (ou joignez un fichier) : un message vide ne peut pas être publié.');
  if (raw.length > MAX_SAY_LENGTH) throw new UserError(`Le message fait au plus ${MAX_SAY_LENGTH} caractères.`);
  let reply = null;
  if (link) {
    reply = parseMessageLink(link);
    if (!reply) throw new UserError('`repondre_a` : collez le lien d\'un message (clic droit → Copier le lien du message).');
    if (reply.guildId !== interaction.guildId) throw new UserError('`repondre_a` : le message doit être sur CE serveur.');
    if (picked && picked.id !== reply.channelId) throw new UserError('Le lien de `repondre_a` désigne un autre salon que `salon` : retirez l\'une des deux options.');
  }
  if (notifyAll && !/@(everyone|here)/.test(text)) throw new UserError('`notifier_tous` : écrivez **@everyone** ou **@here** dans le message.');
  if (text && phishingScore(text).score >= 3) throw new UserError('Message refusé : il contient un lien d\'arnaque probable.');

  const remaining = client.cooldowns.hit(`embed-texte:${interaction.user.id}`, SAY_COOLDOWN_MS);
  if (remaining) throw new UserError(`Doucement : vous pourrez republier dans ${Math.ceil(remaining / 1000)} s.`);
  hitGuildRate(guild.id);

  await interaction.deferReply({ ephemeral: true });

  const channel = await resolveSayChannel(guild, reply?.channelId ?? picked?.id ?? interaction.channelId);
  if (!channel || channel.guildId !== guild.id || !SAY_CHANNEL_TYPES.includes(channel.type) || typeof channel.send !== 'function') {
    throw new UserError('Salon cible introuvable ou incompatible : salon textuel, d\'annonces, fil ou chat d\'un salon vocal.');
  }
  const thread = THREAD_TYPES.has(channel.type);
  if (thread && (channel.archived || channel.locked)) throw new UserError(`Le fil ${channel} est archivé ou verrouillé.`);

  // Auteur : permissions NATIVES dans la cible (jamais déléguées).
  const send = thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  const authorExtra = [send, ...(attachment ? [PermissionFlagsBits.AttachFiles] : [])];
  const member = interaction.member?.permissions ? interaction.member : await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !(await canRead(channel, member, authorExtra))) {
    throw new UserError(`Vous devez pouvoir **voir** ${channel} et **y écrire**${attachment ? ' (avec **Joindre des fichiers**)' : ''} vous-même.`);
  }
  const authorPerms = channel.permissionsFor(member);
  if (notifyAll && !authorPerms?.has(PermissionFlagsBits.MentionEveryone)) {
    throw new UserError(`\`notifier_tous\` demande la permission **Mentionner @everyone, @here et tous les rôles** dans ${channel}.`);
  }
  // Bot : mêmes droits, plus fichiers / historique / mention de masse selon les options.
  const me = guild.members.me;
  const botExtra = [send, ...(attachment ? [PermissionFlagsBits.AttachFiles] : []), ...(notifyAll ? [PermissionFlagsBits.MentionEveryone] : [])];
  if (!me || !(await canRead(channel, me, botExtra))) {
    throw new UserError(`Il me manque des permissions dans ${channel} : **Voir le salon**, **Lire l'historique**, **Envoyer des messages**${attachment ? ', **Joindre des fichiers**' : ''}${notifyAll ? ', **Mentionner @everyone**' : ''}.`);
  }

  assertAutomodAllows(client, interaction, channel, text);

  const secur = client.services.secur;
  if (notifyAll && secur?.assertAllowed) await secur.assertAllowed(interaction, 'everyone');

  let files;
  if (attachment) {
    const limit = Number(interaction.attachmentSizeLimit) || DEFAULT_ATTACHMENT_LIMIT;
    if (Number(attachment.size) > limit) throw new UserError(`Fichier trop lourd (${(attachment.size / 1024 / 1024).toFixed(1)} Mo) : ${(limit / 1024 / 1024).toFixed(0)} Mo au plus ici.`);
    let buffer;
    try {
      ({ buffer } = await fetchDiscordFile(attachment.url, { maxBytes: limit }));
    } catch (err) {
      if (err?.name === 'FetchError') throw new UserError(`Fichier refusé : ${err.message}.`);
      throw err;
    }
    files = [{ attachment: buffer, name: safeFileName(attachment.name) }];
  }

  const allowedMentions = computeAllowedMentions({ content: text, mentionRoles, notifyAll, authorPerms, guild });
  const payload = { allowedMentions };
  if (text) payload.content = text;
  if (files) payload.files = files;
  if (reply) payload.reply = { messageReference: reply.messageId, failIfNotExists: false };
  const sent = await channel.send(payload);

  await interaction.editReply({
    embeds: [status.ok(`Message publié dans ${channel}.`, 'Message envoyé')],
    components: sent?.url ? buttonRows(linkButton('Voir le message', sent.url, ICONS.link)) : [],
  });

  // Rapport à la sécurité (mention de masse faite PAR le bot pour l'auteur), puis log.
  if (notifyAll && secur) await client.services.moderation?.reportDestructiveAction?.(guild, interaction.user, 'everyone', { count: 1 });
  const grant = interaction[GRANT];
  const hidden = client.services.logging.hidesContent?.(guild.id, 'moderation', channel);
  const pinged = [
    allowedMentions.parse.includes('everyone') ? '@everyone / @here' : null,
    allowedMentions.roles.length ? `${allowedMentions.roles.length} rôle(s)` : null,
    allowedMentions.users.length ? `${allowedMentions.users.length} membre(s)` : null,
  ].filter(Boolean);
  await client.services.logging.send(
    guild.id,
    'moderation',
    logCard({
      category: 'moderation',
      icon: '🗣️',
      title: 'Message publié au nom du bot',
      user: interaction.user,
      description: `${interaction.user} a fait parler le bot dans ${channel}${grant?.level ? ` · par délégation (niveau ${grant.level})` : ''}.`,
      fields: [
        field(ICONS.channel, 'Salon', `${channel}`),
        field('🔔', 'Notifications', pinged.join(' · ') || 'Aucune'),
        field(ICONS.link, 'Réponse', reply ? 'Oui' : 'Non'),
        wide(ICONS.reason, 'Contenu', hidden ? PRIVATE_CONTENT : text ? truncateContent(text, 1024) : `*Fichier seul : ${safeFileName(attachment?.name)}*`),
      ],
    }),
    sent?.url ? buttonRows(linkButton('Aller au message', sent.url, ICONS.link)) : [],
    { event: 'say', channelId: channel.id },
  );
}

/**
 * Constructeur d'embeds : via modal interactif (/embed create) ou en une
 * commande (/embed send).
 *
 * /embed texte (équivalent de « +say ») : le bot publie un message TEXTE.
 *  - auteur : « Voir le salon » + « Envoyer des messages » NATIFS dans la cible (jamais
 *    délégués), plus « Joindre des fichiers » pour un fichier ; le bot aussi (+ historique) ;
 *  - repondre_a : lien d'un message de CE serveur (il désigne le salon) ;
 *  - refus : message vide, lien d'arnaque probable (score ≥ 3), ce que l'AutoMod bloquerait ;
 *  - mentions : allowedMentions explicite (computeAllowedMentions), @everyone seulement avec
 *    notifier_tous ET la permission native, pré-contrôle de la sécurité (secur) avant l'envoi ;
 *  - fichier : téléchargé depuis le CDN de Discord (utils/discordCdn.js), taille bornée ;
 *  - 5 s entre deux envois par membre, 10 envois par minute et par serveur ;
 *  - réponse éphémère avec lien, PUIS log moderation.say.
 */
module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Crée et envoie des embeds personnalisés.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Ouvre un formulaire pour construire un embed.'))
    .addSubcommand((s) =>
      s.setName('send').setDescription('Envoie un embed avec des options directes.')
        .addStringOption((o) => o.setName('titre').setDescription('Titre de l\'embed (256 caractères max.)').setMaxLength(256))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(4096))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)').setMaxLength(7))
        .addStringOption((o) => o.setName('image').setDescription('URL de l\'image').setMaxLength(MAX_URL_LENGTH))
        .addStringOption((o) => o.setName('thumbnail').setDescription('URL de la miniature').setMaxLength(MAX_URL_LENGTH))
        .addStringOption((o) => o.setName('footer').setDescription('Texte de pied de page').setMaxLength(2048))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon cible').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) =>
      s.setName('texte').setDescription('Fait parler le bot : publie un message texte dans un salon.')
        .addStringOption((o) => o.setName('message').setDescription('Texte publié par le bot (2 000 caractères au plus)').setMaxLength(MAX_SAY_LENGTH))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon où publier (par défaut : ce salon)').addChannelTypes(...SAY_CHANNEL_TYPES))
        .addStringOption((o) => o.setName('repondre_a').setDescription('Lien d\'un message de ce serveur auquel répondre (désigne le salon)').setMaxLength(200))
        .addAttachmentOption((o) => o.setName('fichier').setDescription('Fichier joint au message'))
        .addBooleanOption((o) => o.setName('mentionner_roles').setDescription('Notifier les rôles mentionnés (mentionnables, ou avec votre permission)'))
        .addBooleanOption((o) => o.setName('notifier_tous').setDescription('Notifier @everyone / @here écrits dans le message (permission requise)'))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'texte') return sayText(interaction, client);

    if (sub === 'create') {
      const modal = new ModalBuilder().setCustomId(`embedbuilder:${interaction.channelId}`).setTitle('Constructeur d\'embed');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Titre').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Couleur hex (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('#5865F2')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('URL image (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(MAX_URL_LENGTH)),
      );
      return interaction.showModal(modal);
    }

    if (sub === 'send') {
      const embed = new EmbedBuilder();
      const title = interaction.options.getString('titre');
      const description = interaction.options.getString('description');
      const color = interaction.options.getString('couleur');
      const image = interaction.options.getString('image');
      const thumbnail = interaction.options.getString('thumbnail');
      const footer = interaction.options.getString('footer');
      if (!title && !description) throw new UserError('Fournissez au moins un titre ou une description.');
      validateEmbedInput({ title, description, footer, image, thumbnail });
      if (title) embed.setTitle(title);
      if (description) embed.setDescription(description);
      embed.setColor(parseColor(color) ?? TONES.brand);
      if (image) embed.setImage(image);
      if (thumbnail) embed.setThumbnail(thumbnail);
      if (footer?.trim()) embed.setFooter({ text: footer });

      const channel = interaction.options.getChannel('salon') || interaction.channel;
      // L'auteur doit lui-même pouvoir écrire dans le salon cible (pas d'envoi « par procuration »).
      const perms = channel.permissionsFor?.(interaction.member);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new UserError(`Vous n'avez pas la permission d'envoyer des embeds dans ${channel}.`);
      }
      // Acquittement AVANT la publication (limite de débit du salon : pas d'expiration ni de doublon).
      await interaction.deferReply({ ephemeral: true });
      const sent = await channel.send({ embeds: [embed] });
      return interaction.editReply({
        embeds: [status.ok(`Votre embed a été publié dans ${channel}.`, 'Embed envoyé')],
        components: sent?.url ? buttonRows(linkButton('Voir le message', sent.url, ICONS.link)) : [],
      });
    }
  },
};

/**
 * Vérifie un embed libre AVANT l'envoi (channel.send n'est pas tronqué par la couche
 * d'interaction) : longueurs Discord, total de 6000 caractères, URL http(s) ≤ 2048.
 * Lève une UserError précise. Pur.
 */
function validateEmbedInput({ title, description, footer, image, thumbnail } = {}) {
  if (title && title.length > LIMITS.title) throw new UserError(`Le titre est trop long (${title.length}/${LIMITS.title} caractères).`);
  if (description && description.length > LIMITS.description) throw new UserError(`La description est trop longue (${description.length}/${LIMITS.description} caractères).`);
  if (footer && footer.length > LIMITS.footer) throw new UserError(`Le pied de page est trop long (${footer.length}/${LIMITS.footer} caractères).`);
  const total = (title?.length || 0) + (description?.length || 0) + (footer?.length || 0);
  if (total > LIMITS.total) {
    throw new UserError(`L'embed dépasse la limite Discord de ${LIMITS.total} caractères au total (titre + description + pied de page) : **${total}**/${LIMITS.total}. Retirez au moins **${total - LIMITS.total}** caractères.`);
  }
  for (const [value, label] of [[image, 'de l\'image'], [thumbnail, 'de la miniature']]) {
    if (!value) continue;
    if (value.length > MAX_URL_LENGTH) throw new UserError(`L'URL ${label} est trop longue (${value.length}/${MAX_URL_LENGTH} caractères).`);
    if (!isHttpUrl(value)) throw new UserError(`L'URL ${label} doit commencer par \`http://\` ou \`https://\`.`);
  }
}

/** URL http(s) valide (les validateurs d'embed lèvent sinon). */
function isHttpUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports.parseColor = parseColor;
module.exports.computeAllowedMentions = computeAllowedMentions;
module.exports.parseMessageLink = parseMessageLink;
module.exports.safeFileName = safeFileName;
module.exports.SAY_CHANNEL_TYPES = SAY_CHANNEL_TYPES;
module.exports.sayWindows = sayWindows;
module.exports.isHttpUrl = isHttpUrl;
module.exports.validateEmbedInput = validateEmbedInput;
module.exports.MAX_URL_LENGTH = MAX_URL_LENGTH;
