'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds } = require('../utils/embeds');
const { UserError } = require('../core/errors');

/**
 * Verrouillage de salons et lockdown d'urgence, avec sauvegarde de l'état
 * précédent pour restauration.
 */
class LockdownService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/LockRepository').LockRepository} deps.locks
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ locks, logging }) {
    this.locks = locks;
    this.logging = logging;
  }

  /** Verrouille un salon (retire SendMessages à @everyone) en sauvegardant l'état. */
  async lockChannel(channel, moderator, reason) {
    assertOverwritable(channel);
    const everyone = channel.guild.roles.everyone;
    // Ne sauvegarde l'état d'origine qu'au premier verrouillage : un second lock
    // ne doit pas écraser l'état réel par l'état « verrouillé ».
    if (!this.locks.get(channel.guild.id, channel.id)) {
      const current = channel.permissionOverwrites.cache.get(everyone.id);
      this.locks.save(channel.guild.id, channel.id, {
        allow: current?.allow?.bitfield?.toString() ?? '0',
        deny: current?.deny?.bitfield?.toString() ?? '0',
      });
    }
    await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason });
  }

  /** Déverrouille un salon en restaurant l'état sauvegardé (ou en réinitialisant). */
  async unlockChannel(channel) {
    assertOverwritable(channel);
    const everyone = channel.guild.roles.everyone;
    const saved = this.locks.get(channel.guild.id, channel.id);
    if (saved) {
      await channel.permissionOverwrites.edit(everyone, {
        SendMessages: bitToState(saved.data.allow, saved.data.deny),
      });
      this.locks.delete(channel.guild.id, channel.id);
    } else {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: null });
    }
  }

  async #eachTextChannel(guild, fn) {
    const channels = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText && c.manageable,
    );
    let done = 0;
    for (const channel of channels.values()) {
      try {
        await fn(channel);
        done += 1;
      } catch {
        /* ignore un salon problématique */
      }
    }
    return done;
  }

  async enable(guild, moderator, reason = 'Lockdown') {
    const n = await this.#eachTextChannel(guild, (c) => this.lockChannel(c, moderator, reason));
    await this.logging.send(
      guild.id,
      'security',
      embeds.security('🚨 Lockdown activé').addFields(
        { name: 'Salons verrouillés', value: `${n}`, inline: true },
        { name: 'Par', value: `${moderator}`, inline: true },
        { name: 'Raison', value: reason },
      ),
    );
    return n;
  }

  async disable(guild, moderator) {
    // Ne restaure QUE les salons dont l'état a été sauvegardé lors du verrouillage.
    let n = 0;
    for (const lock of this.locks.list(guild.id)) {
      const channel = guild.channels.cache.get(lock.channel_id);
      if (!channel?.permissionOverwrites) {
        this.locks.delete(guild.id, lock.channel_id); // salon supprimé entre-temps
        continue;
      }
      try {
        await this.unlockChannel(channel);
        n += 1;
      } catch {
        /* ignore un salon problématique */
      }
    }
    await this.logging.send(
      guild.id,
      'security',
      embeds.success(`Lockdown désactivé — ${n} salon(s) déverrouillé(s) par ${moderator}.`, '🔓 Lockdown levé'),
    );
    return n;
  }

  status(guild) {
    return this.locks.list(guild.id).length;
  }
}

/** Restaure l'état tri-valué (true / false / null) de SendMessages. */
function bitToState(allow, deny) {
  const SEND = PermissionFlagsBits.SendMessages;
  if ((BigInt(allow || 0) & SEND) === SEND) return true;
  if ((BigInt(deny || 0) & SEND) === SEND) return false;
  return null; // neutre (hérite)
}

/** Refuse les fils et salons sans permissions propres (UserError). */
function assertOverwritable(channel) {
  if (!channel || channel.isThread?.() || !channel.permissionOverwrites || !channel.guild) {
    throw new UserError('Ce salon ne gère pas de permissions propres (fil ou salon non pris en charge).');
  }
}

module.exports = { LockdownService, bitToState, assertOverwritable };
