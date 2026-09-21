'use strict';

const checks = require('../utils/automodChecks');
const { parseDuration } = require('../utils/time');
const { embeds } = require('../utils/embeds');
const { PermissionFlagsBits } = require('discord.js');

/**
 * Moteur AutoMod. Combine des détecteurs purs et un suivi temporel en mémoire
 * (spam/flood/repeat) pour décider d'une violation, puis applique la sanction.
 */
class AutoModService {
  /**
   * @param {object} deps
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   * @param {import('./ModerationService').ModerationService} deps.moderation
   */
  constructor({ config, logging, moderation }) {
    this.config = config;
    this.logging = logging;
    this.moderation = moderation;
    /** @type {Map<string, {times:number[], last:string, lastCount:number}>} */
    this.tracker = new Map();
  }

  #key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  /**
   * Analyse un message. Effectue les actions nécessaires. Sans effet si l'AutoMod
   * est désactivé, si l'auteur est ignoré/immunisé, ou s'il n'y a pas de violation.
   * @param {import('discord.js').Message} message
   */
  async handleMessage(message) {
    if (!message.guild || message.author.bot || !message.member) return;
    const cfg = this.config.get(message.guild.id).automod;
    if (!cfg?.enabled) return;

    // Immunités : modérateurs, salons/rôles ignorés
    if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    if (cfg.ignoredChannels?.includes(message.channel.id)) return;
    if (message.member.roles.cache.some((r) => cfg.ignoredRoles?.includes(r.id))) return;

    const violation = this.inspect(message, cfg.filters);
    if (!violation) return;
    await this.#applyAction(message, violation);
  }

  /**
   * Détermine la première violation applicable. Renvoie { filter, action, duration, reason } ou null.
   * @param {import('discord.js').Message} message
   * @param {object} filters
   */
  inspect(message, filters = {}) {
    const content = message.content || '';
    const f = filters;

    if (f.antiInvite?.enabled && checks.hasInvite(content)) return this.#v(f.antiInvite, 'Invitation Discord interdite');
    if (f.antiLink?.enabled && checks.hasLink(content)) return this.#v(f.antiLink, 'Lien interdit');
    if (f.badWords?.enabled && checks.containsBadWord(content, f.badWords.words)) return this.#v(f.badWords, 'Mot interdit');
    if (f.antiMassMention?.enabled && checks.isMassMention(content, f.antiMassMention)) return this.#v(f.antiMassMention, 'Mentions massives');
    if (f.antiCaps?.enabled && checks.isExcessiveCaps(content, f.antiCaps)) return this.#v(f.antiCaps, 'Excès de majuscules');
    if (f.antiEmojiSpam?.enabled && checks.isEmojiSpam(content, f.antiEmojiSpam)) return this.#v(f.antiEmojiSpam, 'Spam d\'emojis');

    // Détecteurs temporels / d'état
    const key = this.#key(message.guild.id, message.author.id);
    const state = this.tracker.get(key) || { times: [], last: null, lastCount: 0 };
    const now = Date.now();

    if (f.antiDuplicate?.enabled || f.antiRepeat?.enabled) {
      if (state.last === content && content.length > 0) {
        state.lastCount += 1;
        if (f.antiDuplicate?.enabled) {
          this.tracker.set(key, state);
          return this.#v(f.antiDuplicate, 'Message dupliqué');
        }
        if (f.antiRepeat?.enabled && state.lastCount >= 3) {
          this.tracker.set(key, state);
          return this.#v(f.antiRepeat, 'Message répété');
        }
      } else {
        state.last = content;
        state.lastCount = 1;
      }
    }

    if (f.antiSpam?.enabled || f.antiFlood?.enabled) {
      const win = (f.antiSpam?.windowSeconds || f.antiFlood?.windowSeconds || 5) * 1000;
      state.times = state.times.filter((t) => now - t < win);
      state.times.push(now);
      const limit = Math.min(f.antiSpam?.enabled ? f.antiSpam.limit : Infinity, f.antiFlood?.enabled ? f.antiFlood.limit : Infinity);
      if (state.times.length >= limit) {
        this.tracker.set(key, state);
        const filter = f.antiSpam?.enabled && f.antiSpam.limit <= (f.antiFlood?.limit ?? Infinity) ? f.antiSpam : f.antiFlood;
        return this.#v(filter, 'Spam / flood détecté');
      }
    }

    this.tracker.set(key, state);
    return null;
  }

  #v(filter, reason) {
    return { action: filter.action || 'delete', duration: filter.duration || null, reason };
  }

  async #applyAction(message, violation) {
    const guild = message.guild;
    await message.delete().catch(() => {});

    if (violation.action === 'timeout') {
      const ms = parseDuration(violation.duration || '5m') || 300_000;
      await message.member.timeout(ms, `AutoMod: ${violation.reason}`).catch(() => {});
    } else if (violation.action === 'warn') {
      await this.moderation
        .record(guild, message.author, guild.members.me, { type: 'warn', reason: `AutoMod: ${violation.reason}` })
        .catch(() => {});
    }

    await this.logging.send(
      guild.id,
      'automod',
      embeds.security('🤖 AutoMod').addFields(
        { name: 'Membre', value: `${message.author} (${message.author.id})`, inline: true },
        { name: 'Salon', value: `${message.channel}`, inline: true },
        { name: 'Règle', value: violation.reason, inline: true },
        { name: 'Action', value: violation.action, inline: true },
        { name: 'Message', value: (message.content || '—').slice(0, 1024) },
      ),
    );
  }
}

module.exports = { AutoModService };
