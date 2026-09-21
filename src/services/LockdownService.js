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
    if (!channel?.manageable && channel?.type !== ChannelType.GuildText) {
      // best-effort ; on tente quand même
    }
    const everyone = channel.guild.roles.everyone;
    const current = channel.permissionOverwrites.cache.get(everyone.id);
    this.locks.save(channel.guild.id, channel.id, {
      allow: current?.allow?.bitfield?.toString() ?? '0',
      deny: current?.deny?.bitfield?.toString() ?? '0',
    });
    await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason });
  }

  /** Déverrouille un salon en restaurant l'état sauvegardé (ou en réinitialisant). */
  async unlockChannel(channel) {
    const everyone = channel.guild.roles.everyone;
    const saved = this.locks.get(channel.guild.id, channel.id);
    if (saved) {
      await channel.permissionOverwrites.edit(everyone, {
        SendMessages: bitToBool(saved.data.allow, saved.data.deny),
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
    const n = await this.#eachTextChannel(guild, (c) => this.unlockChannel(c));
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

function bitToBool(allow) {
  const SEND = PermissionFlagsBits.SendMessages;
  if ((BigInt(allow) & SEND) === SEND) return true;
  return null; // neutre (hérite)
}

module.exports = { LockdownService };
