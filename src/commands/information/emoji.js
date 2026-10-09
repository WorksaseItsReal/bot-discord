'use strict';

const { SlashCommandBuilder, SnowflakeUtil, PermissionFlagsBits } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, linkButton, buttonRows, status } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { truncate } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');
const { requirePermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/**
 * /emoji : affichage d'un emoji (info, aussi en MP) et gestion des emojis du serveur
 * (ajouter, supprimer, renommer — « Gérer les expressions », revérifiée à chaque fois).
 *
 * Réseau : l'ajout télécharge l'image depuis cdn.discordapp.com UNIQUEMENT (pièce jointe
 * de la commande ou URL d'un emoji Discord) — `fetch` natif, 10 s au plus, 256 Ko au
 * plus, sans redirection ; le format est vérifié sur le contenu (PNG, JPEG, GIF, WebP).
 */

/** Bloc de code copiable (les accents graves sont neutralisés). */
function copyBlock(text) {
  return `\`\`\`\n${String(text).replace(/`/g, 'ˋ')}\n\`\`\``;
}

/** Nombre maximal d'emojis standard analysés en une fois. */
const MAX_EMOJIS = 10;
const KEYCAP = /^[0-9#*]️?⃣$/u;
const segmenter = new Intl.Segmenter('fr', { granularity: 'grapheme' });

/** Taille maximale d'un emoji (limite Discord). */
const MAX_EMOJI_BYTES = 256 * 1024;
/** Délai maximal du téléchargement de l'image. */
const DOWNLOAD_TIMEOUT_MS = 10_000;
/** Seul hôte autorisé pour télécharger une image d'emoji. */
const EMOJI_HOST = 'cdn.discordapp.com';
/** Nom d'emoji Discord : 2 à 32 lettres, chiffres ou « _ ». */
const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;
const CUSTOM_EMOJI = /<(a?):(\w{2,32}):(\d{17,20})>/;

/**
 * Un graphème est-il un vrai emoji Unicode ? Pictogramme (`\p{Extended_Pictographic}`,
 * avec ses variantes : teinte, ZWJ…), drapeau (indicateurs régionaux) ou keycap (1️⃣ #️⃣ *️⃣). Pur.
 */
function isStandardEmoji(grapheme) {
  return KEYCAP.test(grapheme) || /\p{Extended_Pictographic}/u.test(grapheme) || /^\p{Regional_Indicator}{2}$/u.test(grapheme);
}

/** Emojis standard d'une saisie (hors espaces), ou null si un élément n'en est pas un. Pur. */
function parseStandardEmojis(input) {
  const graphemes = [...segmenter.segment(String(input ?? ''))].map((s) => s.segment).filter((g) => !/^\s+$/u.test(g));
  if (!graphemes.length || graphemes.length > MAX_EMOJIS || !graphemes.every(isStandardEmoji)) return null;
  return graphemes;
}

// ---------------------------------------------------------------- ajout : source de l'image

/**
 * URL d'image d'emoji acceptée : https://cdn.discordapp.com/emojis/<id>.<png|gif|webp|jpg>,
 * ou un emoji personnalisé `<:nom:id>` (converti). Toute autre saisie est refusée. Pur.
 * @returns {string} URL normalisée
 */
function emojiSourceUrl(input) {
  const text = String(input ?? '').trim();
  const markup = CUSTOM_EMOJI.exec(text);
  if (markup) return `https://${EMOJI_HOST}/emojis/${markup[3]}.${markup[1] ? 'gif' : 'png'}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UserError(`Lien invalide : donnez l'URL d'un emoji Discord (\`https://${EMOJI_HOST}/emojis/…\`) ou joignez une image.`);
  }
  if (url.protocol !== 'https:' || url.hostname !== EMOJI_HOST || url.port || url.username || url.password) {
    throw new UserError(`Seuls les liens d'emojis Discord (\`https://${EMOJI_HOST}/emojis/…\`) sont acceptés.`);
  }
  if (!/^\/emojis\/\d{17,20}\.(png|gif|webp|jpe?g)$/i.test(url.pathname)) {
    throw new UserError(`Ce lien n'est pas celui d'un emoji Discord (\`https://${EMOJI_HOST}/emojis/<identifiant>.png\`).`);
  }
  return `https://${EMOJI_HOST}${url.pathname}`;
}

/** Pièce jointe d'une commande : image hébergée par Discord, 256 Ko au plus. Pur. */
function attachmentSourceUrl(attachment) {
  if (attachment.size > MAX_EMOJI_BYTES) throw new UserError(`Image trop lourde : **${Math.ceil(attachment.size / 1024)} Ko** (256 Ko au maximum).`);
  if (attachment.contentType && !/^image\/(png|jpe?g|gif|webp)\b/i.test(attachment.contentType)) {
    throw new UserError('La pièce jointe doit être une image PNG, JPEG, GIF ou WebP.');
  }
  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new UserError('Pièce jointe illisible.');
  }
  if (url.protocol !== 'https:' || url.hostname !== EMOJI_HOST) throw new UserError('Pièce jointe hébergée hors de Discord : refusée.');
  return url.href;
}

/** Format d'une image d'après ses premiers octets (jamais d'après l'en-tête HTTP). Pur. */
function imageType(buffer) {
  const b = buffer;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', animated: false };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', animated: false };
  if (b.length >= 6 && b.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', animated: true };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    // WebP animé : bloc « ANIM » présent dans l'en-tête étendu.
    return { mime: 'image/webp', animated: b.includes(Buffer.from('ANIM')) };
  }
  return null;
}

/**
 * Télécharge une image d'emoji (cdn.discordapp.com seulement, 10 s, 256 Ko, sans redirection).
 * @returns {Promise<{ buffer: Buffer, mime: string, animated: boolean }>}
 */
async function downloadEmojiImage(href, { fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_EMOJI_BYTES } = {}) {
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.hostname !== EMOJI_HOST) throw new UserError('Hôte refusé.');
  let res;
  try {
    res = await fetchImpl(url.href, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new UserError(timeout ? 'Téléchargement de l\'image trop long (10 s) : réessayez.' : 'Impossible de télécharger l\'image.');
  }
  if (!res?.ok) throw new UserError(res?.status === 404 ? 'Image introuvable : vérifiez le lien.' : `Téléchargement refusé (HTTP ${res?.status ?? '?'}).`);
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new UserError('Image trop lourde (256 Ko au maximum).');
  const chunks = [];
  let size = 0;
  const reader = res.body?.getReader?.();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UserError('Image trop lourde (256 Ko au maximum).');
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const all = Buffer.from(await res.arrayBuffer());
    if (all.length > maxBytes) throw new UserError('Image trop lourde (256 Ko au maximum).');
    chunks.push(all);
  }
  const buffer = Buffer.concat(chunks);
  const type = imageType(buffer);
  if (!type) throw new UserError('Ce fichier n\'est pas une image PNG, JPEG, GIF ou WebP.');
  return { buffer, ...type };
}

// ---------------------------------------------------------------- gestion

/** Emojis autorisés par type (fixes / animés) selon le niveau de boost. Pur. */
function emojiLimit(guild) {
  const tier = Number(guild?.premiumTier ?? 0);
  const base = [50, 100, 150, 250][Math.min(3, Math.max(0, tier))] ?? 50;
  return guild?.features?.includes?.('MORE_EMOJI') ? Math.max(base, 200) : base;
}

/** Nom d'emoji valide (2 à 32 lettres, chiffres ou « _ »). Pur. */
function assertEmojiName(name) {
  const n = String(name ?? '').trim().replace(/^:|:$/g, '');
  if (!EMOJI_NAME.test(n)) throw new UserError('Nom invalide : 2 à 32 caractères, lettres sans accent, chiffres ou « _ » (ex : `gadget_ok`).');
  return n;
}

/** Contexte de gestion : serveur, « Gérer les expressions » (membre et bot). */
function assertManage(interaction) {
  if (!interaction.inGuild?.() || !interaction.guild) throw new UserError('La gestion des emojis n\'est disponible que sur un serveur.');
  requirePermission(interaction, 'ManageGuildExpressions');
  if (!interaction.guild.members.me?.permissions?.has(PermissionFlagsBits.ManageGuildExpressions)) {
    throw new UserError('Il me manque la permission **Gérer les expressions**.');
  }
}

/** Emoji du serveur désigné par `<:nom:id>`, son identifiant ou son nom. */
function findGuildEmoji(guild, input) {
  const text = String(input ?? '').trim();
  const id = CUSTOM_EMOJI.exec(text)?.[3] ?? (/^\d{17,20}$/.test(text) ? text : null);
  const cache = guild.emojis.cache;
  const name = text.replace(/^:|:$/g, '');
  const emoji = id ? cache.get(id) : cache.find((e) => e.name === name) ?? cache.find((e) => e.name?.toLowerCase() === name.toLowerCase());
  if (!emoji) throw new UserError('Emoji introuvable sur ce serveur : utilisez l\'emoji lui-même, son nom ou son identifiant.');
  if (emoji.managed) throw new UserError('Cet emoji est géré par une intégration (Twitch, abonnement…) : il ne peut pas être modifié.');
  return emoji;
}

/** Carte d'un emoji du serveur après une action (ajout, renommage). */
function emojiCard(emoji, { title, description, tone = 'success', extra = [] }) {
  const url = emoji.imageURL?.({ size: 128 }) ?? `https://${EMOJI_HOST}/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`;
  return card({
    tone,
    section: 'information',
    icon: ICONS.emoji,
    title,
    description,
    thumbnail: url,
    fields: [
      field(ICONS.tag, 'Nom', code(`:${emoji.name}:`)),
      field(ICONS.id, 'Identifiant', code(emoji.id)),
      field(ICONS.image, 'Format', emoji.animated ? 'GIF animé' : 'Image fixe'),
      ...extra,
      wide(ICONS.tag, 'Code', copyBlock(`<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`)),
    ],
  });
}

async function addEmoji(interaction) {
  assertManage(interaction);
  const guild = interaction.guild;
  const name = assertEmojiName(interaction.options.getString('nom'));
  const attachment = interaction.options.getAttachment('image');
  const link = interaction.options.getString('url');
  if (!attachment && !link) throw new UserError('Joignez une image (option `image`) ou donnez le lien d\'un emoji Discord (option `url`).');
  if (attachment && link) throw new UserError('Choisissez **une** source : l\'image jointe ou le lien, pas les deux.');
  const href = attachment ? attachmentSourceUrl(attachment) : emojiSourceUrl(link);
  if (guild.emojis.cache.some((e) => e.name === name)) throw new UserError(`Un emoji \`:${name}:\` existe déjà sur ce serveur.`);
  // Téléchargement + création : au-delà de 3 s possible.
  await interaction.deferReply({ ephemeral: true });
  const image = await downloadEmojiImage(href);
  const limit = emojiLimit(guild);
  const used = guild.emojis.cache.filter((e) => Boolean(e.animated) === image.animated).size;
  if (used >= limit) {
    throw new UserError(`Limite atteinte : **${used}/${limit}** emojis ${image.animated ? 'animés' : 'fixes'} sur ce serveur (davantage avec les boosts).`);
  }
  const emoji = await guild.emojis.create({
    attachment: `data:${image.mime};base64,${image.buffer.toString('base64')}`,
    name,
    reason: truncate(`Ajouté par ${interaction.user.tag}`, 400),
  });
  await interaction.editReply({
    embeds: [emojiCard(emoji, {
      title: 'Emoji ajouté',
      description: [`${emoji} est disponible sur le serveur.`, subtext(`${used + 1}/${limit} emojis ${image.animated ? 'animés' : 'fixes'} · ${Math.ceil(image.buffer.length / 1024)} Ko`)],
    })],
  });
}

async function deleteEmoji(interaction, client) {
  assertManage(interaction);
  const emoji = findGuildEmoji(interaction.guild, interaction.options.getString('emoji'));
  const { name, id } = emoji;
  if (client.services.config.get(interaction.guild.id)?.moderation?.confirmDangerous) {
    const ok = await confirm(interaction, { description: `Supprimer définitivement l'emoji ${emoji} \`:${name}:\` ?`, confirmLabel: 'Supprimer' });
    if (!ok) return undefined;
  } else {
    await interaction.deferReply({ ephemeral: true });
  }
  await emoji.delete(truncate(`Supprimé par ${interaction.user.tag}`, 400));
  return interaction.editReply({
    embeds: [card({
      tone: 'danger',
      section: 'information',
      icon: ICONS.delete,
      title: 'Emoji supprimé',
      description: `L'emoji \`:${name}:\` a été supprimé du serveur.`,
      fields: [field(ICONS.id, 'Identifiant', code(id)), field(ICONS.moderator, 'Par', `${interaction.user}`)],
    })],
    components: [],
  });
}

async function renameEmoji(interaction) {
  assertManage(interaction);
  const emoji = findGuildEmoji(interaction.guild, interaction.options.getString('emoji'));
  const name = assertEmojiName(interaction.options.getString('nom'));
  if (name === emoji.name) throw new UserError(`Cet emoji s'appelle déjà \`:${name}:\`.`);
  if (interaction.guild.emojis.cache.some((e) => e.name === name && e.id !== emoji.id)) throw new UserError(`Un emoji \`:${name}:\` existe déjà sur ce serveur.`);
  const before = emoji.name;
  const updated = await emoji.edit({ name, reason: truncate(`Renommé par ${interaction.user.tag}`, 400) });
  await interaction.reply({
    embeds: [emojiCard(updated ?? emoji, { title: 'Emoji renommé', description: `\`:${before}:\` s'appelle désormais \`:${name}:\`.` })],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------- affichage (inchangé)

async function showEmoji(interaction, client) {
  const input = interaction.options.getString('emoji').trim();
  const custom = input.match(CUSTOM_EMOJI);
  if (custom) {
    const [raw, animated, name, id] = custom;
    const ext = animated ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=512`;
    const known = client.emojis?.cache?.get(id);
    const created = Number(SnowflakeUtil.timestampFrom(id));
    return interaction.reply({
      embeds: [
        card({
          tone: 'brand',
          section: 'information',
          icon: ICONS.emoji,
          title: `:${name}:`,
          url,
          description: [
            `Emoji personnalisé${animated ? ' **animé**' : ''}.`,
            subtext(known?.guild ? `Provient du serveur ${known.guild.name}.` : 'Serveur d\'origine inconnu du bot.'),
          ],
          image: url,
          fields: [
            field(ICONS.id, 'Identifiant', code(id)),
            field(ICONS.image, 'Format', animated ? 'GIF animé' : 'PNG'),
            field(ICONS.date, 'Créé', `${discordTimestamp(created, 'D')}\n${discordTimestamp(created, 'R')}`),
            wide(ICONS.tag, 'Code', copyBlock(raw)),
          ],
        }),
      ],
      components: buttonRows(
        linkButton('Ouvrir', url, ICONS.link),
        linkButton('WEBP', `https://cdn.discordapp.com/emojis/${id}.webp?size=512${animated ? '&animated=true' : ''}`),
      ),
    });
  }

  const emojis = parseStandardEmojis(input);
  if (!emojis) {
    throw new UserError(`Envoyez un emoji personnalisé (ex : \`:pepe:\`) ou jusqu'à ${MAX_EMOJIS} emojis standard (ex : 😀 🇫🇷 1️⃣).`);
  }
  const chars = [...emojis.join('')];
  const codes = chars.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
  return interaction.reply({
    embeds: [
      card({
        tone: 'brand',
        section: 'information',
        icon: ICONS.emoji,
        title: 'Emoji standard',
        description: [`# ${emojis.join('')}`, subtext('Emoji Unicode : disponible partout, sans Nitro.')],
        fields: [
          field(ICONS.id, 'Unicode', code(codes)),
          field(ICONS.count, 'Points de code', `**${chars.length}**`),
          wide(ICONS.tag, 'Copier', copyBlock(emojis.join(''))),
        ],
      }),
    ],
  });
}

module.exports = {
  guildOnly: false,
  isStandardEmoji,
  parseStandardEmojis,
  emojiSourceUrl,
  attachmentSourceUrl,
  imageType,
  downloadEmojiImage,
  emojiLimit,
  assertEmojiName,
  MAX_EMOJI_BYTES,
  data: new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Affiche un emoji en grand, ou gère les emojis du serveur.')
    .addSubcommand((s) =>
      s.setName('info').setDescription('Affiche un emoji en grand avec ses informations.')
        .addStringOption((o) => o.setName('emoji').setDescription('L\'emoji (ex : :pepe:)').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) =>
      s.setName('ajouter').setDescription('Ajoute un emoji au serveur (image jointe ou lien d\'un emoji Discord).')
        .addStringOption((o) => o.setName('nom').setDescription('Nom de l\'emoji (2 à 32 lettres, chiffres ou _)').setRequired(true).setMinLength(2).setMaxLength(32))
        .addAttachmentOption((o) => o.setName('image').setDescription('Image PNG, JPEG, GIF ou WebP de 256 Ko au plus'))
        .addStringOption((o) => o.setName('url').setDescription('Ou : lien d\'un emoji Discord (cdn.discordapp.com/emojis/…) ou l\'emoji lui-même').setMaxLength(200)))
    .addSubcommand((s) =>
      s.setName('supprimer').setDescription('Supprime un emoji du serveur.')
        .addStringOption((o) => o.setName('emoji').setDescription('L\'emoji, son nom ou son identifiant').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) =>
      s.setName('renommer').setDescription('Renomme un emoji du serveur.')
        .addStringOption((o) => o.setName('emoji').setDescription('L\'emoji, son nom ou son identifiant').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom (2 à 32 lettres, chiffres ou _)').setRequired(true).setMinLength(2).setMaxLength(32))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'info') return showEmoji(interaction, client);
    if (sub === 'ajouter') return addEmoji(interaction, client);
    if (sub === 'supprimer') return deleteEmoji(interaction, client);
    if (sub === 'renommer') return renameEmoji(interaction, client);
    return interaction.reply({ embeds: [status.fail('Sous-commande inconnue.')], ephemeral: true });
  },
};
