'use strict';

const { SlidingWindow } = require('../utils/rate');
const { embeds } = require('../utils/embeds');
const { createLogger } = require('../core/logger');

const logger = createLogger('antiraid');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sécurité anti-raid : détection de vagues d'arrivées, comptes trop récents,
 * bots, et actions destructrices massives (suppression de salons/rôles, bans).
 * Utilise la whitelist avant toute sanction.
 */
class AntiRaidService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   */
  constructor({ client, config, logging }) {
    this.client = client;
    this.config = config;
    this.logging = logging;
    /** @type {Map<string, SlidingWindow>} */
    this.joinWindows = new Map();
    /** @type {Map<string, SlidingWindow>} */
    this.destructiveWindows = new Map();
  }

  isWhitelisted(guildId, userId, roleIds = []) {
    const wl = this.config.get(guildId).whitelist || { users: [], roles: [] };
    if (wl.users?.includes(userId)) return true;
    return roleIds.some((r) => wl.roles?.includes(r));
  }

  #window(map, key, ms) {
    let w = map.get(key);
    if (!w || w.windowMs !== ms) {
      w = new SlidingWindow(ms);
      map.set(key, w);
    }
    return w;
  }

  /** @param {import('discord.js').GuildMember} member */
  async handleJoin(member) {
    const cfg = this.config.get(member.guild.id).antiraid;
    if (!cfg?.enabled) return;
    if (this.isWhitelisted(member.guild.id, member.id)) return;

    // Anti-bot : bot ajouté hors whitelist
    if (cfg.antiBot && member.user.bot) {
      await this.#punishNewMember(member, 'AntiRaid: bot non autorisé', cfg);
      return;
    }

    // Âge de compte minimal
    if (cfg.minAccountAgeDays > 0) {
      const ageDays = (Date.now() - member.user.createdTimestamp) / DAY_MS;
      if (ageDays < cfg.minAccountAgeDays) {
        await this.#punishNewMember(member, `AntiRaid: compte trop récent (${ageDays.toFixed(1)}j)`, cfg);
        return;
      }
    }

    // Vague d'arrivées
    const w = this.#window(this.joinWindows, member.guild.id, cfg.joinWindowSeconds * 1000);
    const count = w.hit();
    if (count >= cfg.joinThreshold) {
      await this.alert(member.guild, `🚨 Vague d'arrivées détectée : **${count}** en ${cfg.joinWindowSeconds}s.`);
      if (cfg.action === 'lockdown') await this.#tryLockdown(member.guild);
    }
  }

  /**
   * Action destructrice détectée via audit log (suppression salon/rôle, ban…).
   * @param {import('discord.js').Guild} guild
   * @param {string} executorId
   * @param {'channelDelete'|'roleDelete'|'ban'} type
   */
  async handleDestructive(guild, executorId, type) {
    const cfg = this.config.get(guild.id).antiraid;
    if (!cfg?.enabled || !executorId) return;
    if (executorId === this.client.user.id) return;
    if (executorId === guild.ownerId) return;
    if (this.isWhitelisted(guild.id, executorId)) return;

    const thresholds = {
      channelDelete: cfg.channelDeleteThreshold,
      roleDelete: cfg.roleDeleteThreshold,
      ban: cfg.banThreshold,
    };
    const limit = thresholds[type];
    if (!limit) return;

    const key = `${guild.id}:${executorId}:${type}`;
    const w = this.#window(this.destructiveWindows, key, cfg.destructiveWindowSeconds * 1000);
    const count = w.hit();
    if (count < limit) return;

    w.reset();
    await this.alert(guild, `🚨 Activité destructrice anormale : <@${executorId}> — **${count}× ${type}** en ${cfg.destructiveWindowSeconds}s.`);
    await this.#punishExecutor(guild, executorId, cfg, type);
  }

  async #punishNewMember(member, reason, cfg) {
    try {
      if (cfg.action === 'ban') await member.ban({ reason });
      else await member.kick(reason);
      await this.alert(member.guild, `🛡️ ${member.user.tag} ${cfg.action === 'ban' ? 'banni' : 'expulsé'} — ${reason}.`);
    } catch (e) {
      logger.debug('punishNewMember', e?.message);
    }
  }

  async #punishExecutor(guild, executorId, cfg, type) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return;
    try {
      if (cfg.punishExecutor === 'ban') {
        await member.ban({ reason: `AntiRaid: ${type} massif` });
      } else if (cfg.punishExecutor === 'strip') {
        const removable = member.roles.cache.filter((r) => r.id !== guild.id && r.editable);
        await member.roles.remove(removable, `AntiRaid: ${type} massif`).catch(() => {});
      }
    } catch (e) {
      logger.debug('punishExecutor', e?.message);
    }
  }

  async #tryLockdown(guild) {
    // Délègue au LockdownService s'il est disponible
    const lockdown = this.client.services?.lockdown;
    if (lockdown) await lockdown.enable(guild, guild.members.me, 'AntiRaid automatique').catch(() => {});
  }

  async alert(guild, text) {
    const cfg = this.config.get(guild.id).antiraid;
    const channelId = cfg.alertChannel || this.config.get(guild.id).logChannels?.security;
    const embed = embeds.security('AntiRaid').setDescription(text);
    if (channelId) {
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(() => {});
    }
    await this.logging.send(guild.id, 'security', embed);
  }
}

module.exports = { AntiRaidService };
