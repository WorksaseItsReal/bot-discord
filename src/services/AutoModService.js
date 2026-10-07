'use strict';

const checks = require('../utils/automodChecks');
const { parseDuration } = require('../utils/time');
const { truncate } = require('../utils/embeds');
const { PermissionFlagsBits } = require('discord.js');
const { field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle } = require('../utils/ui');
const { logCard } = require('./LoggingService');
const { historyButton } = require('./ModerationService');

/** Libellés des actions AutoMod. */
const ACTION_LABELS = { delete: 'Message supprimé', warn: 'Avertissement', timeout: 'Timeout' };

/** Inactivité au-delà de laquelle l'état d'un membre est oublié (mémoire bornée). */
const TRACKER_TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
/** Deux messages identiques espacés de plus de 30 s ne sont pas des doublons. */
const DUPLICATE_WINDOW_MS = 30 * 1000;
/** Sévérité des actions : la violation la plus sévère l'emporte. */
const SEVERITY = { delete: 1, warn: 2, timeout: 3 };

/** Violation la plus sévère (à égalité, la première détectée). Pur. */
function mostSevere(hits) {
  let best = null;
  for (const h of hits) if (!best || (SEVERITY[h.action] ?? 0) > (SEVERITY[best.action] ?? 0)) best = h;
  return best;
}

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
   * @param {import('./StrikeService').StrikeService} [deps.strikes] (sinon : client.services.strikes)
   */
  constructor({ config, logging, moderation, strikes }) {
    this.config = config;
    this.logging = logging;
    this.moderation = moderation;
    this._strikes = strikes ?? null;
    /** @type {Map<string, {spam:number[], flood:number[], last:string|null, lastAt:number, lastCount:number, seen:number}>} */
    this.tracker = new Map();
    this.lastPrune = Date.now();
  }

  /** Service de strikes (injecté, ou résolu via le client du LoggingService). */
  get strikes() {
    return this._strikes ?? this.logging?.client?.services?.strikes ?? null;
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
   * Détermine la violation la plus sévère. Renvoie { action, duration, reason } ou null.
   * Tous les filtres sont évalués : le comptage spam/flood a lieu à CHAQUE message
   * (avant les doublons), sinon un message filtré par ailleurs échapperait au comptage.
   * @param {import('discord.js').Message} message
   * @param {object} filters
   * @param {{ temporal?: boolean }} [opts]
   */
  inspect(message, filters = {}, { temporal = true } = {}) {
    const content = message.content || '';
    const f = filters;
    const hits = [];
    const hit = (filter, reason) => hits.push(this.#v(filter, reason));

    if (f.antiInvite?.enabled && checks.hasInvite(content)) hit(f.antiInvite, 'Invitation Discord interdite');
    if (f.antiLink?.enabled && checks.hasLink(content)) hit(f.antiLink, 'Lien interdit');
    if (f.badWords?.enabled && checks.containsBadWord(content, f.badWords.words)) hit(f.badWords, 'Mot interdit');
    if (f.antiMassMention?.enabled && checks.isMassMention(content, f.antiMassMention)) hit(f.antiMassMention, 'Mentions massives');
    if (f.antiCaps?.enabled && checks.isExcessiveCaps(content, f.antiCaps)) hit(f.antiCaps, 'Excès de majuscules');
    if (f.antiEmojiSpam?.enabled && checks.isEmojiSpam(content, f.antiEmojiSpam)) hit(f.antiEmojiSpam, 'Spam d\'emojis');

    if (temporal) this.#inspectTemporal(message, content, f, hit);
    return mostSevere(hits);
  }

  /** Détecteurs temporels / d'état (spam, flood, doublons, répétitions). */
  #inspectTemporal(message, content, f, hit) {
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    const key = this.#key(message.guild.id, message.author.id);
    const state = this.tracker.get(key) || { spam: [], flood: [], last: null, lastAt: 0, lastCount: 0, seen: now };
    state.seen = now;
    this.tracker.set(key, state);

    // 1) Spam / flood : chaque filtre activé est évalué avec SA fenêtre et SA limite.
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
        hit(filter, reason);
      } else {
        state[name] = times;
      }
    }

    // 2) Doublons / répétitions : même contenu que le message précédent, dans les 30 s.
    if (f.antiDuplicate?.enabled || f.antiRepeat?.enabled) {
      const recent = now - state.lastAt < DUPLICATE_WINDOW_MS;
      if (content.length > 0 && recent && state.last === content) {
        state.lastCount += 1;
        if (f.antiDuplicate?.enabled) hit(f.antiDuplicate, 'Message dupliqué');
        if (f.antiRepeat?.enabled && state.lastCount >= 3) {
          state.lastCount = 0; // réinitialise : pas une sanction par message suivant
          hit(f.antiRepeat, 'Message répété');
        }
      } else {
        state.last = content;
        state.lastCount = 1;
      }
      state.lastAt = now;
    }
  }

  #v(filter, reason) {
    return { action: filter.action || 'delete', duration: filter.duration || null, reason };
  }

  async #applyAction(message, violation) {
    const guild = message.guild;
    const reason = `AutoMod: ${violation.reason}`;
    await message.delete().catch(() => {});

    let timedOut = false;
    let actionText = ACTION_LABELS.delete;
    if (violation.action === 'timeout') {
      const duration = violation.duration || '5m';
      const ms = parseDuration(duration) || 300_000;
      // Via ModerationService : garde-fous, sanction enregistrée (historique, scheduler), DM et log.
      const res = await this.moderation.timeout(guild, message.member, guild.members.me, reason, ms).then((r) => r, () => null);
      timedOut = Boolean(res);
      actionText = timedOut
        ? `${ACTION_LABELS.timeout} (${duration})${res?.id ? ` · sanction #${res.id}` : ''}`
        : `${ACTION_LABELS.delete} · timeout impossible`;
    } else if (violation.action === 'warn') {
      const warned = await this.moderation
        .record(guild, message.author, guild.members.me, { type: 'warn', reason })
        .then((r) => r, () => null);
      // Un avertissement AutoMod compte comme un strike (l'escalade reste déclenchée par /warn).
      let count = null;
      try {
        count = warned ? this.strikes?.add(guild.id, message.author.id, 1)?.count ?? null : null;
      } catch {
        count = null;
      }
      actionText = [
        ACTION_LABELS.warn,
        warned?.id ? `sanction #${warned.id}` : null,
        count != null ? `${count} strike${count > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(' · ');
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
      historyButton(message.author.id),
    );
    await this.logging.send(guild.id, 'automod', embed, components);
  }
}

module.exports = { AutoModService, mostSevere, DUPLICATE_WINDOW_MS };
