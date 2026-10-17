'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { permissionLabel } = require('../utils/permissionNames');
const cards = require('../services/secur/cards');

/**
 * Secur (anti-nuke) : chaque entrée du journal d'audit passe par le moteur (modules du registre,
 * accès de whitelist donnés par un non-owner). Sortie immédiate si rien n'est actif.
 * Serveur quitté : l'état mémoire de Secur est oublié (les données le sont 30 jours plus tard
 * par la purge des serveurs quittés).
 * Requiert l'intent GuildModeration et la permission « Voir les logs du serveur ».
 *
 * Perte d'une permission clé par le bot (rôle modifié ou retiré, par la passerelle : ne dépend PAS
 * du journal d'audit, que Discord cesse d'envoyer sans « Voir les logs ») : alerte critique hors
 * filtres et MP au propriétaire, si Secur ou l'AntiRaid protège le serveur.
 */

/** Permissions sans lesquelles Secur est aveugle (journal d'audit) ou ne peut ni annuler ni sanctionner. */
const KEY_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
]);

const holds = (bits, flag) => (bits & PermissionFlagsBits.Administrator) !== 0n || (bits & flag) !== 0n;

/** Permissions clés détenues avant et plus après (champs de bits du serveur). Pur. */
function lostKeyPermissions(before, after) {
  return KEY_PERMISSIONS.filter((f) => holds(before, f) && !holds(after, f));
}

async function warnLost(client, guild, before, after) {
  if (!guild?.id || guild.ownerId === client.user?.id) return;
  const secur = client.services?.secur;
  if (!secur?.notifier) return;
  const cfg = client.services.config?.get?.(guild.id);
  if (!secur.isActive?.(guild.id) && !cfg?.antiraid?.enabled) return;
  const lost = lostKeyPermissions(before, after);
  if (!lost.length) return;
  const blind = lost.includes(PermissionFlagsBits.ViewAuditLog);
  const names = lost.map((f) => permissionLabel(new PermissionsBitField(f).toArray()[0]));
  await secur.notifier.deliver(guild, { embed: cards.botPermsCard({ lost: names, blind }) }, {
    critical: true,
    fallback: true,
    ping: blind,
    event: 'secur',
    label: blind ? 'Secur est aveugle' : 'Secur affaibli',
    fingerprint: `botperms:${guild.id}:${after}`,
  });
}

/** Permissions du serveur du bot, avec `role` dans l'état `permissions` (rôle modifié). */
function botBits(guild, me, role, permissions) {
  let bits = guild.roles?.everyone?.permissions?.bitfield ?? 0n;
  for (const r of me.roles.cache.values()) bits |= r.id === role.id ? permissions : r.permissions.bitfield;
  return bits;
}

module.exports = [
  {
    name: 'guildAuditLogEntryCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    async execute(client, entry, guild) {
      await client.services?.secur?.handleAuditEntry?.(entry, guild);
    },
  },
  {
    name: 'guildDelete',
    execute(client, guild) {
      if (guild?.available === false) return; // panne Discord passagère : pas un départ
      client.services?.secur?.forgetGuild?.(guild?.id);
    },
  },
  {
    // Rôle porté par le bot dont les permissions changent (son rôle géré compris).
    name: 'roleUpdate',
    async execute(client, oldRole, newRole) {
      const guild = newRole?.guild;
      const me = guild?.members?.me;
      if (!me?.roles?.cache?.has?.(newRole.id) || oldRole.permissions.bitfield === newRole.permissions.bitfield) return;
      await warnLost(client, guild, botBits(guild, me, newRole, oldRole.permissions.bitfield), botBits(guild, me, newRole, newRole.permissions.bitfield));
    },
  },
  {
    // Rôle retiré au bot.
    name: 'guildMemberUpdate',
    async execute(client, oldMember, newMember) {
      if (newMember?.id !== client.user?.id || oldMember?.partial) return;
      const before = oldMember.permissions?.bitfield;
      const after = newMember.permissions?.bitfield;
      if (typeof before !== 'bigint' || typeof after !== 'bigint' || before === after) return;
      await warnLost(client, newMember.guild, before, after);
    },
  },
];

module.exports.lostKeyPermissions = lostKeyPermissions;
