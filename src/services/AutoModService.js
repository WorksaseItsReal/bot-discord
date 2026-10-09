'use strict';

const { createHash } = require('node:crypto');
const { PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const { parseDuration, formatDuration } = require('../utils/time');
const { truncate } = require('../utils/embeds');
const { card, field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle, subtext, code } = require('../utils/ui');
const { logCard, fitList } = require('./LoggingService');
const { historyButton } = require('./ModerationService');
const { createLogger } = require('../core/logger');
const { findBadWord } = require('../utils/automod/words');
const { extractLinks, extractInvites, hostMatches } = require('../utils/automod/links');
const { phishingScore } = require('../utils/automod/phishing');
const { fingerprint } = require('../utils/automod/normalize');
const shape = require('../utils/automod/detectors');
const { nameViolation, nameSkeleton, replacementName, DEFAULT_NAME_TEMPLATE, NAME_CHECKS } = require('../utils/automod/names');
const { fetchAuditEntry } = require('../utils/audit');

const logger = createLogger('automod');

/** Libellés des actions AutoMod. */
const ACTION_LABELS = { delete: 'Message supprimé', warn: 'Avertissement', timeout: 'Timeout', kick: 'Expulsion', quarantine: 'Quarantaine' };

/** Inactivité au-delà de laquelle l'état d'un membre est oublié (mémoire bornée). */
const TRACKER_TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
/** Deux messages identiques espacés de plus de 30 s ne sont pas des doublons. */
const DUPLICATE_WINDOW_MS = 30 * 1000;
/** Au plus un avertissement visible par membre toutes les 10 s (le bot ne spamme pas). */
const NOTICE_COOLDOWN_MS = 10 * 1000;
/** Durée d'affichage de l'avertissement dans le salon. */
const NOTICE_TTL_MS = 8 * 1000;
/** Un doublon court (« ok », « oui ») n'est pas du spam : longueur minimale du doublon. */
const DUPLICATE_MIN_LENGTH = 8;
/** Rafale (compte piraté qui poste partout) : une seule sanction sur cette fenêtre. */
const BURST_WINDOW_MS = 15 * 1000;
/** Au-delà, l'analyse lourde (normalisation, liens) ne porte que sur le début du message. */
const MAX_SCAN_LENGTH = 4000;
/** Quarantaine : messages récents mémorisés par membre (ids seulement), bornés en nombre et en âge. */
const POSTED_MAX = 100;
const POSTED_MAX_MS = 60 * 60 * 1000;
/** Durée maximale d'un timeout Discord. */
const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** Pseudos : nos propres renommages (et ceux d'un modérateur via /pseudo) reconnus pendant ce délai. */
const OWN_RENAME_TTL_MS = 60 * 1000;
/** Pseudos : noms du staff (squelettes) mis en cache par serveur. */
const STAFF_CACHE_TTL_MS = 5 * 60 * 1000;
/** Permissions qui font d'un membre un membre du staff (imitation interdite, exemption). */
const STAFF_PERMISSIONS = [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator];
const isStaff = (member) => STAFF_PERMISSIONS.some((p) => member?.permissions?.has?.(p));

/** Pseudo affiché d'un membre (pseudo du serveur, sinon nom global, sinon nom d'utilisateur). */
function shownName(member) {
  return member?.nickname ?? member?.user?.globalName ?? member?.user?.username ?? '';
}

/** Champ du log de quarantaine listant les rôles retirés (relu à la levée pour les quarantaines antérieures à la table automod_quarantines). */
const QUARANTINE_ROLES_FIELD = 'Rôles retirés';

/** Bouton « Faux positif » d'un log AutoMod (identifiant de l'infraction enregistrée). */
function falsePositiveButton(eventId) {
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  return actionButton({ command: 'automod', action: 'fp', args: [eventId], label: 'Faux positif', emoji: '🙅' });
}

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

/** Sévérité des actions : la violation la plus sévère l'emporte (la quarantaine d'un compte piraté passe avant tout). */
const SEVERITY = { delete: 1, warn: 2, timeout: 3, kick: 4, quarantine: 5 };

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

/** Ce filtre est-il levé pour ce message (salon, salon parent d'un fil ou rôle exempté du filtre) ? Pur. */
function isFilterExempt(fc, message) {
  const channels = fc?.exemptChannels ?? [];
  const roles = fc?.exemptRoles ?? [];
  if (!channels.length && !roles.length) return false;
  const channel = message?.channel;
  if (channel?.id && (channels.includes(channel.id) || (channel.parentId && channels.includes(channel.parentId)))) return true;
  return roles.length > 0 && Boolean(message?.member?.roles?.cache?.some?.((r) => roles.includes(r.id)));
}

/** Filtres effectifs pour un message : ceux dont il est exempté sont désactivés (copie). Pur. */
function effectiveFilters(filters = {}, message = null) {
  let out = filters;
  for (const [key, fc] of Object.entries(filters)) {
    if (!fc?.enabled || !isFilterExempt(fc, message)) continue;
    if (out === filters) out = { ...filters };
    out[key] = { ...fc, enabled: false };
  }
  return out;
}

/** Empreinte d'un lot de pièces jointes (nom + taille + type, ordre indifférent), ou '' sans fichier. Pur. */
function attachmentsFingerprint(attachments) {
  const list = attachments?.values ? [...attachments.values()] : Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  const keys = list.map((a) => `${String(a?.name ?? '').toLowerCase()}|${Number(a?.size) || 0}|${a?.contentType ?? ''}`).sort();
  return createHash('sha1').update(keys.join('\n')).digest('base64url').slice(0, 16);
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
   * @param {import('../database/repositories/AutomodQuarantineRepository').AutomodQuarantineRepository} [deps.quarantines]
   */
  constructor({ config, logging, moderation, strikes, events, quarantines }) {
    this.config = config;
    this.logging = logging;
    this.moderation = moderation;
    this._strikes = strikes ?? null;
    this.events = events ?? null;
    this.quarantines = quarantines ?? null;
    /** @type {Map<string, object>} état temporel par membre */
    this.tracker = new Map();
    /** @type {Map<string, number>} dernier avertissement visible par membre */
    this.notices = new Map();
    /** @type {Map<string, { at: number, severity: number }>} dernière sanction par membre (rafales) */
    this.lastSanction = new Map();
    /** @type {Map<string, { nick: string|null, at: number }>} pseudos posés par le bot ou un modérateur (/pseudo) */
    this.allowedNames = new Map();
    /** @type {Set<string>} renommages en cours (arrivée + mise à jour simultanées) */
    this.renaming = new Set();
    /** @type {Map<string, { at: number, names: Map<string, string> }>} squelettes des noms du staff par serveur */
    this.staffNames = new Map();
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
    for (const [key, state] of this.tracker) {
      // Un membre suivi pour la quarantaine garde ses messages récents un peu plus longtemps.
      const ttl = state.posted?.length ? POSTED_MAX_MS : TRACKER_TTL_MS;
      if (now - state.seen > ttl) this.tracker.delete(key);
    }
    for (const [key, at] of this.notices) if (now - at > NOTICE_COOLDOWN_MS) this.notices.delete(key);
    for (const [key, s] of this.lastSanction) if (now - s.at > BURST_WINDOW_MS) this.lastSanction.delete(key);
    for (const [key, a] of this.allowedNames) if (now - a.at > OWN_RENAME_TTL_MS) this.allowedNames.delete(key);
    for (const [key, s] of this.staffNames) if (now - s.at > STAFF_CACHE_TTL_MS) this.staffNames.delete(key);
  }

  // ---------------------------------------------------------------- pseudos (filtre badNames)

  /**
   * Pseudo posé volontairement (renommage du bot, /pseudo d'un modérateur) : la mise à jour
   * qui suit n'est pas filtrée (pas de boucle, pas de choix du staff écrasé).
   * @param {string|null} nick pseudo posé (null : pseudo retiré)
   */
  allowName(guildId, userId, nick) {
    this.allowedNames.set(this.#key(guildId, userId), { nick: nick ?? null, at: Date.now() });
  }

  /**
   * Nom à vérifier : le préfixe « [AFK] » posé par /afk est ignoré tant que le pseudo est
   * exactement celui que le service d'absences a posé (il n'est pas un « dehoist »).
   */
  #withoutAfkPrefix(member, name) {
    const afk = this.logging?.client?.services?.afk;
    return member.nickname && afk?.nameWithoutPrefix ? afk.nameWithoutPrefix(member, name) : name;
  }

  /** Squelettes des noms du staff (hors `exceptId`), mis en cache 5 minutes. */
  #staffSkeletons(guild, exceptId) {
    const now = Date.now();
    let entry = this.staffNames.get(guild.id);
    if (!entry || now - entry.at > STAFF_CACHE_TTL_MS) {
      const names = new Map();
      for (const m of guild.members?.cache?.values?.() ?? []) {
        if (m.user?.bot || !isStaff(m)) continue;
        for (const n of new Set([m.nickname, m.user?.globalName, m.user?.username].filter(Boolean))) {
          const s = nameSkeleton(n);
          if (s.length >= 3 && !names.has(s)) names.set(s, { name: n, id: m.id });
        }
      }
      entry = { at: now, names };
      this.staffNames.set(guild.id, entry);
    }
    const out = new Map();
    for (const [s, v] of entry.names) if (v.id !== exceptId) out.set(s, v.name);
    return out;
  }

  /** Oublie les noms du staff mis en cache (rôles ou pseudos du staff modifiés). */
  forgetStaffNames(guildId) {
    this.staffNames.delete(guildId);
  }

  /** Membre exempté du filtre des pseudos : staff, rôles ignorés (globaux ou du filtre), bots. */
  isNameExempt(member, cfg, fc) {
    if (!member || member.user?.bot) return true;
    if (member.id === member.guild?.ownerId) return true;
    if (member.permissions?.has?.(PermissionFlagsBits.ModerateMembers) || isStaff(member)) return true;
    const roles = [...(cfg.ignoredRoles ?? []), ...(fc.exemptRoles ?? [])];
    return roles.length > 0 && Boolean(member.roles?.cache?.some?.((r) => roles.includes(r.id)));
  }

  /**
   * Vérifie le pseudo d'un membre (arrivée ou modification) et le renomme selon le modèle
   * en cas d'infraction (dehoist, mots interdits, usurpation, pseudo illisible).
   * Exemptés : « Exclure temporairement des membres » (staff), propriétaire, membres que
   * la hiérarchie ne me permet pas de renommer, rôles ignorés. Nos propres renommages
   * (et ceux d'un modérateur) ne sont jamais refiltrés.
   * @param {import('discord.js').GuildMember} member
   * @param {{ previous?: import('discord.js').GuildMember|null, source?: 'join'|'update' }} [opts]
   * @returns {Promise<{ renamed: boolean, violation: object|null, from?: string, to?: string } | null>}
   */
  async checkMemberName(member, { previous = null, source = 'update' } = {}) {
    const guild = member?.guild;
    if (!guild || member.user?.bot || member.partial) return null;
    const cfg = this.config.get(guild.id).automod;
    const fc = cfg?.filters?.badNames;
    if (!cfg?.enabled || !fc?.enabled) return null;
    const key = this.#key(guild.id, member.id);
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) this.prune(now);
    const name = shownName(member);
    // Pseudo posé par le bot (renommage) ou par un modérateur (/pseudo) : accepté tel quel.
    const allowed = this.allowedNames.get(key);
    if (allowed && now - allowed.at < OWN_RENAME_TTL_MS && allowed.nick === (member.nickname ?? null)) return null;
    // Mise à jour sans changement de nom (rôles, avatar…) : rien à vérifier.
    if (source === 'update' && previous && !previous.partial && shownName(previous) === name) return null;
    if (this.isNameExempt(member, cfg, fc)) return null;
    const violation = nameViolation(this.#withoutAfkPrefix(member, name), fc, { words: cfg.filters?.badWords?.words ?? [], staff: fc.impersonation === false ? null : this.#staffSkeletons(guild, member.id) });
    if (!violation) return null;
    const replacement = replacementName(fc.template || DEFAULT_NAME_TEMPLATE, member.id);
    if (replacement === member.nickname) return null; // déjà renommé
    if (!member.manageable) return { renamed: false, violation, from: name, to: replacement };
    const me = guild.members?.me;
    if (me && !me.permissions?.has?.(PermissionFlagsBits.ManageNicknames)) return { renamed: false, violation, from: name, to: replacement };
    // Pseudo posé par un modérateur depuis Discord : son choix est respecté (journal d'audit).
    if (source === 'update' && previous && !previous.partial && previous.nickname !== member.nickname) {
      const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, member.id);
      const executor = entry?.executorId ?? entry?.executor?.id ?? null;
      const botId = this.logging?.client?.user?.id;
      // Pseudo posé par le bot lui-même (préfixe /afk et son retrait…) : jamais refiltré. L'entrée du
      // bot doit fixer CE pseudo (une entrée plus ancienne du bot ne couvre pas un changement du membre).
      const nickChange = entry?.changes?.find?.((c) => c.key === 'nick');
      if (executor && botId && executor === botId && nickChange && (nickChange.new ?? null) === (member.nickname ?? null)) return null;
      if (executor && executor !== member.id && executor !== botId) {
        const mod = guild.members.cache.get(executor) ?? await guild.members.fetch(executor).catch(() => null);
        if (mod && isStaff(mod)) return null;
      }
    }
    if (this.renaming.has(key)) return null;
    this.renaming.add(key);
    try {
      this.allowName(guild.id, member.id, replacement);
      try {
        await member.setNickname(replacement, truncate(`AutoMod (pseudo) : ${violation.reason}`, 400));
      } catch (err) {
        this.allowedNames.delete(key);
        logger.debug(`Renommage AutoMod de ${member.id} impossible :`, err?.message);
        return { renamed: false, violation, from: name, to: replacement };
      }
    } finally {
      this.renaming.delete(key);
    }
    await this.#logRename(member, violation, name, replacement, source).catch(() => {});
    return { renamed: true, violation, from: name, to: replacement };
  }

  async #logRename(member, violation, from, to, source) {
    const check = NAME_CHECKS[violation.check];
    const embed = logCard({
      category: 'automod',
      tone: 'caution',
      icon: '✏️',
      title: 'Pseudo renommé',
      description: `Le pseudo de ${member} a été remplacé ${source === 'join' ? 'à son arrivée' : 'après une modification'}.`,
      user: member.user,
      fields: [
        field(ICONS.user, 'Membre', userLine(member.user)),
        field(check?.emoji ?? ICONS.warning, 'Règle', violation.reason),
        field(ICONS.search, 'Détail', violation.detail ?? '—'),
        field('⬅️', 'Avant', code(truncate(from || '—', 100))),
        field('➡️', 'Après', code(to)),
      ],
    });
    await this.logging.send(member.guild.id, 'automod', embed, buttonRows(historyButton(member.id)), { event: 'automodNames' });
  }

  /** Oublie la dernière sanction d'un membre (faux positif, quarantaine levée) : la suivante ne sera pas fusionnée. */
  forget(guildId, userId) {
    this.lastSanction.delete(this.#key(guildId, userId));
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
    // Exemptions propres à chaque filtre (ex. liens autorisés dans #médias).
    const f = effectiveFilters(filters, message);
    const hits = [];
    const hit = (key, reason, detail, extra = {}) => hits.push({ ...this.#v(key, f[key]), reason, detail, ...extra });

    const links = text ? extractLinks(text) : [];
    const invites = text ? extractInvites(text) : [];

    if (f.antiInvite?.enabled && invites.length) {
      const bad = blockedInvites(invites, f.antiInvite, message.guild);
      if (bad.length) hit('antiInvite', 'Invitation Discord interdite', bad.map((c) => `discord.gg/${c}`).join(', '));
    }
    const scan = (f.antiPhishing?.enabled || f.antiHacked?.enabled) && links.length
      ? phishingScore(text, { mentionsEveryone: message.mentions?.everyone, allowedDomains: f.antiLink?.allowedDomains })
      : null;
    if (f.antiPhishing?.enabled && scan && scan.score >= (f.antiPhishing.threshold ?? 3)) hit('antiPhishing', 'Lien d\'arnaque probable', scan.reasons.join(' · '));
    // Lien d'arnaque très probable : le compte est sans doute piraté → quarantaine.
    if (f.antiHacked?.enabled && scan && scan.score >= (f.antiHacked.scamScore ?? 5)) {
      hit('antiHacked', 'Compte piraté probable', `lien d'arnaque (score ${scan.score}) · ${scan.reasons.join(' · ')}`);
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
    const related = [...new Map(hits.flatMap((h) => h.related ?? []).map((r) => [r.messageId, r])).values()];
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
    // Empreinte courte en mémoire (au lieu du texte complet, jusqu'à 4000 caractères × 30).
    const digest = fp ? createHash('sha1').update(fp).digest('base64url').slice(0, 16) : '';

    // 2) Doublons / répétitions : même contenu (normalisé) que le précédent, dans les 30 s.
    if (f.antiDuplicate?.enabled || f.antiRepeat?.enabled) {
      const recent = now - state.lastAt < DUPLICATE_WINDOW_MS;
      if (fp.length > 0 && recent && state.last === digest) {
        state.lastCount += 1;
        // « ok » ou « oui » répété : conversation normale, pas un doublon à supprimer.
        if (f.antiDuplicate?.enabled && (fp.length >= DUPLICATE_MIN_LENGTH || fp.includes(' '))) hit('antiDuplicate', 'Message dupliqué');
        if (f.antiRepeat?.enabled && state.lastCount >= 3) {
          state.lastCount = 0;
          hit('antiRepeat', 'Message répété', '3 fois de suite');
        }
      } else {
        state.last = digest;
        state.lastCount = 1;
      }
      state.lastAt = now;
    }

    // 3) Spam multi-salons (et compte piraté) : même message posté partout en peu de temps.
    const cc = f.antiCrossChannel?.enabled ? f.antiCrossChannel : null;
    const hk = f.antiHacked?.enabled ? f.antiHacked : null;
    const channelId = message.channel?.id;
    if ((cc || hk) && channelId) {
      const ccWin = (cc?.windowSeconds || 60) * 1000;
      const hkWin = (hk?.windowSeconds || 60) * 1000;
      const keep = Math.max(cc ? ccWin : 0, hk ? hkWin : 0);
      const eligible = (minLength) => fp.length >= minLength || links.length > 0;
      state.recent = state.recent.filter((r) => now - r.at < keep).slice(-30);
      if ((cc && eligible(cc.minLength ?? 12)) || (hk && eligible(hk.minLength ?? 20))) {
        state.recent.push({ fp: digest, channelId, messageId: message.id, at: now });
      }
      const spread = (win) => {
        const same = state.recent.filter((r) => r.fp === digest && now - r.at < win);
        return { same, channels: new Set(same.map((r) => r.channelId)).size };
      };
      if (hk && eligible(hk.minLength ?? 20)) {
        const { same, channels } = spread(hkWin);
        if (channels >= (hk.channels || 3)) {
          // Oublié après détection (comme le multi-salons) : la copie suivante ne relance pas la quarantaine.
          state.recent = state.recent.filter((r) => r.fp !== digest);
          hit('antiHacked', 'Compte piraté probable', `même message dans ${channels} salons`, { related: same.filter((r) => r.messageId !== message.id) });
        }
      }
      if (cc && eligible(cc.minLength ?? 12)) {
        const { same, channels } = spread(ccWin);
        if (channels >= (cc.channels || 3)) {
          state.recent = state.recent.filter((r) => r.fp !== digest);
          hit('antiCrossChannel', 'Spam multi-salons (compte piraté ?)', `même message dans ${channels} salons`, {
            related: same.filter((r) => r.messageId !== message.id),
          });
        }
      }
    }

    // 4) Compte piraté : même lot de pièces jointes dans plusieurs salons, et suivi des
    //    messages récents (ids) pour pouvoir tout supprimer lors d'une quarantaine.
    if (hk && channelId && message.id) {
      state.posted = (state.posted ?? []).filter((p) => now - p.at < POSTED_MAX_MS).slice(-(POSTED_MAX - 1));
      state.posted.push({ channelId, messageId: message.id, at: now });
      const files = attachmentsFingerprint(message.attachments);
      if (files) {
        const win = (hk.windowSeconds || 60) * 1000;
        state.files = (state.files ?? []).filter((r) => now - r.at < win).slice(-30);
        state.files.push({ fp: files, channelId, messageId: message.id, at: now });
        const same = state.files.filter((r) => r.fp === files);
        const channels = new Set(same.map((r) => r.channelId)).size;
        if (channels >= (hk.channels || 3)) {
          state.files = state.files.filter((r) => r.fp !== files);
          hit('antiHacked', 'Compte piraté probable', `mêmes fichiers dans ${channels} salons`, { related: same.filter((r) => r.messageId !== message.id) });
        }
      }
    }
  }

  #v(key, filter = {}) {
    return { filter: key, action: filter.action || (key === 'antiHacked' ? 'quarantine' : 'delete'), duration: filter.duration || null };
  }

  /** Supprime, sanctionne (avec escalade), prévient le membre et journalise. */
  async #apply(message, violation, cfg) {
    if (violation.action === 'quarantine') return this.#quarantine(message, violation, cfg);
    const guild = message.guild;
    const reason = `AutoMod: ${violation.reason}`;
    this.logging?.suppressMessage?.(message.id); // pas de « Message supprimé » en double dans les logs
    const deleted = await message.delete().then(() => true, () => false);
    // Copies déjà postées ailleurs (spam multi-salons) : supprimées aussi.
    let extraDeleted = 0;
    for (const r of violation.related ?? []) {
      const ch = guild.channels?.cache?.get(r.channelId);
      if (ch?.messages) {
        this.logging?.suppressMessage?.(r.messageId);
        extraDeleted += await ch.messages.delete(r.messageId).then(() => 1, () => 0);
      }
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
      } catch (err) {
        logger.warn('Journal AutoMod indisponible :', err?.message);
      }
    }

    // Rafale : un membre déjà sanctionné il y a quelques secondes (aussi sévèrement) n'est pas
    // re-sanctionné à chaque message (20 timeouts, 20 MP, escalade jusqu'au kick…) :
    // les messages suivants sont seulement supprimés. Synchrone : pas de course entre messages.
    const memberKey = this.#key(guild.id, message.author.id);
    const previous = this.lastSanction.get(memberKey);
    const merged = action !== 'delete' && previous && Date.now() - previous.at < BURST_WINDOW_MS && previous.severity >= severity({ action, duration });
    let eventId = null;
    if (merged) {
      action = 'delete';
      duration = null;
      escalated = null;
    } else {
      if (action !== 'delete') this.lastSanction.set(memberKey, { at: Date.now(), severity: severity({ action, duration }) });
      try {
        // Journalisé avec l'action FINALE (les statistiques montrent les sanctions réelles).
        eventId = this.events?.add({ guildId: guild.id, userId: message.author.id, filter: violation.filter ?? 'autre', action, channelId: message.channel?.id }) ?? null;
      } catch (err) {
        logger.warn('Journal AutoMod indisponible :', err?.message);
      }
    }

    const finalReason = escalated ? `${reason} (récidive : ${escalated.count} infractions)` : reason;
    // Timeout, expulsion et avertissement envoient déjà un MP via la modération (si activé) :
    // pas de second MP de l'AutoMod.
    const moderationDms = action !== 'delete' && this.config.get(guild.id).moderation?.dmOnSanction !== false;
    const notifyCfg = moderationDms && cfg.notify === 'dm' ? { ...cfg, notify: 'none' } : cfg;
    // Une expulsion empêche tout message ensuite : on prévient le membre AVANT (dans le salon).
    if (action === 'kick') await this.#notify(message, violation, { text: ACTION_LABELS.kick }, notifyCfg, deleted).catch(() => {});
    const outcome = await this.#sanction(message, { action, duration, reason: finalReason });
    // Fin du timeout réellement posé (0 = aucun) : « Faux positif » ne lèvera que celui-là.
    if (eventId && action === 'timeout') {
      try {
        this.events.setTimeoutUntil?.(guild.id, eventId, outcome.until ?? 0);
      } catch (err) {
        logger.warn('Journal AutoMod indisponible :', err?.message);
      }
    }
    if (merged) outcome.text = `${ACTION_LABELS.delete} · déjà sanctionné il y a quelques secondes`;
    if (action !== 'kick' && !merged) await this.#notify(message, violation, outcome, notifyCfg, deleted).catch(() => {});

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
      falsePositiveButton(eventId),
    );
    await this.logging.send(guild.id, 'automod', embed, components, { event: 'automod', channelId: message.channel?.id });
  }

  /**
   * Quarantaine d'un compte piraté : timeout long, suppression de ses messages récents
   * dans tous les salons, retrait des rôles (optionnel, rendus à la levée) et log d'alerte
   * avec « Lever la quarantaine » / « Bannir ».
   */
  async #quarantine(message, violation, cfg) {
    const guild = message.guild;
    const fc = cfg.filters?.antiHacked ?? {};
    const reason = `AutoMod: ${violation.reason} (quarantaine)`;
    const memberKey = this.#key(guild.id, message.author.id);
    this.logging?.suppressMessage?.(message.id);
    const deleted = await message.delete().then(() => true, () => false);
    // Messages des X dernières minutes, partout où il a écrit (et copies détectées).
    const purge = await this.purgeRecent(guild, message.author.id, (fc.purgeMinutes ?? 10) * 60_000, {
      extra: violation.related ?? [],
      exclude: [message.id],
    });

    // Rafale : déjà mis en quarantaine il y a quelques secondes → seulement la suppression.
    const previous = this.lastSanction.get(memberKey);
    if (previous && Date.now() - previous.at < BURST_WINDOW_MS && previous.severity >= severity({ action: 'quarantine' })) return;
    this.lastSanction.set(memberKey, { at: Date.now(), severity: severity({ action: 'quarantine' }) });

    const me = guild.members?.me;
    const ms = Math.min(parseDuration(fc.duration || '1d') || 86_400_000, MAX_TIMEOUT_MS);
    const member = message.member;
    const until = member?.communicationDisabledUntilTimestamp ?? 0;
    let timeout;
    let timeoutUntil = null; // fin du timeout posé PAR la quarantaine (null : aucun)
    if (until >= Date.now() + ms) timeout = { ok: true, text: `déjà en timeout jusqu'à <t:${Math.floor(until / 1000)}:f>` };
    else {
      const res = await this.moderation.timeout(guild, member, me, reason, ms).then((r) => r, () => null);
      if (res) timeoutUntil = Date.now() + ms;
      timeout = { ok: Boolean(res), text: res ? `Timeout ${fc.duration || formatDuration(ms)}${res?.id ? ` · sanction #${res.id}` : ''}` : 'Timeout impossible (hiérarchie ou permission)' };
    }

    let eventId = null;
    try {
      eventId = this.events?.add({ guildId: guild.id, userId: message.author.id, filter: 'antiHacked', action: 'quarantine', channelId: message.channel?.id }) ?? null;
    } catch (err) {
      logger.warn('Journal AutoMod indisponible :', err?.message);
    }

    // Rôles retirés (désactivé par défaut) : enregistrés en base AVANT le retrait, pour être
    // rendus à la levée même si le log n'est pas envoyé ou est tronqué.
    const removable = fc.removeRoles && member?.roles?.cache
      ? [...member.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed && r.editable !== false).map((r) => r.id)
      : [];
    let quarantineId = null;
    let stored = !this.quarantines; // sans dépôt (ancien mode) : seul le log garde la trace
    if (this.quarantines) {
      try {
        quarantineId = this.quarantines.add({ guildId: guild.id, userId: message.author.id, roles: removable, timeoutUntil, eventId });
        stored = true;
      } catch (err) {
        logger.warn('Quarantaine non enregistrée :', err?.message);
      }
    }
    let removedRoles = [];
    let rolesNote = null;
    if (removable.length && !stored) rolesNote = '*Rôles conservés : enregistrement impossible (base de données).*';
    else if (removable.length) {
      const ok = await member.roles.remove(removable, reason).then(() => true, () => false);
      if (ok) removedRoles = removable;
      else if (quarantineId) {
        try {
          this.quarantines.setRoles(guild.id, quarantineId, []);
        } catch (err) {
          logger.debug('Quarantaine : rôles non mis à jour :', err?.message);
        }
      }
    }

    const total = purge.count + (deleted ? 1 : 0);
    // Le salon du message déclencheur compte aussi.
    const channelCount = new Set([...purge.channelIds, ...(deleted && message.channel?.id ? [message.channel.id] : [])]).size;
    const embed = logCard({
      category: 'automod',
      tone: 'danger',
      icon: ICONS.lock,
      title: 'Compte piraté · quarantaine',
      description: [
        `${message.author} semble piraté : son compte est placé en **quarantaine**.`,
        deleted ? null : '⚠️ Je n\'ai pas pu supprimer le message : vérifiez ma permission **Gérer les messages**.',
        subtext('Vérifiez avec le membre (autre moyen de contact) avant de lever la quarantaine.'),
      ],
      user: message.author,
      fields: [
        field(ICONS.user, 'Membre', userLine(message.author)),
        field(ICONS.warning, 'Règle', violation.reason),
        field(ICONS.shield, 'Action', timeout.text),
        violation.detail ? wide(ICONS.search, 'Détail', truncate(violation.detail, 1024)) : null,
        field(ICONS.delete, 'Messages supprimés', `**${total}** · ${channelCount} salon(s) · ${fc.purgeMinutes ?? 10} dernières min`),
        fc.removeRoles ? wide(ICONS.role, QUARANTINE_ROLES_FIELD, rolesNote ?? fitList(removedRoles.map((id) => `<@&${id}>`), 1000) ?? '*Aucun*') : null,
        wide(ICONS.channel, 'Message', message.content ? truncate(message.content, 1024) : '*Aucun contenu texte*'),
      ],
    });
    const components = buttonRows(
      actionButton({ command: 'automod', action: 'qlift', args: quarantineId ? [message.author.id, quarantineId] : [message.author.id], label: 'Lever la quarantaine', emoji: ICONS.unlock, style: ButtonStyle.Success }),
      actionButton({ command: 'automod', action: 'qban', args: [message.author.id], label: 'Bannir', emoji: ICONS.ban, style: ButtonStyle.Danger }),
      historyButton(message.author.id),
    );
    await this.logging.send(guild.id, 'automod', embed, components, { event: 'automod', channelId: message.channel?.id });
  }

  /**
   * Supprime les messages récents d'un membre (suivis en mémoire) dans tous les salons.
   * @param {{ extra?: Array<{ channelId: string, messageId: string }>, exclude?: string[] }} [opts]
   * @returns {Promise<{ count: number, channels: number, channelIds: string[] }>}
   */
  async purgeRecent(guild, userId, windowMs, { extra = [], exclude = [] } = {}) {
    const state = this.tracker.get(this.#key(guild.id, userId));
    const now = Date.now();
    const skip = new Set(exclude);
    const byChannel = new Map();
    for (const p of [...(state?.posted ?? []).filter((x) => now - x.at < windowMs), ...extra]) {
      if (!p?.messageId || !p.channelId || skip.has(p.messageId)) continue;
      skip.add(p.messageId);
      if (!byChannel.has(p.channelId)) byChannel.set(p.channelId, []);
      byChannel.get(p.channelId).push(p.messageId);
    }
    let count = 0;
    const channelIds = [];
    for (const [channelId, ids] of byChannel) {
      const ch = guild.channels?.cache?.get(channelId);
      if (!ch?.messages) continue;
      for (const id of ids) this.logging?.suppressMessage?.(id);
      let n = 0;
      if (ids.length > 1 && typeof ch.bulkDelete === 'function') {
        n = await ch.bulkDelete(ids, true).then((r) => r?.size ?? ids.length, () => 0);
      }
      // Suppression unitaire : un seul message, ou suppression groupée refusée.
      if (!n) for (const id of ids) n += await ch.messages.delete(id).then(() => 1, () => 0);
      count += n;
      if (n) channelIds.push(channelId);
    }
    if (state?.posted) state.posted = state.posted.filter((p) => !skip.has(p.messageId));
    return { count, channels: channelIds.length, channelIds };
  }

  /** Applique la sanction. @returns {{ text: string, timedOut: boolean, kicked: boolean, until?: number }} (until : fin du timeout posé) */
  async #sanction(message, { action, duration, reason }) {
    const guild = message.guild;
    const me = guild.members.me;
    if (action === 'timeout') {
      const ms = parseDuration(duration || '5m') || 300_000;
      // Ne jamais raccourcir un timeout plus long déjà en cours (ex. 1 j pour arnaque, puis 5 min pour spam).
      const until = message.member?.communicationDisabledUntilTimestamp ?? 0;
      if (until >= Date.now() + ms) {
        return { timedOut: true, kicked: false, text: `${ACTION_LABELS.delete} · déjà en timeout jusqu'à <t:${Math.floor(until / 1000)}:t>` };
      }
      // Via ModerationService : garde-fous, sanction enregistrée (historique, scheduler), DM et log.
      const res = await this.moderation.timeout(guild, message.member, me, reason, ms).then((r) => r, () => null);
      return {
        timedOut: Boolean(res),
        kicked: false,
        until: res ? Date.now() + ms : 0,
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

module.exports = {
  AutoModService,
  mostSevere,
  escalationStep,
  messageText,
  severity,
  blockedLinks,
  blockedInvites,
  isFilterExempt,
  effectiveFilters,
  attachmentsFingerprint,
  falsePositiveButton,
  ACTION_LABELS,
  BUILTIN_ALLOWED_HOSTS,
  QUARANTINE_ROLES_FIELD,
  DUPLICATE_WINDOW_MS,
  BURST_WINDOW_MS,
  OWN_RENAME_TTL_MS,
  shownName,
  isStaff,
};
