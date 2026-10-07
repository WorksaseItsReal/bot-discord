'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { parseDuration, formatDuration } = require('../utils/time');
const { truncate } = require('../utils/embeds');
const { card, field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle, subtext } = require('../utils/ui');
const { logCard } = require('./LoggingService');
const { historyButton } = require('./ModerationService');
const { createLogger } = require('../core/logger');
const { findBadWord } = require('../utils/automod/words');
const { extractLinks, extractInvites, hostMatches } = require('../utils/automod/links');
const { phishingScore } = require('../utils/automod/phishing');
const { fingerprint } = require('../utils/automod/normalize');
const shape = require('../utils/automod/detectors');

const logger = createLogger('automod');

/** Libellés des actions AutoMod. */
const ACTION_LABELS = { delete: 'Message supprimé', warn: 'Avertissement', timeout: 'Timeout', kick: 'Expulsion' };

/** Inactivité au-delà de laquelle l'état d'un membre est oublié (mémoire bornée). */
const TRACKER_TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
/** Deux messages identiques espacés de plus de 30 s ne sont pas des doublons. */
const DUPLICATE_WINDOW_MS = 30 * 1000;
/** Au plus un avertissement visible par membre toutes les 10 s (le bot ne spamme pas). */
const NOTICE_COOLDOWN_MS = 10 * 1000;
/** Durée d'affichage de l'avertissement dans le salon. */
const NOTICE_TTL_MS = 8 * 1000;
/** Au-delà, l'analyse lourde (normalisation, liens) ne porte que sur le début du message. */
const MAX_SCAN_LENGTH = 4000;

/** Hôtes toujours tolérés par l'anti-liens (GIF du sélecteur, liens de messages Discord…). */
const BUILTIN_ALLOWED_HOSTS = ['discord.gg', 'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gift', 'tenor.com'];

/** Liens non autorisés (hors liste blanche du serveur et hôtes Discord/Tenor). Pur. */
function blockedLinks(links, antiLink = {}) {
  const allowed = [...BUILTIN_ALLOWED_HOSTS, ...(antiLink.allowedDomains ?? [])];
  return links.filter((l) => !hostMatches(l.host, allowed));
}

/** Invitations non autorisées (hors liste blanche et invitation personnalisée du serveur). Pur. */
function blockedInvites(invites, antiInvite = {}, guild = null) {
  const allowed = new Set((antiInvite.allowedCodes ?? []).map((c) => String(c).toLowerCase()));
  const vanity = antiInvite.allowOwnServer !== false ? guild?.vanityURLCode?.toLowerCase() : null;
  return invites.filter((c) => !allowed.has(c) && c !== vanity);
}

/** Sévérité des actions : la violation la plus sévère l'emporte. */
const SEVERITY = { delete: 1, warn: 2, timeout: 3, kick: 4 };

function severity(v) {
  if (!v) return 0;
  const base = (SEVERITY[v.action] ?? 0) * 1e12;
  return base + (v.action === 'timeout' ? parseDuration(v.duration || '5m') || 0 : 0);
}

/** Violation la plus sévère (à égalité, la première détectée). Pur. */
function mostSevere(hits) {
  let best = null;
  for (const h of hits) if (!best || severity(h) > severity(best)) best = h;
  return best;
}

/**
 * Palier de sanction progressive atteint pour `count` infractions récentes. Pur.
 * @returns {{ count:number, action:string, duration?:string|null } | null}
 */
function escalationStep(steps = [], count) {
  let best = null;
  for (const s of steps) if (count >= s.count && (!best || s.count > best.count)) best = s;
  return best;
}

/** Texte analysé : contenu + messages transférés (sinon « Transférer » contourne tout). */
function messageText(message) {
  const parts = [message.content || ''];
  const snapshots = message.messageSnapshots;
  if (snapshots?.size) for (const snap of snapshots.values()) if (snap?.content) parts.push(snap.content);
  return parts.join('\n').slice(0, MAX_SCAN_LENGTH);
}

/**
 * Moteur AutoMod : détecteurs de contenu (résistants aux contournements),
 * détecteurs temporels (spam, flood, doublons, spam multi-salons), restrictions
 * des nouveaux venus, sanctions progressives, avertissement du membre et logs.
 */
class AutoModService {
  /**
   * @param {object} deps
   * @param {import('./ConfigService').ConfigService} deps.config
   * @param {import('./LoggingService').LoggingService} deps.logging
   * @param {import('./ModerationService').ModerationService} deps.moderation
   * @param {import('./StrikeService').StrikeService} [deps.strikes]
   * @param {import('../database/repositories/AutomodEventRepository').AutomodEventRepository} [deps.events]
   */
  constructor({ config, logging, moderation, strikes, events }) {
    this.config = config;
    this.logging = logging;
    this.moderation = moderation;
    this._strikes = strikes ?? null;
    this.events = events ?? null;
    /** @type {Map<string, object>} état temporel par membre */
    this.tracker = new Map();
    /** @type {Map<string, number>} dernier avertissement visible par membre */
    this.notices = new Map();
    this.lastPrune = Date.now();
  }

  /** Service de strikes (injecté, ou résolu via le client du LoggingService). */
  get strikes() {
    return this._strikes ?? this.logging?.client?.services?.strikes ?? null;
  }

  /** Oublie les membres inactifs pour borner la mémoire. */
  prune(now = Date.now()) {
    this.lastPrune = now;
    // Journal des infractions : conservation 30 jours, nettoyé au plus une fois par heure.
    if (this.events && now - (this.lastEventPrune ?? 0) > 3_600_000) {
      this.lastEventPrune = now;
      try {
        this.events.prune(now);
      } catch (err) {
        logger.debug('Nettoyage du journal AutoMod :', err?.message);
      }
    }
    for (const [key, state] of this.tracker) if (now - state.seen > TRACKER_TTL_MS) this.tracker.delete(key);
    for (const [key, at] of this.notices) if (now - at > NOTICE_COOLDOWN_MS) this.notices.delete(key);
  }

  #key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  /** Le membre/salon échappe-t-il à l'AutoMod ? */
  isExempt(message, cfg) {
    const member = message.member;
    if (member?.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return true;
    const channel = message.channel;
    const ignored = cfg.ignoredChannels ?? [];
    // Un fil hérite de l'exemption de son salon parent.
    if (ignored.includes(channel?.id) || (channel?.parentId && ignored.includes(channel.parentId))) return true;
    return Boolean(member?.roles?.cache?.some?.((r) => cfg.ignoredRoles?.includes(r.id)));
  }

  /**
   * Analyse un message et applique la sanction éventuelle.
   * @param {import('discord.js').Message} message
   * @param {{ edited?: boolean }} [opts] message édité : seuls les filtres de contenu s'appliquent.
   */
  async handleMessage(message, { edited = false } = {}) {
    // Bots, webhooks et messages système (dont les alertes de l'AutoMod natif, attribuées
    // au membre fautif) : jamais analysés, sinon on supprimerait la preuve.
    if (!message.guild || message.author?.bot || message.webhookId || message.system) return;
    const cfg = this.config.get(message.guild.id).automod;
    if (!cfg?.enabled) return;
    // Message édité d'un membre hors cache : on le récupère au lieu d'abandonner.
    if (!message.member) {
      const fetched = await message.guild.members?.fetch?.(message.author.id).catch(() => null);
      if (!fetched) return;
      Object.defineProperty(message, 'member', { value: fetched, configurable: true });
    }
    if (this.isExempt(message, cfg)) return;

    const violation = this.inspect(message, cfg.filters, { temporal: !edited, newMembers: cfg.newMembers });
    if (!violation) return;
    await this.#apply(message, violation, cfg);
  }

  /**
   * Violation la plus sévère du message, ou null. Pur vis-à-vis de Discord
   * (n'envoie rien), mais met à jour l'état temporel si `temporal`.
   * @returns {{ filter:string, action:string, duration:string|null, reason:string, detail?:string, related?:object[] } | null}
   */
  inspect(message, filters = {}, { temporal = true, newMembers = null } = {}) {
    const text = messageText(message);
    const f = filters;
    const hits = [];
    const hit = (key, reason, detail, extra = {}) => hits.push({ ...this.#v(key, f[key]), reason, detail, ...extra });

    const links = text ? extractLinks(text) : [];
    const invites = text ? extractInvites(text) : [];

    if (f.antiInvite?.enabled && invites.length) {
      const bad = blockedInvites(invites, f.antiInvite, message.guild);
      if (bad.length) hit('antiInvite', 'Invitation Discord interdite', bad.map((c) => `discord.gg/${c}`).join(', '));
    }
    if (f.antiPhishing?.enabled && links.length) {
      const scan = phishingScore(text, { mentionsEveryone: message.mentions?.everyone, allowedDomains: f.antiLink?.allowedDomains });
      if (scan.score >= (f.antiPhishing.threshold ?? 3)) hit('antiPhishing', 'Lien d\'arnaque probable', scan.reasons.join(' · '));
    }
    if (f.antiLink?.enabled && links.length) {
      const bad = blockedLinks(links, f.antiLink);
      if (bad.length) hit('antiLink', 'Lien interdit', bad.map((l) => l.host).slice(0, 5).join(', '));
    }
    if (f.badWords?.enabled && text) {
      const found = findBadWord(text, f.badWords.words);
      if (found) hit('badWords', 'Mot interdit', `« ${truncate(found, 40)} »`);
    }
    if (f.antiMassMention?.enabled) {
      const n = shape.countMentions(message.mentions ? message : null, text);
      if (n >= (f.antiMassMention.limit ?? 5)) hit('antiMassMention', 'Mentions massives', `${n} mentions`);
    }
    if (f.antiCaps?.enabled && shape.isExcessiveCaps(text, f.antiCaps)) hit('antiCaps', 'Excès de majuscules');
    if (f.antiEmojiSpam?.enabled) {
      const n = shape.countEmojis(text);
      if (n >= (f.antiEmojiSpam.limit ?? 8)) hit('antiEmojiSpam', 'Spam d\'emojis', `${n} emojis`);
    }
    if (f.antiWall?.enabled && shape.isWall(message.content, f.antiWall)) hit('antiWall', 'Message trop long', 'pavé de texte');
    if (f.antiZalgo?.enabled && shape.isZalgo(text)) hit('antiZalgo', 'Texte zalgo', 'caractères empilés');

    if (newMembers?.enabled) this.#inspectNewMember(message, newMembers, blockedLinks(links, f.antiLink), blockedInvites(invites, f.antiInvite, message.guild), hits);
    if (temporal) this.#inspectTemporal(message, text, links, f, hit);
    const best = mostSevere(hits);
    // Les copies d'un spam multi-salons sont supprimées même si un autre filtre l'emporte.
    const related = hits.flatMap((h) => h.related ?? []);
    return best && related.length ? { ...best, related } : best;
  }

  /** Nouveaux venus : liens, invitations et médias bloqués pendant la période de probation. */
  #inspectNewMember(message, rules, links, invites, hits) {
    const now = Date.now();
    const member = message.member;
    const accountAge = now - (message.author?.createdTimestamp ?? now);
    const joinedFor = member?.joinedTimestamp ? now - member.joinedTimestamp : Infinity;
    const isNew = accountAge < (rules.accountAgeDays ?? 7) * 86_400_000 || joinedFor < (rules.joinedMinutes ?? 30) * 60_000;
    if (!isNew) return;
    const media = (message.attachments?.size ?? 0) + (message.stickers?.size ?? 0);
    let what = null;
    if (rules.blockInvites && invites.length) what = 'invitations';
    else if (rules.blockLinks && links.length) what = 'liens';
    else if (rules.blockMedia && media) what = 'fichiers et stickers';
    if (what) hits.push({ filter: 'newMembers', action: 'delete', duration: null, reason: 'Nouveau membre', detail: `${what} non autorisés pour les nouveaux venus` });
  }

  /** Détecteurs temporels / d'état (spam, flood, doublons, répétitions, multi-salons). */
  #inspectTemporal(message, text, links, f, hit) {
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    const key = this.#key(message.guild.id, message.author.id);
    const state = this.tracker.get(key) || { spam: [], flood: [], last: null, lastAt: 0, lastCount: 0, recent: [], seen: now };
    state.seen = now;
    this.tracker.set(key, state);

    // 1) Spam / flood : chaque filtre activé avec SA fenêtre et SA limite.
    for (const [name, filterKey, reason] of [
      ['spam', 'antiSpam', 'Spam détecté'],
      ['flood', 'antiFlood', 'Flood détecté'],
    ]) {
      const filter = f[filterKey];
      if (!filter?.enabled) continue;
      const win = (filter.windowSeconds || 5) * 1000;
      const times = state[name].filter((t) => now - t < win);
      times.push(now);
      if (times.length >= (filter.limit || 5)) {
        state[name] = []; // réinitialise après violation
        hit(filterKey, reason, `${times.length} messages en ${filter.windowSeconds || 5} s`);
      } else {
        state[name] = times;
      }
    }

    const fp = fingerprint(text);

    // 2) Doublons / répétitions : même contenu (normalisé) que le précédent, dans les 30 s.
    if (f.antiDuplicate?.enabled || f.antiRepeat?.enabled) {
      const recent = now - state.lastAt < DUPLICATE_WINDOW_MS;
      if (fp.length > 0 && recent && state.last === fp) {
        state.lastCount += 1;
        if (f.antiDuplicate?.enabled) hit('antiDuplicate', 'Message dupliqué');
        if (f.antiRepeat?.enabled && state.lastCount >= 3) {
          state.lastCount = 0;
          hit('antiRepeat', 'Message répété', '3 fois de suite');
        }
      } else {
        state.last = fp;
        state.lastCount = 1;
      }
      state.lastAt = now;
    }

    // 3) Spam multi-salons : signe typique d'un compte piraté (même message partout).
    const cc = f.antiCrossChannel;
    if (cc?.enabled && message.channel?.id && (fp.length >= (cc.minLength ?? 12) || links.length)) {
      const win = (cc.windowSeconds || 60) * 1000;
      state.recent = state.recent.filter((r) => now - r.at < win).slice(-30);
      state.recent.push({ fp, channelId: message.channel.id, messageId: message.id, at: now });
      const same = state.recent.filter((r) => r.fp === fp);
      const channels = new Set(same.map((r) => r.channelId));
      if (channels.size >= (cc.channels || 3)) {
        state.recent = state.recent.filter((r) => r.fp !== fp);
        hit('antiCrossChannel', 'Spam multi-salons (compte piraté ?)', `même message dans ${channels.size} salons`, {
          related: same.filter((r) => r.messageId !== message.id),
        });
      }
    }
  }

  #v(key, filter = {}) {
    return { filter: key, action: filter.action || 'delete', duration: filter.duration || null };
  }

  /** Supprime, sanctionne (avec escalade), prévient le membre et journalise. */
  async #apply(message, violation, cfg) {
    const guild = message.guild;
    const reason = `AutoMod: ${violation.reason}`;
    const deleted = await message.delete().then(() => true, () => false);
    // Copies déjà postées ailleurs (spam multi-salons) : supprimées aussi.
    let extraDeleted = 0;
    for (const r of violation.related ?? []) {
      const ch = guild.channels?.cache?.get(r.channelId);
      if (ch?.messages) extraDeleted += await ch.messages.delete(r.messageId).then(() => 1, () => 0);
    }

    // Sanctions progressives : la sanction monte avec le nombre d'infractions récentes.
    let action = violation.action;
    let duration = violation.duration;
    let escalated = null;
    if (this.events) {
      try {
        const esc = cfg.escalation;
        if (esc?.enabled) {
          const since = Date.now() - (esc.windowMinutes ?? 30) * 60_000;
          const count = this.events.countRecent(guild.id, message.author.id, since) + 1; // + l'infraction en cours
          const step = escalationStep(esc.steps, count);
          if (step && severity(step) > severity({ action, duration })) {
            escalated = { count, step };
            action = step.action;
            duration = step.duration ?? null;
          }
        }
        // Journalisé avec l'action FINALE (les statistiques montrent les sanctions réelles).
        this.events.add({ guildId: guild.id, userId: message.author.id, filter: violation.filter ?? 'autre', action, channelId: message.channel?.id });
      } catch (err) {
        logger.warn('Journal AutoMod indisponible :', err?.message);
      }
    }

    const finalReason = escalated ? `${reason} (récidive : ${escalated.count} infractions)` : reason;
    // Une expulsion empêche tout MP ensuite : on prévient le membre AVANT.
    if (action === 'kick') await this.#notify(message, violation, { text: ACTION_LABELS.kick }, cfg, deleted).catch(() => {});
    const outcome = await this.#sanction(message, { action, duration, reason: finalReason });
    if (action !== 'kick') await this.#notify(message, violation, outcome, cfg, deleted).catch(() => {});

    const details = [violation.detail, escalated ? `Sanction progressive : ${escalated.count} infractions récentes` : null].filter(Boolean);
    const embed = logCard({
      category: 'automod',
      tone: outcome.timedOut || outcome.kicked ? 'danger' : 'caution',
      icon: ICONS.automod,
      title: 'Message filtré',
      description: `Un message de ${message.author} a été bloqué dans ${message.channel}.${deleted ? '' : '\n⚠️ Je n\'ai pas pu le supprimer : vérifiez ma permission **Gérer les messages**.'}`,
      user: message.author,
      fields: [
        field(ICONS.user, 'Membre', userLine(message.author)),
        field(ICONS.warning, 'Règle', violation.reason),
        field(ICONS.shield, 'Action', [deleted ? null : 'Suppression impossible', outcome.text].filter(Boolean).join(' · ')),
        details.length ? wide(ICONS.search, 'Détail', truncate(details.join('\n'), 1024)) : null,
        extraDeleted ? field(ICONS.delete, 'Copies supprimées', `${extraDeleted}`) : null,
        wide(ICONS.channel, 'Message', message.content ? truncate(message.content, 1024) : '*Aucun contenu texte*'),
      ],
    });
    const components = buttonRows(
      outcome.timedOut
        ? actionButton({ command: 'untimeout', action: 'revoke', args: [message.author.id], label: 'Retirer le timeout', emoji: ICONS.unmute, style: ButtonStyle.Success })
        : null,
      historyButton(message.author.id),
    );
    await this.logging.send(guild.id, 'automod', embed, components);
  }

  /** Applique la sanction. @returns {{ text: string, timedOut: boolean, kicked: boolean }} */
  async #sanction(message, { action, duration, reason }) {
    const guild = message.guild;
    const me = guild.members.me;
    if (action === 'timeout') {
      const ms = parseDuration(duration || '5m') || 300_000;
      // Via ModerationService : garde-fous, sanction enregistrée (historique, scheduler), DM et log.
      const res = await this.moderation.timeout(guild, message.member, me, reason, ms).then((r) => r, () => null);
      return {
        timedOut: Boolean(res),
        kicked: false,
        text: res ? `${ACTION_LABELS.timeout} (${duration || formatDuration(ms)})${res?.id ? ` · sanction #${res.id}` : ''}` : `${ACTION_LABELS.delete} · timeout impossible`,
      };
    }
    if (action === 'kick') {
      const res = await this.moderation.kick?.(guild, message.member, me, reason).then((r) => r, () => null);
      return { timedOut: false, kicked: Boolean(res), text: res ? `${ACTION_LABELS.kick}${res?.id ? ` · sanction #${res.id}` : ''}` : `${ACTION_LABELS.delete} · expulsion impossible` };
    }
    if (action === 'warn') {
      const warned = await this.moderation.record(guild, message.author, me, { type: 'warn', reason }).then((r) => r, () => null);
      // Un avertissement AutoMod compte comme un strike (l'escalade des strikes reste déclenchée par /warn).
      let count = null;
      try {
        count = warned ? this.strikes?.add(guild.id, message.author.id, 1)?.count ?? null : null;
      } catch {
        count = null;
      }
      const text = [ACTION_LABELS.warn, warned?.id ? `sanction #${warned.id}` : null, count != null ? `${count} strike${count > 1 ? 's' : ''}` : null]
        .filter(Boolean)
        .join(' · ');
      return { timedOut: false, kicked: false, text };
    }
    return { timedOut: false, kicked: false, text: ACTION_LABELS.delete };
  }

  /** Prévient le membre (salon, éphémère et auto-supprimé, ou MP), au plus toutes les 10 s. */
  async #notify(message, violation, outcome, cfg, deleted = true) {
    const mode = cfg.notify ?? 'none';
    if (mode === 'none') return;
    const key = this.#key(message.guild.id, message.author.id);
    const now = Date.now();
    if (now - (this.notices.get(key) ?? 0) < NOTICE_COOLDOWN_MS) return;
    this.notices.set(key, now);
    const embed = card({
      tone: 'warning',
      icon: ICONS.automod,
      title: deleted ? 'Message retiré par l\'AutoMod' : 'Message signalé par l\'AutoMod',
      description: [`${ICONS.warning} **${violation.reason}**`, outcome.text !== ACTION_LABELS.delete ? `Sanction : ${outcome.text}` : null, subtext('Merci de respecter les règles du serveur.')],
      timestamp: false,
    });
    if (mode === 'dm') {
      embed.setAuthor({ name: `🏠  ${message.guild.name}` });
      await message.author.send({ embeds: [embed] });
      return;
    }
    if (typeof message.channel?.send !== 'function') return;
    const sent = await message.channel.send({ content: `${message.author}`, embeds: [embed], allowedMentions: { users: [message.author.id] } });
    setTimeout(() => sent.delete().catch(() => {}), NOTICE_TTL_MS).unref?.();
  }
}

module.exports = { AutoModService, mostSevere, escalationStep, messageText, severity, blockedLinks, blockedInvites, DUPLICATE_WINDOW_MS };
