'use strict';

const { PermissionFlagsBits, OverwriteType, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { card, field, ICONS, actionButton, buttonRows, ButtonStyle, subtext } = require('./ui');
const { truncate } = require('./embeds');
const { findBadWord } = require('./automod/words');
const { UserError } = require('../core/errors');

/**
 * Vocaux temporaires : logique pure (noms, permissions, panneau de contrôle).
 * Aucun appel à l'API Discord ici : tout est testable sans client.
 */

/** Longueur maximale d'un nom de salon Discord. */
const NAME_MAX = 100;
/** Discord autorise 2 renommages de salon toutes les 10 minutes. */
const RENAME_LIMIT = 2;
const RENAME_WINDOW_MS = 10 * 60_000;
/** Limite de places d'un salon vocal (0 = illimité). */
const MAX_USER_LIMIT = 99;
const DEFAULT_TEMPLATE = 'Vocal de {pseudo}';
const FALLBACK_NAME = 'Vocal temporaire';

/** Droits du propriétaire sur son vocal (le renommage passe par le panneau, filtré). */
const OWNER_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.MoveMembers;
/** Droits « de gestion » retirés à l'ancien propriétaire lors d'un transfert. */
const OWNER_ONLY = PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageChannels;
/** Rôles et membres « staff » : jamais verrouillés dehors, jamais expulsés par un simple propriétaire. */
const STAFF_PERMISSIONS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers];

/** Débits proposés (kb/s), filtrés selon le niveau de boost du serveur. */
const BITRATES = [8, 16, 32, 64, 96, 128, 192, 256, 384];

/** Régions RTC de Discord (« auto » = choix automatique). */
const REGIONS = [
  ['brazil', 'Brésil', '🇧🇷'],
  ['hongkong', 'Hong Kong', '🇭🇰'],
  ['india', 'Inde', '🇮🇳'],
  ['japan', 'Japon', '🇯🇵'],
  ['rotterdam', 'Europe (Rotterdam)', '🇪🇺'],
  ['singapore', 'Singapour', '🇸🇬'],
  ['south-korea', 'Corée du Sud', '🇰🇷'],
  ['southafrica', 'Afrique du Sud', '🇿🇦'],
  ['sydney', 'Australie (Sydney)', '🇦🇺'],
  ['us-central', 'États-Unis (centre)', '🇺🇸'],
  ['us-east', 'États-Unis (est)', '🇺🇸'],
  ['us-south', 'États-Unis (sud)', '🇺🇸'],
  ['us-west', 'États-Unis (ouest)', '🇺🇸'],
];
const REGION_IDS = new Set(REGIONS.map(([id]) => id));

const SNOWFLAKE = /^\d{17,20}$/;

// ---------------------------------------------------------------- noms

/** Remplit un modèle de nom : {pseudo} (ou {user}), {username}, {n}. Pur. */
function formatName(template, { pseudo = '', username = '', n = 1 } = {}) {
  return String(template || DEFAULT_TEMPLATE).replace(/\{(pseudo|user|username|n)\}/gi, (_, key) => {
    const k = key.toLowerCase();
    if (k === 'n') return String(n);
    if (k === 'username') return username || pseudo;
    return pseudo || username;
  });
}

/** Liste de mots interdits de l'AutoMod, si le filtre est actif sur le serveur. */
function bannedWords(guildConfig) {
  const automod = guildConfig?.automod;
  const filter = automod?.filters?.badWords;
  if (!automod?.enabled || !filter?.enabled || !Array.isArray(filter.words) || !filter.words.length) return null;
  return filter.words;
}

/**
 * Vérifie un nom de salon (ou un modèle de nom). Pur.
 * @param {string} raw
 * @param {object} guildConfig configuration complète du serveur (pour l'AutoMod)
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
function checkName(raw, guildConfig) {
  // Retours à la ligne et caractères de contrôle : remplacés par des espaces.
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'Le nom ne peut pas être vide.' };
  if (name.length > NAME_MAX) return { ok: false, reason: `Le nom est trop long (**${name.length}** caractères, ${NAME_MAX} maximum).` };
  if (/@\s*(everyone|here)\b|<@&\d+>/i.test(name)) {
    return { ok: false, reason: 'Les mentions de masse (@everyone, @here, rôles) sont interdites dans un nom de salon.' };
  }
  if (/discord(?:app)?\.(?:gg|com\/invite)\/|\.gg\/\w/i.test(name)) {
    return { ok: false, reason: 'Les invitations Discord sont interdites dans un nom de salon.' };
  }
  const words = bannedWords(guildConfig);
  if (words && findBadWord(name, words)) return { ok: false, reason: 'Ce nom contient un mot interdit par l\'AutoMod du serveur.' };
  return { ok: true, name };
}

/** Comme checkName, mais lève une UserError. @returns {string} le nom nettoyé */
function assertName(raw, guildConfig) {
  const res = checkName(raw, guildConfig);
  if (!res.ok) throw new UserError(res.reason);
  return res.name;
}

/** Nom d'un nouveau vocal : modèle rempli, ou nom de secours s'il est refusé (pseudo interdit…). Pur. */
function defaultName(template, ctx, guildConfig) {
  const res = checkName(formatName(template, ctx), guildConfig);
  if (res.ok) return res.name;
  const fallback = checkName(formatName(DEFAULT_TEMPLATE.replace('{pseudo}', '{username}'), ctx), guildConfig);
  return fallback.ok ? fallback.name : FALLBACK_NAME;
}

/** Limite de places saisie : entier de 0 à 99. @returns {number} */
function parseLimit(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,2}$/.test(s)) throw new UserError(`Limite invalide : saisissez un nombre entre **0** (illimité) et **${MAX_USER_LIMIT}**.`);
  return Number(s);
}

/**
 * Anti-abus des renommages : au plus RENAME_LIMIT par salon dans la fenêtre.
 * @param {number[]} history horodatages des renommages précédents
 * @returns {{ allowed: boolean, history: number[], retryAt: number | null }}
 */
function renameWindow(history, now = Date.now()) {
  const recent = (history ?? []).filter((t) => now - t < RENAME_WINDOW_MS);
  if (recent.length >= RENAME_LIMIT) return { allowed: false, history: recent, retryAt: Math.min(...recent) + RENAME_WINDOW_MS };
  return { allowed: true, history: recent, retryAt: null };
}

// ---------------------------------------------------------------- permissions

const big = (v) => {
  if (typeof v === 'bigint') return v;
  if (v?.bitfield !== undefined) return BigInt(v.bitfield);
  return BigInt(v ?? 0);
};

/** Overwrites d'un salon sous forme de liste { id, type, allow, deny } (bigint). Pur. */
function snapshot(channel) {
  return [...(channel?.permissionOverwrites?.cache?.values?.() ?? [])].map((o) => ({ id: o.id, type: o.type, allow: big(o.allow), deny: big(o.deny) }));
}

/**
 * Modifie (copie) l'overwrite `id` : ajoute des droits accordés / refusés, en efface d'autres.
 * Un overwrite devenu vide est retiré. Pur.
 */
function setBits(list, id, type, { allow = 0n, deny = 0n, clear = 0n } = {}) {
  const out = list.map((o) => ({ ...o }));
  let entry = out.find((o) => o.id === id);
  if (!entry) {
    entry = { id, type, allow: 0n, deny: 0n };
    out.push(entry);
  }
  entry.allow = ((entry.allow & ~clear) & ~deny) | allow;
  entry.deny = ((entry.deny & ~clear) & ~allow) | deny;
  return out.filter((o) => o.allow !== 0n || o.deny !== 0n);
}

/** Rétablit un droit tel qu'il est dans la catégorie parente (accordé, refusé ou neutre). Pur. */
function restoreBit(list, id, type, flag, parentList) {
  const p = parentList?.find((o) => o.id === id);
  if (p && (p.allow & flag)) return setBits(list, id, type, { allow: flag });
  if (p && (p.deny & flag)) return setBits(list, id, type, { deny: flag });
  return setBits(list, id, type, { clear: flag });
}

/** Rôle ou membre « staff » (administration, gestion des salons, déplacement). */
function hasStaffPermissions(permissions) {
  if (!permissions?.has) return false;
  return STAFF_PERMISSIONS.some((p) => {
    try {
      return permissions.has(p, false);
    } catch {
      return false;
    }
  });
}

/**
 * Verrouille / masque (on) ou rétablit (off) un salon.
 * - on : refuse `flag` à @everyone et à chaque rôle non staff ayant un overwrite,
 *        l'accorde aux membres à garder (présents, propriétaire).
 * - off : remet chaque rôle dans l'état de la catégorie parente (rien n'est ouvert
 *         au-delà de ce que la catégorie autorise : une catégorie privée le reste).
 * Pur.
 */
function accessOverwrites(list, { flag, on, guildId, parent = [], roles, keep = [] }) {
  let out = list.map((o) => ({ ...o }));
  const roleIds = new Set(out.filter((o) => o.type === OverwriteType.Role).map((o) => o.id));
  roleIds.add(guildId);
  for (const id of roleIds) {
    if (id !== guildId && hasStaffPermissions(roles?.get?.(id)?.permissions)) continue;
    out = on ? setBits(out, id, OverwriteType.Role, { deny: flag }) : restoreBit(out, id, OverwriteType.Role, flag, parent);
  }
  if (on) for (const id of new Set(keep)) out = setBits(out, id, OverwriteType.Member, { allow: flag });
  return out;
}

/** Transfert de propriété : droits du propriétaire déplacés de `fromId` vers `toId`. Pur. */
function transferOverwrites(list, fromId, toId) {
  let out = list;
  if (fromId && fromId !== toId && list.some((o) => o.id === fromId)) out = setBits(out, fromId, OverwriteType.Member, { clear: OWNER_ONLY });
  return setBits(out, toId, OverwriteType.Member, { allow: OWNER_PERMISSIONS });
}

/** Bannit du salon (Connect refusé). Pur. */
function banOverwrites(list, ids) {
  return ids.reduce((acc, id) => setBits(acc, id, OverwriteType.Member, { deny: PermissionFlagsBits.Connect }), list);
}

/** Autorise (Voir + Connect accordés, bannissement levé). Pur. */
function permitOverwrites(list, ids) {
  return ids.reduce((acc, id) => setBits(acc, id, OverwriteType.Member, { allow: PermissionFlagsBits.Connect | PermissionFlagsBits.ViewChannel }), list);
}

/** Membres bannis / autorisés d'après les overwrites (hors propriétaire). Pur. */
function memberLists(list, ownerId) {
  const members = list.filter((o) => o.type === OverwriteType.Member && o.id !== ownerId);
  return {
    banned: members.filter((o) => o.deny & PermissionFlagsBits.Connect).map((o) => o.id),
    allowed: members.filter((o) => o.allow & PermissionFlagsBits.Connect).map((o) => o.id),
  };
}

// ---------------------------------------------------------------- débit et région

/** Débit maximal selon le niveau de boost. */
function maxBitrate(guild) {
  if (typeof guild?.maximumBitrate === 'number') return guild.maximumBitrate;
  return [96_000, 128_000, 256_000, 384_000][guild?.premiumTier ?? 0] ?? 96_000;
}

function bitrateChoices(guild) {
  const max = maxBitrate(guild);
  return BITRATES.filter((k) => k * 1000 <= max);
}

function regionLabel(id) {
  if (!id) return 'Automatique';
  const r = REGIONS.find(([k]) => k === id);
  return r ? `${r[2]} ${r[1]}` : id;
}

// ---------------------------------------------------------------- panneau

const mention = (ids, max = 8) => (ids.length ? `${ids.slice(0, max).map((id) => `<@${id}>`).join(' ')}${ids.length > max ? ` +${ids.length - max}` : ''}` : '*Personne*');

/**
 * Panneau de contrôle posté dans le chat du vocal temporaire.
 * @param {{ channel: any, record: { owner_id: string, locked?: number, hidden?: number }, guild?: any, notice?: string }} opts
 */
function panelPayload({ channel, record, guild, notice }) {
  const g = guild ?? channel.guild;
  const ownerId = record.owner_id;
  const locked = Boolean(record.locked);
  const hidden = Boolean(record.hidden);
  const ownerHere = Boolean(channel.members?.has?.(ownerId));
  const limit = channel.userLimit ?? 0;
  const bitrate = Math.round((channel.bitrate ?? 64_000) / 1000);
  const region = channel.rtcRegion ?? null;
  const { banned, allowed } = memberLists(snapshot(channel), ownerId);
  const choices = bitrateChoices(g);
  if (!choices.includes(bitrate)) choices.push(bitrate);
  choices.sort((a, b) => a - b);

  const embed = card({
    tone: locked || hidden ? 'caution' : 'brand',
    section: 'voice',
    icon: '🎛️',
    title: truncate(`Panneau de contrôle · ${channel.name ?? 'Vocal'}`, 200),
    description: [
      notice ? `${notice}\n` : null,
      `Ce vocal appartient à <@${ownerId}>. Il sera supprimé automatiquement dès qu'il sera vide.`,
      ownerHere ? null : `\n🙋 **Le propriétaire est parti** : un membre connecté peut **réclamer** le salon.`,
    ],
    fields: [
      field(ICONS.owner, 'Propriétaire', `<@${ownerId}>${ownerHere ? '' : '\n*absent*'}`),
      field(locked ? ICONS.lock : ICONS.unlock, 'Accès', locked ? 'Verrouillé' : 'Ouvert'),
      field(hidden ? ICONS.hidden : ICONS.visible, 'Visibilité', hidden ? 'Masqué' : 'Visible'),
      field(ICONS.members, 'Places', limit ? `**${limit}** maximum` : 'Illimitées'),
      field('🎚️', 'Débit', `${bitrate} kb/s`),
      field('🌍', 'Région', regionLabel(region)),
      field(ICONS.ban, 'Bannis', mention(banned)),
      field(ICONS.success, 'Autorisés', mention(allowed)),
    ],
    footer: 'Réservé au propriétaire et aux modérateurs',
  });

  const btn = (action, label, emoji, args = [], style = ButtonStyle.Secondary) => actionButton({ command: 'tempvoice', action, args, label, emoji, style });
  const rows = buttonRows(
    locked ? btn('lock', 'Déverrouiller', ICONS.unlock, ['off'], ButtonStyle.Success) : btn('lock', 'Verrouiller', ICONS.lock, ['on']),
    hidden ? btn('hide', 'Afficher', ICONS.visible, ['off'], ButtonStyle.Success) : btn('hide', 'Masquer', ICONS.hidden, ['on']),
    btn('rename', 'Renommer', '✏️'),
    btn('limit', 'Limite', ICONS.members),
    btn('claim', 'Réclamer', '🙋', [], ownerHere ? ButtonStyle.Secondary : ButtonStyle.Primary),
    btn('kick', 'Expulser', '🚪'),
    btn('ban', 'Bannir', ICONS.ban, [], ButtonStyle.Danger),
    btn('permit', 'Autoriser', ICONS.success),
    btn('transfer', 'Transférer', ICONS.owner),
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:tempvoice:bitrate')
        .setPlaceholder('🎚️ Débit audio…')
        .addOptions(choices.slice(-25).map((k) => ({ value: String(k), label: `${k} kb/s`, description: k <= 32 ? 'Économe (connexions faibles)' : k >= 128 ? 'Haute qualité (serveur boosté)' : 'Qualité standard', default: k === bitrate }))),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:tempvoice:region')
        .setPlaceholder('🌍 Région du serveur vocal…')
        .addOptions(
          { value: 'auto', label: 'Automatique', emoji: '🌍', description: 'Discord choisit la meilleure région', default: !region },
          ...REGIONS.map(([id, label, emoji]) => ({ value: id, label, emoji, default: region === id })),
        ),
    ),
  );
  return { embeds: [embed], components: rows };
}

/** Carte éphémère accompagnant un menu de sélection de membres (expulser, bannir…). */
function pickerCard(title, icon, description) {
  return card({ tone: 'info', section: 'voice', icon, title, description: [description, '', subtext('Le panneau du salon sera mis à jour.')] });
}

module.exports = {
  NAME_MAX,
  RENAME_LIMIT,
  RENAME_WINDOW_MS,
  MAX_USER_LIMIT,
  DEFAULT_TEMPLATE,
  FALLBACK_NAME,
  OWNER_PERMISSIONS,
  BITRATES,
  REGIONS,
  REGION_IDS,
  SNOWFLAKE,
  formatName,
  bannedWords,
  checkName,
  assertName,
  defaultName,
  parseLimit,
  renameWindow,
  snapshot,
  setBits,
  restoreBit,
  hasStaffPermissions,
  accessOverwrites,
  transferOverwrites,
  banOverwrites,
  permitOverwrites,
  memberLists,
  maxBitrate,
  bitrateChoices,
  regionLabel,
  panelPayload,
  pickerCard,
};
