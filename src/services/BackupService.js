'use strict';

const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');
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

/**
 * Re-mappe les permissions sérialisées vers les IDs actuels du serveur.
 * @param {string[]} [skipped] reçoit les surcharges ignorées (rôle ou membre introuvable)
 */
function resolveOverwrites(overwrites, guild, skipped) {
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
    if (!id) {
      skipped?.push(ow.role ? `@${ow.role}` : ow.member ? `membre ${ow.member}` : '?');
      continue;
    }
    out.push({ id, type, allow: BigInt(ow.allow || 0), deny: BigInt(ow.deny || 0) });
  }
  return out;
}

/**
 * Salons GÉNÉRÉS par le bot, exclus des sauvegardes : salons des compteurs de statistiques
 * (nom qui change sans cesse) et leur catégorie si elle ne contient qu'eux, vocaux
 * temporaires (éphémères). Comparés par nom à la restauration, ils seraient recréés figés.
 * @returns {Set<string>} identifiants
 */
function generatedChannelIds(guild) {
  const out = new Set();
  const client = guild?.client;
  let counters = null;
  try {
    counters = client?.services?.config?.get?.(guild.id)?.statsCounters ?? null;
  } catch {
    counters = null;
  }
  for (const c of Object.values(counters?.counters ?? {})) if (c?.channelId) out.add(c.channelId);
  const tempVoice = client?.repositories?.tempVoice;
  const channels = [...(guild?.channels?.cache?.values?.() ?? [])];
  if (typeof tempVoice?.get === 'function') {
    for (const ch of channels) {
      if ((ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) && tempVoice.get(ch.id)) out.add(ch.id);
    }
  }
  const categoryId = counters?.categoryId;
  if (categoryId && channels.filter((c) => c.parentId === categoryId).every((c) => out.has(c.id))) out.add(categoryId);
  return out;
}

/** Ordre de Discord (position, puis identifiant) : négatif si `a` est sous `b`. Pur. */
function compareRoles(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  return BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0;
}

/**
 * Nouvelles positions des rôles pour retrouver l'ordre RELATIF de la sauvegarde. Pur.
 *
 * Seuls les rôles de la sauvegarde (par nom, non gérés) situés SOUS le rôle le plus haut
 * du bot sont réordonnés, et seulement entre les emplacements qu'ils occupent déjà : les
 * autres rôles gardent leur place, rien ne passe au-dessus du bot. Les positions sous le
 * bot sont normalisées (1…n) pour lever les égalités.
 * @param {Array<{ id: string, name: string, position: number, managed?: boolean }>} roles rôles du serveur (sans @everyone)
 * @param {string[]} backupOrder noms des rôles de la sauvegarde, du plus haut au plus bas
 * @param {number} botPosition position du rôle le plus haut du bot
 * @returns {Array<{ role: string, position: number }>} changements (vide : déjà dans l'ordre)
 */
function planRolePositions(roles, backupOrder, botPosition) {
  const below = roles.filter((r) => r.position < botPosition).toSorted(compareRoles);
  /** Rang dans la sauvegarde (premier rôle d'un même nom seulement). */
  const rankOf = new Map();
  backupOrder.forEach((name, i) => {
    if (!rankOf.has(name)) rankOf.set(name, i);
  });
  const used = new Set();
  const slots = [];
  const movable = [];
  below.forEach((r, i) => {
    if (r.managed || !rankOf.has(r.name) || used.has(r.name)) return;
    used.add(r.name);
    slots.push(i);
    movable.push(r);
  });
  // Du plus haut (rang 0) au plus bas, vers les emplacements du plus haut au plus bas.
  const ordered = movable.toSorted((a, b) => rankOf.get(a.name) - rankOf.get(b.name));
  const next = [...below];
  slots.toReversed().forEach((slot, i) => {
    next[slot] = ordered[i];
  });
  if (next.every((r, i) => r === below[i])) return []; // déjà dans l'ordre : aucun appel
  const changes = [];
  next.forEach((r, i) => {
    if (r.position !== i + 1) changes.push({ role: r.id, position: i + 1 });
  });
  return changes;
}

/** Surcharges identiques (même cible, mêmes permissions), quel que soit l'ordre ? Pur. */
function sameOverwrites(current, wanted) {
  const key = (o) => `${o.id}:${o.type}:${BigInt(o.allow ?? 0)}:${BigInt(o.deny ?? 0)}`;
  const a = current.map(key).sort();
  const b = wanted.map(key).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Le bot doit pouvoir gérer les rôles et les salons : sans cela, chaque création
 * échouerait une à une (et la restauration semblerait « vide »).
 */
function assertRestorePermissions(guild) {
  const perms = guild.members?.me?.permissions;
  if (!perms?.has) return; // bot introuvable dans le cache : on laisse Discord trancher
  const missing = [
    [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
    [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
  ].filter(([flag]) => !perms.has(flag)).map(([, label]) => `**${label}**`);
  if (missing.length) throw new UserError(`Restauration impossible : il me manque la permission ${missing.join(' et ')}.`);
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
    /** Serveurs dont une restauration est en cours (verrou posé de façon synchrone). */
    this.restoring = new Set();
  }

  /** Une restauration est-elle en cours sur ce serveur ? */
  isRestoring(guildId) {
    return this.restoring.has(guildId);
  }

  /** Sérialise la structure d'un serveur (rôles, salons, permissions). */
  serialize(guild) {
    // Copies triées (toSorted) : ne jamais réordonner les caches de discord.js en place.
    // Rôles du plus haut au plus bas.
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .toSorted((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, color: r.colors?.primaryColor ?? r.color ?? 0, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString() }));

    // Les fils (threads) ne font pas partie de la structure : jamais sauvegardés. Les salons
    // générés par le bot (compteurs, vocaux temporaires) non plus.
    const generated = generatedChannelIds(guild);
    const channels = [...guild.channels.cache.values()]
      .filter((c) => !c.isThread?.() && !generated.has(c.id))
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
   * Restauration best-effort : recrée les rôles et salons manquants, remet les rôles
   * dans l'ordre de la sauvegarde et, sur demande, rétablit les permissions des salons
   * qui existent déjà. Une seule restauration à la fois par serveur.
   * @param {{ syncPermissions?: boolean }} [opts] syncPermissions : réécrire les surcharges
   *   des salons existants d'après la sauvegarde (désactivé par défaut)
   * @returns {Promise<RestoreResult>}
   */
  async restore(guild, id, opts = {}) {
    const backup = this.get(guild.id, id);
    // Verrou posé de façon SYNCHRONE, avant toute attente.
    if (this.restoring.has(guild.id)) throw new UserError('Une restauration est déjà en cours sur ce serveur : attendez qu\'elle se termine.');
    this.restoring.add(guild.id);
    try {
      return await this.#restore(guild, backup, id, opts);
    } finally {
      this.restoring.delete(guild.id);
    }
  }

  /**
   * @typedef {{ roles: number, channels: number, failed: Array<{ kind: 'role'|'channel'|'order'|'permissions', name: string, code: string|number }>,
   *   skippedOverwrites: string[], reparented: number, reordered: number, permissionsSynced: number, syncPermissions: boolean }} RestoreResult
   */
  async #restore(guild, backup, id, { syncPermissions = false } = {}) {
    assertRestorePermissions(guild);
    const data = backup.data;
    let createdRoles = 0;
    let createdChannels = 0;
    /** Créations refusées par Discord (nom + code), affichées dans la carte de résultat. */
    const failed = [];
    /** Surcharges de permissions ignorées (rôle ou membre introuvable). */
    const skippedOverwrites = [];
    const fail = (kind, name) => (err) => {
      failed.push({ kind, name, code: err?.code ?? err?.status ?? err?.message ?? 'inconnu' });
      return null;
    };

    // Du plus haut au plus bas : Discord place chaque nouveau rôle juste
    // au-dessus de @everyone, donc le premier créé finit au sommet du lot.
    // (L'ordre inverse renversait la hiérarchie restaurée.) `serialize` les range déjà ainsi.
    for (const role of data.roles ?? []) {
      const exists = guild.roles.cache.find((r) => r.name === role.name);
      if (exists) continue;
      await guild.roles
        .create({ name: role.name, colors: { primaryColor: role.color ?? 0 }, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions), reason: `Restauration backup ${id}` })
        .then(() => (createdRoles += 1), fail('role', role.name));
    }

    // Rôles recréés : Discord les place tout en bas. Un seul appel remet l'ordre relatif
    // de la sauvegarde, sous le rôle le plus haut du bot.
    const reordered = createdRoles > 0 ? await this.#reorderRoles(guild, data.roles ?? [], failed) : 0;

    // Catégories d'abord
    const channels = (data.channels ?? []).filter((c) => !THREAD_TYPES.has(c.type));
    const categories = channels.filter((c) => c.type === ChannelType.GuildCategory);
    const findCategory = (name) => guild.channels.cache.find((c) => c.name === name && c.type === ChannelType.GuildCategory);
    /** Salons et catégories recréés pendant cette restauration (exclus de la resynchronisation). */
    const createdIds = new Set();
    for (const cat of categories) {
      if (findCategory(cat.name)) continue;
      await guild.channels
        .create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: resolveOverwrites(cat.overwrites, guild, skippedOverwrites) })
        .then((c) => {
          createdChannels += 1;
          if (c?.id) createdIds.add(c.id);
        }, fail('channel', cat.name));
    }
    /** Salons créés sans leur catégorie (introuvable à ce moment-là). */
    const orphans = [];
    for (const ch of channels.filter((c) => c.type !== ChannelType.GuildCategory)) {
      if (guild.channels.cache.find((c) => c.name === ch.name && c.type === ch.type)) continue;
      const parent = ch.parentName ? findCategory(ch.parentName) : null;
      const created = await guild.channels
        .create({
          name: ch.name,
          type: ch.type,
          parent: parent?.id ?? null,
          topic: ch.topic ?? undefined,
          nsfw: ch.nsfw,
          // Permissions restaurées (salons privés inclus) ; à défaut (ancienne
          // sauvegarde), on hérite de la catégorie plutôt que de rendre public.
          permissionOverwrites: resolveOverwrites(ch.overwrites, guild, skippedOverwrites) ?? (parent ? parent.permissionOverwrites.cache : undefined),
        })
        .then((c) => {
          createdChannels += 1;
          return c;
        }, fail('channel', ch.name));
      if (created && ch.parentName && !parent) orphans.push([created, ch.parentName]);
      if (created?.id) createdIds.add(created.id);
    }

    // Second passage : rattache les salons dont la catégorie existe désormais
    // (créée entre-temps, ou apparue dans le cache après leur création).
    let reparented = 0;
    for (const [channel, parentName] of orphans) {
      const parent = findCategory(parentName);
      if (!parent || typeof channel.setParent !== 'function') continue;
      await channel.setParent(parent.id, { lockPermissions: false, reason: `Restauration backup ${id}` }).then(() => (reparented += 1), () => {});
    }

    // Option : permissions des salons qui existaient déjà (jamais ceux recréés à l'instant).
    const permissionsSynced = syncPermissions ? await this.#syncOverwrites(guild, channels, createdIds, id, skippedOverwrites, fail) : 0;
    return {
      roles: createdRoles,
      channels: createdChannels,
      failed,
      skippedOverwrites: [...new Set(skippedOverwrites)],
      reparented,
      reordered,
      permissionsSynced,
      syncPermissions: Boolean(syncPermissions),
    };
  }

  /**
   * Remet les rôles de la sauvegarde dans leur ordre relatif (un seul appel setPositions).
   * @returns {Promise<number>} rôles de la sauvegarde déplacés (0 si déjà dans l'ordre ou en cas d'échec, noté dans `failed`)
   */
  async #reorderRoles(guild, backupRoles, failed) {
    const botPosition = guild.members?.me?.roles?.highest?.position;
    if (!botPosition || typeof guild.roles?.setPositions !== 'function') return 0;
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
    const names = backupRoles.map((r) => r.name);
    const changes = planRolePositions(roles, names, botPosition);
    if (!changes.length) return 0;
    try {
      await guild.roles.setPositions(changes);
    } catch (err) {
      failed.push({ kind: 'order', name: 'Ordre des rôles', code: err?.code ?? err?.status ?? err?.message ?? 'inconnu' });
      return 0;
    }
    const inBackup = new Set(names);
    const nameOf = new Map(roles.map((r) => [r.id, r.name]));
    return changes.filter((c) => inBackup.has(nameOf.get(c.role))).length;
  }

  /**
   * Réécrit les surcharges des salons EXISTANTS d'après la sauvegarde. Les surcharges des
   * rôles gérés (intégrations, dont celui du bot) et du bot lui-même sont conservées.
   * @returns {Promise<number>} salons dont les permissions ont été modifiées
   */
  async #syncOverwrites(guild, channels, createdIds, id, skippedOverwrites, fail) {
    let synced = 0;
    const done = new Set(createdIds);
    const meId = guild.members?.me?.id;
    const plain = (o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
    for (const ch of channels) {
      if (!Array.isArray(ch.overwrites)) continue; // ancienne sauvegarde sans permissions
      const existing = guild.channels.cache.find((c) => c.name === ch.name && c.type === ch.type && !done.has(c.id));
      if (!existing?.permissionOverwrites?.cache) continue;
      done.add(existing.id);
      const wanted = resolveOverwrites(ch.overwrites, guild, skippedOverwrites);
      const current = [...existing.permissionOverwrites.cache.values()].map(plain);
      const kept = current.filter((o) => !wanted.some((w) => w.id === o.id)
        && (o.id === meId || (o.type === OverwriteType.Role && guild.roles.cache.get(o.id)?.managed)));
      const next = [...wanted, ...kept];
      if (sameOverwrites(current, next)) continue;
      await existing.permissionOverwrites
        .set(next, `Restauration backup ${id} : permissions`)
        .then(() => (synced += 1), fail('permissions', existing.name));
    }
    return synced;
  }
}

module.exports = { BackupService, MAX_AUTO_BACKUPS, MAX_MANUAL_BACKUPS, MAX_BACKUPS_PER_GUILD, planRolePositions, sameOverwrites, resolveOverwrites, generatedChannelIds };
