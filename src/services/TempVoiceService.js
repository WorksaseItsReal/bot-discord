'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { card, field, ICONS, bullets } = require('../utils/ui');
const { CooldownManager } = require('../core/cooldowns');

/** Délai minimal entre deux créations de vocal pour un même membre (anti va-et-vient). */
const HUB_COOLDOWN_MS = 10_000;

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
    /** Cooldown par membre sur le hub : évite les rafales création/suppression. */
    this.hubCooldowns = new CooldownManager();
  }

  /** Réagit à un changement d'état vocal (join/leave). */
  async handleVoiceUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const cfg = this.config.get(guild.id).tempVoice;

    // Création : arrivée dans le hub
    if (cfg?.enabled && cfg.hubChannelId && newState.channelId === cfg.hubChannelId && oldState.channelId !== newState.channelId) {
      const userId = newState.member?.id ?? newState.id;
      // En cooldown : le membre reste dans le hub, aucun salon n'est créé.
      if (!this.hubCooldowns.hit(`${guild.id}:${userId}`, HUB_COOLDOWN_MS)) {
        await this.#createFor(newState, cfg).catch(() => {});
      }
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
    if (!member) return;
    const name = (cfg.nameTemplate || 'Vocal de {user}').replace('{user}', member.displayName);
    // Catégorie configurée supprimée : on retombe sur celle du hub.
    const category = cfg.categoryId && state.guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : null;
    const channel = await state.guild.channels.create({
      name: name.slice(0, 90) || 'Vocal',
      type: ChannelType.GuildVoice,
      parent: category || state.channel?.parentId || null,
      permissionOverwrites: [
        { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect] },
      ],
    });
    this.tempVoice.create(channel.id, state.guild.id, member.id);
    try {
      await member.voice.setChannel(channel);
    } catch {
      // Le membre a quitté entre-temps (ou déplacement impossible) : pas de salon orphelin.
      this.tempVoice.delete(channel.id);
      await channel.delete().catch(() => {});
      return;
    }
    // Carte d'accueil dans le chat textuel du vocal (facultative).
    if (typeof channel.send === 'function') {
      await channel.send({ embeds: [this.welcomeCard(member, channel)] }).catch(() => {});
    }
  }

  /** Carte d'accueil d'un vocal temporaire. Pure. */
  welcomeCard(member, channel) {
    return card({
      tone: 'info',
      section: 'voice',
      icon: ICONS.voice,
      title: 'Votre vocal temporaire',
      description: [
        `Bienvenue ${member} ! Ce salon est à vous : il sera supprimé automatiquement dès qu'il sera vide.`,
        '',
        bullets([
          'Renommez-le ou fixez une limite de places depuis ses paramètres.',
          'Déplacez ou déconnectez les membres si besoin.',
        ]),
      ],
      fields: [field(ICONS.owner, 'Propriétaire', `${member}`), field(ICONS.voice, 'Salon', `${channel}`)],
      footer: 'Vocaux temporaires',
    });
  }

  /** Vocaux temporaires actifs d'un serveur. */
  listByGuild(guildId) {
    return this.tempVoice.all().filter((r) => r.guild_id === guildId);
  }

  /**
   * Nettoyage au démarrage : supprime les salons temporaires vides et oublie
   * ceux qui n'existent plus (suppressions survenues pendant que le bot était hors ligne).
   * @param {import('discord.js').Client} client
   * @returns {Promise<{ deleted: number, dropped: number }>}
   */
  async cleanup(client) {
    let deleted = 0;
    let dropped = 0;
    for (const record of this.tempVoice.all()) {
      const guild = client.guilds.cache.get(record.guild_id);
      if (!guild) {
        // Serveur indisponible (panne) ou quitté : on ne touche à rien, il peut revenir.
        continue;
      }
      const channel = await guild.channels.fetch(record.channel_id).catch(() => null);
      if (!channel) {
        this.tempVoice.delete(record.channel_id);
        dropped += 1;
        continue;
      }
      if (channel.members?.size === 0) {
        this.tempVoice.delete(record.channel_id);
        await channel.delete('Vocal temporaire vide').catch(() => {});
        deleted += 1;
      }
    }
    return { deleted, dropped };
  }
}

module.exports = { TempVoiceService, HUB_COOLDOWN_MS };
