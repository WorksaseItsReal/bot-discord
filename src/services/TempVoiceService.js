'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

/**
 * Vocaux temporaires : rejoindre un salon "hub" crée un vocal personnel,
 * supprimé automatiquement quand il devient vide.
 */
class TempVoiceService {
  /**
   * @param {object} deps
   * @param {import('../database/repositories/TempVoiceRepository').TempVoiceRepository} deps.tempVoice
   * @param {import('./ConfigService').ConfigService} deps.config
   */
  constructor({ tempVoice, config }) {
    this.tempVoice = tempVoice;
    this.config = config;
  }

  /** Réagit à un changement d'état vocal (join/leave). */
  async handleVoiceUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const cfg = this.config.get(guild.id).tempVoice;

    // Création : arrivée dans le hub
    if (cfg?.enabled && cfg.hubChannelId && newState.channelId === cfg.hubChannelId) {
      await this.#createFor(newState, cfg).catch(() => {});
    }

    // Suppression : un salon temporaire devenu vide
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const record = this.tempVoice.get(oldState.channelId);
      if (record) {
        const channel = oldState.guild.channels.cache.get(oldState.channelId);
        if (channel && channel.members.size === 0) {
          this.tempVoice.delete(oldState.channelId);
          await channel.delete().catch(() => {});
        }
      }
    }
  }

  async #createFor(state, cfg) {
    const member = state.member;
    const name = (cfg.nameTemplate || 'Vocal de {user}').replace('{user}', member.displayName);
    const channel = await state.guild.channels.create({
      name: name.slice(0, 90),
      type: ChannelType.GuildVoice,
      parent: cfg.categoryId || state.channel?.parentId || null,
      permissionOverwrites: [
        { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect] },
      ],
    });
    this.tempVoice.create(channel.id, state.guild.id, member.id);
    await member.voice.setChannel(channel).catch(() => {});
  }
}

module.exports = { TempVoiceService };
