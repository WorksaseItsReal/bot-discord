'use strict';

const checks = require('../utils/automodChecks');
const { parseDuration } = require('../utils/time');
const { truncate } = require('../utils/embeds');
const { PermissionFlagsBits } = require('discord.js');
const { field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle } = require('../utils/ui');
const { logCard } = require('./LoggingService');

/** Libellés des actions AutoMod. */
const ACTION_LABELS = { delete: 'Message supprimé', warn: 'Avertissement', timeout: 'Timeout' };

/** Inactivité au-delà de laquelle l'état d'un membre est oublié (mémoire bornée). */
const TRACKER_TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;

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
    /** @type {Map<string, {spam:number[], flood:number[], last:string|null, lastCount:number, seen:number}>} */
    this.tracker = new Map();
    this.lastPrune = Date.now();
  }

  /** Oublie les membres inactifs pour borner la mémoire du tracker. */
  prune(now = Date.now()) {
    this.lastPrune = now;
    for (const [key, state] of this.tracker) {
      if (now - state.seen > TRACKER_TTL_MS) this.tracker.delete(key);
    }
  }

  #key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  /**
   * Analyse un message. Effectue les actions nécessaires. Sans effet si l'AutoMod
   * est désactivé, si l'auteur est ignoré/immunisé, ou s'il n'y a pas de violation.
   * @param {import('discord.js').Message} message
   * @param {{ edited?: boolean }} [opts] message édité : seuls les filtres de contenu
   *   s'appliquent (pas de comptage spam/flood/doublons).
   */
  async handleMessage(message, { edited = false } = {}) {
    if (!message.guild || message.author.bot || !message.member) return;
    const cfg = this.config.get(message.guild.id).automod;
    if (!cfg?.enabled) return;

    // Immunités : modérateurs, salons/rôles ignorés
    if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    if (cfg.ignoredChannels?.includes(message.channel.id)) return;
    if (message.member.roles.cache.some((r) => cfg.ignoredRoles?.includes(r.id))) return;

    const violation = this.inspect(message, cfg.filters, { temporal: !edited });
    if (!violation) return;
    await this.#applyAction(message, violation);
  }

  /**
   * Détermine la première violation applicable. Renvoie { filter, action, duration, reason } ou null.
   * @param {import('discord.js').Message} message
   * @param {object} filters
   * @param {{ temporal?: boolean }} [opts]
   */
  inspect(message, filters = {}, { temporal = true } = {}) {
    const content = message.content || '';
    const f = filters;

    if (f.antiInvite?.enabled && checks.hasInvite(content)) return this.#v(f.antiInvite, 'Invitation Discord interdite');
    if (f.antiLink?.enabled && checks.hasLink(content)) return this.#v(f.antiLink, 'Lien interdit');
    if (f.badWords?.enabled && checks.containsBadWord(content, f.badWords.words)) return this.#v(f.badWords, 'Mot interdit');
    if (f.antiMassMention?.enabled && checks.isMassMention(content, f.antiMassMention)) return this.#v(f.antiMassMention, 'Mentions massives');
    if (f.antiCaps?.enabled && checks.isExcessiveCaps(content, f.antiCaps)) return this.#v(f.antiCaps, 'Excès de majuscules');
    if (f.antiEmojiSpam?.enabled && checks.isEmojiSpam(content, f.antiEmojiSpam)) return this.#v(f.antiEmojiSpam, 'Spam d\'emojis');

    if (!temporal) return null;

    // Détecteurs temporels / d'état
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    const key = this.#key(message.guild.id, message.author.id);
    const state = this.tracker.get(key) || { spam: [], flood: [], last: null, lastCount: 0, seen: now };
    state.seen = now;
    this.tracker.set(key, state);

    if (f.antiDuplicate?.enabled || f.antiRepeat?.enabled) {
      if (state.last === content && content.length > 0) {
        state.lastCount += 1;
        if (f.antiDuplicate?.enabled) return this.#v(f.antiDuplicate, 'Message dupliqué');
        if (f.antiRepeat?.enabled && state.lastCount >= 3) {
          state.lastCount = 0; // réinitialise : pas une sanction par message suivant
          return this.#v(f.antiRepeat, 'Message répété');
        }
      } else {
        state.last = content;
        state.lastCount = 1;
      }
    }

    // Chaque filtre activé est évalué avec SA fenêtre et SA limite.
    let hit = null;
    for (const [name, filter, reason] of [
      ['spam', f.antiSpam, 'Spam détecté'],
      ['flood', f.antiFlood, 'Flood détecté'],
    ]) {
      if (!filter?.enabled) continue;
      const win = (filter.windowSeconds || 5) * 1000;
      const times = state[name].filter((t) => now - t < win);
      times.push(now);
      if (times.length >= (filter.limit || 5)) {
        state[name] = []; // réinitialise après violation
        hit ??= this.#v(filter, reason);
      } else {
        state[name] = times;
      }
    }
    return hit;
  }

  #v(filter, reason) {
    return { action: filter.action || 'delete', duration: filter.duration || null, reason };
  }

  async #applyAction(message, violation) {
    const guild = message.guild;
    await message.delete().catch(() => {});

    let timedOut = false;
    let actionText = ACTION_LABELS.delete;
    if (violation.action === 'timeout') {
      const duration = violation.duration || '5m';
      const ms = parseDuration(duration) || 300_000;
      timedOut = await message.member.timeout(ms, `AutoMod: ${violation.reason}`).then(() => true, () => false);
      actionText = timedOut ? `${ACTION_LABELS.timeout} (${duration})` : `${ACTION_LABELS.delete} · timeout impossible`;
    } else if (violation.action === 'warn') {
      const warned = await this.moderation
        .record(guild, message.author, guild.members.me, { type: 'warn', reason: `AutoMod: ${violation.reason}` })
        .then((r) => r, () => null);
      actionText = warned?.id ? `${ACTION_LABELS.warn} (sanction #${warned.id})` : ACTION_LABELS.warn;
    }

    const embed = logCard({
      category: 'automod',
      tone: timedOut ? 'danger' : 'caution',
      icon: ICONS.automod,
      title: 'Message filtré',
      description: `Un message de ${message.author} a été bloqué dans ${message.channel}.`,
      user: message.author,
      fields: [
        field(ICONS.user, 'Membre', userLine(message.author)),
        field(ICONS.warning, 'Règle', violation.reason),
        field(ICONS.shield, 'Action', actionText),
        wide(ICONS.channel, 'Message', message.content ? truncate(message.content, 1024) : '*Aucun contenu texte*'),
      ],
    });
    const components = buttonRows(
      timedOut
        ? actionButton({ command: 'untimeout', action: 'revoke', args: [message.author.id], label: 'Retirer le timeout', emoji: ICONS.unmute, style: ButtonStyle.Success })
        : null,
      actionButton({ command: 'sanctions', action: 'history', args: [message.author.id], label: 'Sanctions', emoji: ICONS.history }),
    );
    await this.logging.send(guild.id, 'automod', embed, components);
  }
}

module.exports = { AutoModService };
