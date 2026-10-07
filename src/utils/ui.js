'use strict';

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { brand, brandFooter, truncate, LIMITS } = require('./embeds');
const { categoryMeta } = require('./categories');

/**
 * ============================================================================
 *  Système de design — UNE seule source pour le rendu de toutes les réponses.
 * ============================================================================
 *
 *  Anatomie d'une carte (voir docs/DESIGN.md) :
 *
 *    ┃ 🔨  Modération                  ← section (author) : où l'on est
 *    ┃ ⛔  Membre banni                ← titre : ce qui s'est passé
 *    ┃ @Bob ne peut plus rejoindre…    ← description : la phrase clé
 *    ┃ 👤 Membre   🛡️ Modérateur  ⏱️ Durée   ← champs inline, par 3
 *    ┃ 📝 Raison                       ← champ pleine largeur
 *    ┃ Gadget • Sanction #12 · 12:04   ← pied de page de marque
 *    [ 🔓 Débannir ] [ 📜 Sanctions ] [ 🗑️ ]   ← actions
 *
 *  Règles : couleurs uniquement via TONES, icônes uniquement via ICONS,
 *  jamais de `new EmbedBuilder()` ni de `.setColor()` hors de ce fichier.
 */

/** Palette sémantique (couleurs officielles de Discord). */
const TONES = Object.freeze({
  brand: 0x5865f2, // identité du bot, informations générales
  neutral: 0x2b2d31, // panneaux discrets, se fond dans le thème sombre
  info: 0x00a8fc, // aide, astuces, état
  success: 0x23a55a, // action réussie, levée de sanction
  warning: 0xf0b232, // avertissement, confirmation demandée
  danger: 0xf23f43, // erreur, bannissement, suppression
  caution: 0xf57731, // sanction intermédiaire (timeout, mute, kick)
  fun: 0xeb459e, // jeux et divertissement
  celebrate: 0xf47fff, // giveaways, félicitations
  gold: 0xf1c40f, // classements, mises en avant
});

/** Jeu d'icônes unique : un concept = un emoji, partout dans le bot. */
const ICONS = Object.freeze({
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  loading: '⏳',
  user: '👤',
  members: '👥',
  moderator: '🛡️',
  owner: '👑',
  bot: '🤖',
  reason: '📝',
  duration: '⏱️',
  expires: '⌛',
  date: '📅',
  time: '🕒',
  id: '🆔',
  channel: '💬',
  voice: '🔊',
  category: '🗂️',
  role: '🎭',
  color: '🎨',
  count: '🔢',
  link: '🔗',
  status: '📌',
  settings: '⚙️',
  lock: '🔒',
  unlock: '🔓',
  hidden: '🙈',
  visible: '👁️',
  ban: '⛔',
  kick: '👢',
  mute: '🔇',
  unmute: '🔊',
  warn: '⚠️',
  history: '📜',
  stats: '📊',
  list: '📋',
  search: '🔎',
  refresh: '🔄',
  delete: '🗑️',
  back: '◀️',
  next: '▶️',
  first: '⏮️',
  last: '⏭️',
  image: '🖼️',
  shield: '🛡️',
  automod: '🤖',
  ticket: '🎫',
  mail: '📨',
  gift: '🎉',
  idea: '💡',
  project: '📁',
  task: '🧩',
  tag: '🏷️',
  boost: '💎',
  emoji: '😀',
  server: '🏠',
  latency: '📡',
  heart: '💓',
  memory: '💾',
  dice: '🎲',
  help: '❓',
  rocket: '🚀',
  star: '⭐',
  check: '☑️',
  empty: '—',
});

const EMPTY = '—';

/** Section (ligne d'en-tête discrète) à partir d'une catégorie de commandes ou d'un libellé libre. */
function sectionAuthor(section) {
  if (!section) return null;
  const meta = typeof section === 'string' ? categoryMeta(section) : section;
  const label = meta.label ?? String(section);
  const name = truncate(meta.emoji ? `${meta.emoji}  ${label}` : label, LIMITS.author);
  return brand.iconURL ? { name, iconURL: brand.iconURL } : { name };
}

/**
 * Aligne les champs inline par groupes de 3 (grille propre sur ordinateur) :
 * un groupe de 2 champs inline reçoit un champ vide invisible.
 */
function alignInline(fields) {
  const out = [];
  let run = 0;
  const flush = () => {
    if (run % 3 === 2) out.push(blank());
    run = 0;
  };
  for (const f of fields) {
    if (f.inline) run += 1;
    else flush();
    out.push(f);
    if (run === 3) run = 0;
  }
  flush();
  return out.slice(0, LIMITS.fields);
}

/**
 * Carte standard. C'est LA fonction à utiliser pour toute réponse riche.
 * @param {{
 *   tone?: keyof TONES | number,
 *   section?: string | { emoji?: string, label: string },
 *   icon?: string, title?: string, url?: string,
 *   description?: string | string[],
 *   fields?: Array<{ name: string, value: string, inline?: boolean } | null | false>,
 *   thumbnail?: string | null, image?: string | null,
 *   footer?: string, timestamp?: number | Date | boolean,
 *   align?: boolean,
 * }} opts
 */
function card(opts = {}) {
  const {
    tone = 'brand',
    section,
    icon,
    title,
    url,
    description,
    fields = [],
    thumbnail,
    image,
    footer,
    timestamp = true,
    align = true,
  } = opts;
  const embed = new EmbedBuilder().setColor(typeof tone === 'number' ? tone : TONES[tone] ?? TONES.brand);
  const author = sectionAuthor(section);
  if (author) embed.setAuthor(author);
  if (title) embed.setTitle(truncate(icon ? `${icon}  ${title}` : title, LIMITS.title));
  if (url) embed.setURL(url);
  const desc = Array.isArray(description) ? description.filter((l) => l != null && l !== false).join('\n') : description;
  if (desc) embed.setDescription(truncate(desc, LIMITS.description));
  const clean = fields.filter(Boolean).map((f) => ({
    name: truncate(f.name || '​', LIMITS.fieldName) || '​',
    value: truncate(f.value == null || f.value === '' ? EMPTY : String(f.value), LIMITS.fieldValue),
    inline: Boolean(f.inline),
  }));
  if (clean.length) embed.addFields(align ? alignInline(clean) : clean.slice(0, LIMITS.fields));
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);
  embed.setFooter(brandFooter(footer));
  if (timestamp) embed.setTimestamp(timestamp === true ? Date.now() : timestamp);
  return embed;
}

/** Champ « icône + libellé ». Inline par défaut (grille de 3). */
function field(icon, label, value, inline = true) {
  return { name: icon ? `${icon} ${label}` : label, value: value == null || value === '' ? EMPTY : String(value), inline };
}

/** Champ pleine largeur. */
function wide(icon, label, value) {
  return field(icon, label, value, false);
}

/** Champ vide (espaceur de grille). */
function blank(inline = true) {
  return { name: '​', value: '​', inline };
}

/** Lignes « Libellé · valeur » alignées. */
function kv(pairs) {
  return pairs
    .filter(Boolean)
    .map(([label, value]) => `**${label}** · ${value == null || value === '' ? EMPTY : value}`)
    .join('\n');
}

/** Liste à puces sobre. */
function bullets(items, { bullet = '›', empty = EMPTY } = {}) {
  if (!items?.length) return empty;
  return items.map((i) => `${bullet} ${i}`).join('\n');
}

/** Petite ligne grise sous un texte (markdown « -# »). */
function subtext(text) {
  return `-# ${text}`;
}

/** Utilisateur lisible : mention + identifiant. */
function userLine(user) {
  if (!user) return EMPTY;
  return `${user} · \`${user.username ?? user.tag ?? user.id}\``;
}

/** Identifiant Discord en police fixe. */
function code(value) {
  return `\`${String(value).replace(/`/g, 'ˋ')}\``;
}

// ---------------------------------------------------------------- statuts

/**
 * Cartes de statut compactes (succès, erreur…) : pas de section, un titre
 * court optionnel, la phrase utile. Utilisées pour les retours d'action.
 */
function statusCard(tone, icon, message, title, extra = {}) {
  return card({
    tone,
    icon: title ? icon : undefined,
    title,
    description: title ? message : `${icon}  ${message}`,
    ...extra,
  });
}

const status = {
  ok: (message, title, extra) => statusCard('success', ICONS.success, message, title, extra),
  fail: (message, title, extra) => statusCard('danger', ICONS.error, message, title, extra),
  warn: (message, title, extra) => statusCard('warning', ICONS.warning, message, title, extra),
  note: (message, title, extra) => statusCard('info', ICONS.info, message, title, extra),
  wait: (message = 'Traitement en cours…', title, extra) => statusCard('neutral', ICONS.loading, message, title, extra),
};

// ---------------------------------------------------------------- boutons

/**
 * Bouton d'action persistant, routé vers `command.buttons[action]`
 * (voir src/components/cmd.js). customId : `cmd:<commande>:<action>:<args…>`.
 * Survit aux redémarrages : l'état nécessaire est encodé dans les arguments.
 */
function actionButton({ command, action, args = [], label, emoji, style = ButtonStyle.Secondary, disabled = false }) {
  const customId = ['cmd', command, action, ...args.map(String)].join(':');
  if (customId.length > 100) throw new Error(`customId trop long (${customId.length}) : ${customId.slice(0, 40)}…`);
  const b = new ButtonBuilder().setCustomId(customId).setStyle(style);
  if (label) b.setLabel(truncate(label, 80));
  if (emoji) b.setEmoji(emoji);
  if (!label && !emoji) b.setLabel('…');
  if (disabled) b.setDisabled(true);
  return b;
}

/** Bouton lien (toujours gris, ouvre une URL). */
function linkButton(label, url, emoji) {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url);
  if (label) b.setLabel(truncate(label, 80));
  if (emoji) b.setEmoji(emoji);
  if (!label && !emoji) b.setLabel('Ouvrir');
  return b;
}

/** Bouton 🗑️ : supprime le message (auteur de la commande ou « Gérer les messages »). */
function deleteButton(ownerId) {
  return actionButton({ command: '_', action: 'delete', args: [ownerId], emoji: ICONS.delete, style: ButtonStyle.Secondary });
}

/** Bouton désactivé servant d'étiquette (ex : « Page 2/5 »). */
function labelButton(label, id = `cmd:_:noop:${Math.random().toString(36).slice(2, 8)}`) {
  return new ButtonBuilder().setCustomId(id).setLabel(truncate(label, 80)).setStyle(ButtonStyle.Secondary).setDisabled(true);
}

/** Range des boutons en rangées de 5 (ignore les valeurs vides). */
function buttonRows(...buttons) {
  const list = buttons.flat().filter(Boolean);
  const rows = [];
  for (let i = 0; i < list.length && rows.length < 5; i += 5) rows.push(new ActionRowBuilder().addComponents(list.slice(i, i + 5)));
  return rows;
}

module.exports = {
  TONES,
  ICONS,
  EMPTY,
  card,
  field,
  wide,
  blank,
  kv,
  bullets,
  subtext,
  userLine,
  code,
  status,
  alignInline,
  actionButton,
  linkButton,
  deleteButton,
  labelButton,
  buttonRows,
  ButtonStyle,
};
