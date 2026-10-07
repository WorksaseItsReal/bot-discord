'use strict';

const { ChannelType, OverwriteType } = require('discord.js');
const { shortId } = require('../utils/random');
const { UserError } = require('../core/errors');
const { AUTO_BACKUP_NAME } = require('../database/repositories/BackupRepository');

/**
 * Quotas par serveur, comptés séparément : les sauvegardes automatiques ne
 * doivent jamais évincer les sauvegardes manuelles (et inversement).
 */
const MAX_AUTO_BACKUPS = 10;
const MAX_MANUAL_BACKUPS = 15;
/** Ancien quota global (compatibilité). */
const MAX_BACKUPS_PER_GUILD = MAX_MANUAL_BACKUPS;

/** Types de fils : exclus des sauvegardes (et ignorés dans les anciennes). */
const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

/**
 * Sérialise les permissions d'un salon. Les rôles sont référencés par NOM
 * (les IDs changent après recréation) ; @everyone a un marqueur dédié.
 * Les surcharges de membres sont conservées par ID.
 */
function serializeOverwrites(channel, guild) {
  const cache = channel.permissionOverwrites?.cache;
  if (!cache) return [];
  const out = [];
  for (const ow of cache.values()) {
    const entry = { allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() };
    if (ow.id === guild.id) out.push({ ...entry, everyone: true });
    else if (ow.type === OverwriteType.Role) {
      const role = guild.roles.cache.get(ow.id);
      if (role && !role.managed) out.push({ ...entry, role: role.name });
    } else if (ow.type === OverwriteType.Member) out.push({ ...entry, member: ow.id });
  }
  return out;
}

/** Re-mappe les permissions sérialisées vers les IDs actuels du serveur. */
function resolveOverwrites(overwrites, guild) {
  if (!Array.isArray(overwrites)) return undefined;
  const out = [];
  for (const ow of overwrites) {
    let id = null;
    let type = OverwriteType.Role;
    if (ow.everyone) id = guild.roles.everyone.id;
    else if (ow.role) id = guild.roles.cache.find((r) => r.name === ow.role && !r.managed)?.id ?? null;
    else if (ow.member && guild.members.cache.has(ow.member)) {
      id = ow.member;
      type = OverwriteType.Member;
    }
    if (!id) continue;
    out.push({ id, type, allow: BigInt(ow.allow || 0), deny: BigInt(ow.deny || 0) });
  }
  return out;
}

/**
 * Sauvegarde/restauration de la structure d'un serveur, dans les limites de
 * l'API Discord. NE restaure PAS les messages ni les membres (impossible).
 */
class BackupService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/BackupRepository').BackupRepository} deps.backups
   */
  constructor({ backups }) {
    this.backups = backups;
  }

  /** Sérialise la structure d'un serveur (rôles, salons, permissions). */
  serialize(guild) {
    // Copies triées (toSorted) : ne jamais réordonner les caches de discord.js en place.
    // Rôles du plus haut au plus bas.
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .toSorted((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, color: r.colors?.primaryColor ?? r.color ?? 0, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString() }));

    // Les fils (threads) ne font pas partie de la structure : jamais sauvegardés.
    const channels = [...guild.channels.cache.values()]
      .filter((c) => !c.isThread?.())
      .toSorted((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({
        name: c.name,
        type: c.type,
        parentName: c.parent?.name ?? null,
        topic: c.topic ?? null,
        nsfw: c.nsfw ?? false,
        position: c.rawPosition,
        overwrites: serializeOverwrites(c, guild),
      }));

    return {
      name: guild.name,
      iconURL: guild.iconURL() || null,
      roles,
      channels,
      createdAt: Date.now(),
      counts: { roles: roles.length, channels: channels.length },
    };
  }

  /**
   * Crée une sauvegarde. Automatique si `opts.auto`, ou si aucun auteur humain
   * n'est fourni (planificateur : `client.user`, un bot) : elle est alors
   * enregistrée sans auteur et comptée dans le quota automatique.
   * @param {{ auto?: boolean }} [opts]
   */
  create(guild, user, name, opts = {}) {
    const id = shortId();
    const data = this.serialize(guild);
    const auto = opts.auto ?? (!user || user.bot === true);
    const fallback = auto ? AUTO_BACKUP_NAME : `Backup ${new Date().toLocaleString('fr-FR')}`;
    this.backups.create({ id, guildId: guild.id, name: String(name || fallback).slice(0, 100), data, createdBy: auto ? null : user.id });
    if (auto) this.backups.prune(guild.id, MAX_AUTO_BACKUPS, 'auto');
    else this.backups.prune(guild.id, MAX_MANUAL_BACKUPS, 'manual');
    return { id, data, auto };
  }

  list(guildId, limit = MAX_AUTO_BACKUPS + MAX_MANUAL_BACKUPS) {
    return this.backups.list(guildId, limit);
  }

  get(guildId, id) {
    const backup = this.backups.get(guildId, id);
    if (!backup) throw new UserError('Sauvegarde introuvable.');
    return backup;
  }

  delete(guildId, id) {
    if (!this.backups.delete(guildId, id)) throw new UserError('Sauvegarde introuvable.');
  }

  /**
   * Restauration best-effort : recrée les rôles et salons manquants.
   * @returns {Promise<{roles:number, channels:number}>}
   */
  async restore(guild, id) {
    const backup = this.get(guild.id, id);
    const data = backup.data;
    let createdRoles = 0;
    let createdChannels = 0;

    // Du plus haut au plus bas : Discord place chaque nouveau rôle juste
    // au-dessus de @everyone, donc le premier créé finit au sommet du lot.
    // (L'ordre inverse renversait la hiérarchie restaurée.) `serialize` les range déjà ainsi.
    for (const role of data.roles ?? []) {
      const exists = guild.roles.cache.find((r) => r.name === role.name);
      if (exists) continue;
      await guild.roles
        .create({ name: role.name, colors: { primaryColor: role.color ?? 0 }, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions), reason: `Restauration backup ${id}` })
        .then(() => (createdRoles += 1))
        .catch(() => {});
    }

    // Catégories d'abord
    const channels = (data.channels ?? []).filter((c) => !THREAD_TYPES.has(c.type));
    const categories = channels.filter((c) => c.type === ChannelType.GuildCategory);
    for (const cat of categories) {
      if (guild.channels.cache.find((c) => c.name === cat.name && c.type === ChannelType.GuildCategory)) continue;
      await guild.channels
        .create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: resolveOverwrites(cat.overwrites, guild) })
        .then(() => (createdChannels += 1))
        .catch(() => {});
    }
    for (const ch of channels.filter((c) => c.type !== ChannelType.GuildCategory)) {
      if (guild.channels.cache.find((c) => c.name === ch.name && c.type === ch.type)) continue;
      const parent = ch.parentName ? guild.channels.cache.find((c) => c.name === ch.parentName && c.type === ChannelType.GuildCategory) : null;
      await guild.channels
        .create({
          name: ch.name,
          type: ch.type,
          parent: parent?.id ?? null,
          topic: ch.topic ?? undefined,
          nsfw: ch.nsfw,
          // Permissions restaurées (salons privés inclus) ; à défaut (ancienne
          // sauvegarde), on hérite de la catégorie plutôt que de rendre public.
          permissionOverwrites: resolveOverwrites(ch.overwrites, guild) ?? (parent ? parent.permissionOverwrites.cache : undefined),
        })
        .then(() => (createdChannels += 1))
        .catch(() => {});
    }
    return { roles: createdRoles, channels: createdChannels };
  }
}

module.exports = { BackupService, MAX_AUTO_BACKUPS, MAX_MANUAL_BACKUPS, MAX_BACKUPS_PER_GUILD };
