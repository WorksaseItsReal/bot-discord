'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { UserError } = require('../core/errors');
const { permissionLabel } = require('./permissionNames');

/**
 * Accès aux commandes par niveaux (/permissions, ADM1). Point de contrôle UNIQUE, appelé par
 * preflight (events/interactionCreate.js) pour chaque commande slash d'un serveur.
 *
 * Règle non négociable : un niveau ne permet JAMAIS d'utiliser une commande qui protège une
 * action SENSIBLE (sanction d'un membre, administration, rôles, webhooks, mention de masse)
 * sans la permission Discord que la commande déclare. Les niveaux :
 *  - RESTREIGNENT (mode strict) : une commande attribuée au niveau N est refusée en dessous de N,
 *    même avec la permission native (sauf Administrateur et owners de sécurité) ;
 *  - DÉLÈGUENT, uniquement les commandes du palier figé « courant » (/embed, /clear, /slowmode,
 *    /pseudo) : un membre de niveau ≥ N les utilise sans leur permission native.
 * Sans commande attribuée, preflight appelle assertMemberPermissions exactement comme avant.
 *
 * Propagation FERMÉE PAR DÉFAUT : seuls requirePermission (ModerationService), hasPermission et
 * memberCanIn honorent la délégation, et seulement pour LA commande déléguée (commande slash en
 * cours, ou composant dont le customId commence par « cmd:<commande>: »).
 */

/** Symbole posé sur l'interaction par preflight quand l'accès passe par une délégation. */
const GRANT = Symbol.for('gadget.grant');

/**
 * Permissions qui protègent une action SENSIBLE : une commande qui en déclare une n'est JAMAIS
 * déléguée (elle ne peut être attribuée qu'en restriction).
 */
const NEVER_DELEGATED = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
]);
const NEVER_DELEGATED_BITS = NEVER_DELEGATED.reduce((a, b) => a | b, 0n);

/**
 * Paliers FIGÉS (non configurables). `delegable` : le palier peut être délégué ; `assigner` :
 * qui peut attribuer (ou retirer) une commande du palier : 'admin' (Administrateur ou rang 4 et
 * plus), 4 (owner de sécurité et plus), 5 (propriétaire). Les paliers « modération » et
 * « sanctions lourdes » protègent des actions sensibles : restriction seulement, jamais délégués.
 */
const DELEGATION_TIERS = Object.freeze({
  low: Object.freeze({ label: 'Courant', emoji: '🟢', delegable: true, assigner: 'admin', commands: Object.freeze(['embed', 'clear', 'slowmode', 'pseudo']) }),
  moderation: Object.freeze({ label: 'Modération', emoji: '🟠', delegable: false, assigner: 4, commands: Object.freeze(['warn', 'timeout', 'untimeout', 'mute', 'unmute', 'kick', 'sanctions']) }),
  high: Object.freeze({ label: 'Sanctions lourdes', emoji: '🔴', delegable: false, assigner: 5, commands: Object.freeze(['ban', 'tempban', 'unban', 'softban']) }),
});

/** Commandes jamais attribuables (la commande elle-même). */
const NOT_ASSIGNABLE = new Set(['permissions']);

const LEVELS = Object.freeze([1, 2, 3]);

/** Palier figé d'une commande, ou null. Pur. */
function tierOf(name) {
  for (const [key, tier] of Object.entries(DELEGATION_TIERS)) if (tier.commands.includes(name)) return { key, ...tier };
  return null;
}

/** Menu contextuel (type 2 ou 3) ? Pur. */
function isContextMenu(command) {
  const type = command?.data?.type ?? command?.data?.toJSON?.().type;
  return type === 2 || type === 3;
}

/** Permission déclarée (default_member_permissions) : BigInt, Administrator pour « 0 », null sans. Pur. */
function declaredFlags(command) {
  const declared = command?.data?.default_member_permissions ?? command?.data?.toJSON?.().default_member_permissions;
  if (declared == null) return null;
  const bits = BigInt(declared);
  return bits === 0n ? PermissionFlagsBits.Administrator : bits;
}

/** La commande peut-elle être attribuée à un niveau ? (slash, ni owner, ni /permissions) Pur. */
function isAssignable(name, command) {
  if (!command || NOT_ASSIGNABLE.has(name) || isContextMenu(command)) return false;
  if (command.ownerOnly || (command.scope ?? 'global') !== 'global') return false;
  return command.data?.name === name;
}

/**
 * La commande peut-elle être DÉLÉGUÉE ? Palier délégable ET permission déclarée sans aucune
 * permission sensible (NEVER_DELEGATED). Double garde : même si un palier changeait, une commande
 * qui déclare « Bannir des membres » ne serait jamais déléguée. Pur.
 */
function isDelegable(name, command) {
  if (!isAssignable(name, command) || !tierOf(name)?.delegable) return false;
  const flags = declaredFlags(command);
  return flags != null && flags !== 0n && (flags & NEVER_DELEGATED_BITS) === 0n;
}

/** Libellés des permissions sensibles qu'une commande déclare (pourquoi elle n'est pas délégable). Pur. */
function sensitiveLabels(command) {
  const flags = declaredFlags(command);
  if (flags == null) return [];
  return new PermissionsBitField(flags & NEVER_DELEGATED_BITS).toArray().map((p) => permissionLabel(p));
}

/**
 * Clé de commande d'un composant : UNIQUEMENT pour un customId « cmd:<commande>:… » (ticket:,
 * giveaway:, secur:… → null : aucune délégation). Pur.
 */
function commandKeyOf(customId) {
  const s = String(customId ?? '');
  if (!s.startsWith('cmd:')) return null;
  const key = s.split(':')[1];
  return key && key !== '_' && /^[-_\p{Ll}\p{N}]{1,32}$/u.test(key) ? key : null;
}

function bitsOf(perms) {
  if (typeof perms === 'bigint') return perms;
  if (typeof perms === 'string') return PermissionFlagsBits[perms] ?? null;
  if (Array.isArray(perms)) {
    let out = 0n;
    for (const p of perms) {
      const b = bitsOf(p);
      if (b == null) return null;
      out |= b;
    }
    return out;
  }
  return null;
}

/** Service des niveaux (null sans GadgetClient complet : tests unitaires anciens). */
function service(client) {
  return client?.services?.permissions ?? null;
}

/** Rang relu à chaque appel (rôles de l'interaction, configuration courante). */
function rankFor(client, interaction) {
  return service(client)?.rankOf?.(interaction.member, { guild: interaction.guild, permissions: interaction.memberPermissions }) ?? 0;
}

/**
 * Délégation de la commande `key` pour l'auteur de l'interaction, ou null : commande délégable,
 * attribuée au niveau N, rang de l'auteur ≥ N. { key, flags, level, rank } (flags = permission
 * déclarée par la commande, jamais une permission sensible).
 */
function grantFor(client, interaction, key) {
  const svc = service(client);
  if (!svc || !interaction?.guildId || !key) return null;
  const level = svc.assignedLevel(interaction.guildId, key);
  if (!level) return null;
  const command = client.commands?.get?.(key);
  if (!isDelegable(key, command)) return null;
  const rank = rankFor(client, interaction);
  if (rank < level) return null;
  return Object.freeze({ key, flags: declaredFlags(command), level, rank });
}

/**
 * Délégation applicable à l'interaction : celle posée par preflight (commande slash), sinon celle
 * de la commande du customId (composant « cmd: »), recalculée à chaque clic. null sinon.
 */
function grantOf(interaction) {
  if (!interaction?.inGuild?.()) return null;
  const memo = interaction[GRANT];
  if (memo) return memo.key === (interaction.commandName ?? commandKeyOf(interaction.customId)) ? memo : null;
  if (interaction.commandName) return null; // commande slash : seul preflight délègue
  const key = commandKeyOf(interaction.customId);
  return key ? grantFor(interaction.client, interaction, key) : null;
}

/**
 * L'auteur a-t-il la permission (nom de flag ou bits) ? Native, sinon par la délégation de SA
 * commande. Administrateur n'est jamais délégué.
 */
function hasPermission(interaction, flag) {
  const bits = bitsOf(flag);
  if (bits == null || bits === 0n) return false;
  if (interaction?.memberPermissions?.has?.(bits)) return true;
  if ((bits & NEVER_DELEGATED_BITS) !== 0n) return false;
  const grant = grantOf(interaction);
  return Boolean(grant && (grant.flags & bits) === bits);
}

/**
 * L'auteur peut-il agir dans ce salon ? Permissions natives dans le salon ; sinon, la délégation
 * doit couvrir ce qui manque ET l'auteur doit voir le salon nativement.
 */
function memberCanIn(interaction, channel, perms) {
  const bits = bitsOf(perms);
  if (bits == null || !channel) return false;
  const native = channel.permissionsFor?.(interaction?.member) ?? null;
  if (native?.has?.(bits)) return true;
  if (!native?.has?.(PermissionFlagsBits.ViewChannel)) return false;
  const missing = bits & ~(native?.bitfield ?? 0n);
  if ((missing & NEVER_DELEGATED_BITS) !== 0n) return false;
  const grant = grantOf(interaction);
  return Boolean(grant && (grant.flags & missing) === missing);
}

/** Message du mode strict. */
function strictMessage(name, level) {
  return `**/${name}** est réservée au **niveau ${level}** ou plus sur ce serveur (mode strict de /permissions).`;
}

/**
 * Mode strict : niveau N exigé pour la commande `key` (attribuée au niveau N) que l'auteur
 * n'atteint pas, ou 0 (accès : mode strict coupé, commande non attribuée, Administrateur, rang 4
 * et plus, rang suffisant). Ne lève jamais.
 */
function strictLevelMissing(client, interaction, key) {
  const svc = service(client);
  if (!svc || !key || !interaction?.guildId) return 0;
  if (!svc.settings(interaction.guildId).strict) return 0;
  const required = svc.assignedLevel(interaction.guildId, key);
  if (!required) return 0;
  if (interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) return 0;
  const rank = rankFor(client, interaction);
  if (rank >= 4 || rank >= required) return 0;
  return required;
}

/**
 * Mode strict : refuse une commande attribuée au niveau N à un membre de rang < N, même avec la
 * permission native (Administrateur et rang 4 et plus exemptés). UserError.
 */
function assertStrict(client, interaction, key) {
  const required = strictLevelMissing(client, interaction, key);
  if (required) throw new UserError(strictMessage(key, required));
}

/**
 * Contexte « interaction » d'un modérateur (GuildMember, ou User en cache sur le serveur) pour le
 * mode strict, ou null : action du bot (AutoMod, échéances, escalade automatique), modérateur
 * absent du cache (la permission native reste revérifiée par l'appelant).
 */
function moderatorContext(client, guild, moderator) {
  if (!guild || !moderator?.id || moderator.id === client?.user?.id || moderator.bot || moderator.user?.bot) return null;
  const member = moderator.roles?.cache ? moderator : guild.members?.cache?.get?.(moderator.id);
  if (!member) return null;
  return { guildId: guild.id, guild, member, memberPermissions: member.permissions };
}

/**
 * Mode strict au niveau de l'ACTION (ModerationService, /activite) : bannir, expulser, timeout…
 * sont refusés à un modérateur de rang < N quand la commande équivalente (`key` : 'ban', 'kick',
 * 'timeout'…) est réservée au niveau N, QUEL QUE SOIT le chemin (bouton d'une autre commande,
 * escalade de /warn). Actions du bot exemptées. UserError.
 */
function assertStrictAction(client, guild, moderator, key) {
  const ctx = moderatorContext(client, guild, moderator);
  if (ctx) assertStrict(client, ctx, key);
}

/** Niveau exigé par le mode strict pour l'action `key` que le modérateur n'atteint pas, ou 0. Ne lève jamais. */
function strictActionLevelMissing(client, guild, moderator, key) {
  const ctx = moderatorContext(client, guild, moderator);
  return ctx ? strictLevelMissing(client, ctx, key) : 0;
}

/**
 * Contrôle central d'une commande slash (preflight). `assertNative` = assertMemberPermissions de
 * interactionCreate (vérification de 0.6.0, toujours appliquée hors délégation).
 *  (a) commande non attribuée (ou hors serveur) : assertNative, à l'identique ; menu contextuel :
 *      assertNative, puis le mode strict de la commande qu'il reproduit (`strictKey`) ;
 *  (b) mode strict et rang < niveau requis : refus « réservée au niveau N » ;
 *  (c) permission native présente : accès ;
 *  (d) commande DÉLÉGABLE et rang ≥ niveau : accès, délégation posée sur l'interaction ;
 *  (e) sinon : le refus natif de assertNative.
 * @returns {{ key: string, flags: bigint, level: number, rank: number }|null} délégation utilisée
 */
function assertCommandAccess(client, interaction, command, assertNative) {
  const name = command?.data?.name;
  const svc = service(client);
  if (isContextMenu(command)) {
    // Menu contextuel : jamais attribuable ni délégué, mais restreint comme la commande qu'il
    // reproduit (`strictKey`, ex. « Sanctions du membre » → /sanctions), après le contrôle natif.
    assertNative(interaction, command);
    if (command.strictKey && interaction?.inGuild?.()) assertStrict(client, interaction, command.strictKey);
    return null;
  }
  const required = interaction?.inGuild?.() && svc ? svc.assignedLevel(interaction.guildId, name) : 0;
  if (!required) {
    assertNative(interaction, command);
    return null;
  }
  assertStrict(client, interaction, name);
  try {
    assertNative(interaction, command);
    return null;
  } catch (err) {
    const grant = grantFor(client, interaction, name);
    if (!grant) throw err;
    interaction[GRANT] = grant;
    return grant;
  }
}

module.exports = {
  GRANT,
  LEVELS,
  NEVER_DELEGATED,
  NEVER_DELEGATED_BITS,
  DELEGATION_TIERS,
  NOT_ASSIGNABLE,
  tierOf,
  declaredFlags,
  isAssignable,
  isDelegable,
  sensitiveLabels,
  commandKeyOf,
  grantFor,
  grantOf,
  hasPermission,
  memberCanIn,
  assertStrict,
  strictLevelMissing,
  assertStrictAction,
  strictActionLevelMissing,
  strictMessage,
  assertCommandAccess,
};
