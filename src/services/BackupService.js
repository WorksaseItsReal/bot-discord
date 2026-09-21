'use strict';

const { ChannelType } = require('discord.js');
const { shortId } = require('../utils/random');
const { UserError } = require('../core/errors');

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
    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString() }));

    const channels = guild.channels.cache
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({
        name: c.name,
        type: c.type,
        parentName: c.parent?.name ?? null,
        topic: c.topic ?? null,
        nsfw: c.nsfw ?? false,
        position: c.rawPosition,
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

  create(guild, user, name) {
    const id = shortId();
    const data = this.serialize(guild);
    this.backups.create({ id, guildId: guild.id, name: name || `Backup ${new Date().toLocaleString('fr-FR')}`, data, createdBy: user?.id ?? null });
    return { id, data };
  }

  list(guildId, limit) {
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

    for (const role of [...data.roles].reverse()) {
      const exists = guild.roles.cache.find((r) => r.name === role.name);
      if (exists) continue;
      await guild.roles
        .create({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions), reason: `Restauration backup ${id}` })
        .then(() => (createdRoles += 1))
        .catch(() => {});
    }

    // Catégories d'abord
    const categories = data.channels.filter((c) => c.type === ChannelType.GuildCategory);
    for (const cat of categories) {
      if (guild.channels.cache.find((c) => c.name === cat.name && c.type === ChannelType.GuildCategory)) continue;
      await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory }).then(() => (createdChannels += 1)).catch(() => {});
    }
    for (const ch of data.channels.filter((c) => c.type !== ChannelType.GuildCategory)) {
      if (guild.channels.cache.find((c) => c.name === ch.name && c.type === ch.type)) continue;
      const parent = ch.parentName ? guild.channels.cache.find((c) => c.name === ch.parentName && c.type === ChannelType.GuildCategory) : null;
      await guild.channels
        .create({ name: ch.name, type: ch.type, parent: parent?.id ?? null, topic: ch.topic ?? undefined, nsfw: ch.nsfw })
        .then(() => (createdChannels += 1))
        .catch(() => {});
    }
    return { roles: createdRoles, channels: createdChannels };
  }
}

module.exports = { BackupService };
