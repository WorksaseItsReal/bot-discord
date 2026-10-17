'use strict';

const { PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { SlidingWindow } = require('../utils/rate');
const { card, field, wide, ICONS, userLine, actionButton, buttonRows, ButtonStyle, fitEmbeds } = require('../utils/ui');
const { createLogger } = require('../core/logger');

const logger = createLogger('antiraid');
const DAY_MS = 24 * 60 * 60 * 1000;
/** Délai minimal entre deux alertes « vague d'arrivées » (et lockdowns auto) par serveur. */
const JOIN_ALERT_COOLDOWN_MS = 60_000;
/** Fréquence de purge des fenêtres d'actions destructrices vides (mémoire bornée). */
const WINDOW_PRUNE_INTERVAL_MS = 60_000;
/**
 * Alertes « nouveau membre sanctionné » publiées par minute et par serveur ; au-delà (raid), et
 * pendant une vague, elles sont regroupées dans une carte récapitulative par minute.
 */
const MEMBER_ALERTS_PER_MINUTE = 3;
/** Période des cartes récapitulatives pendant un raid. */
const DIGEST_INTERVAL_MS = 60_000;

/** Plafond de membres sanctionnés par déclenchement de vague (garde-fou contre un faux positif massif). */
const MAX_WAVE_PUNISH = 50;
/** Sanctions possibles pour les nouveaux comptes / bots non autorisés (indépendantes de l'action de vague). */
const NEW_ACCOUNT_ACTIONS = new Set(['kick', 'ban']);

/**
 * Sanction appliquée aux comptes trop récents / bots : `antiraid.newAccountAction`.
 * Non réglée : reprend l'ancienne règle (« ban » si l'action anti-raid est le ban, sinon kick). Pur.
 */
function newAccountAction(cfg) {
  if (NEW_ACCOUNT_ACTIONS.has(cfg?.newAccountAction)) return cfg.newAccountAction;
  return cfg?.action === 'ban' ? 'ban' : 'kick';
}

/**
 * Un ban dont la cible a rejoint le serveur il y a moins de 10 minutes (ou pendant
 * une vague détectée depuis) n'est pas compté comme destructeur : un modérateur qui
 * bannit des raiders ne doit pas être sanctionné par l'AntiRaid.
 */
const RECENT_JOIN_MS = 10 * 60_000;
/** Plafond d'arrivants récents mémorisés par serveur (mémoire bornée pendant un raid). */
const MAX_RECENT_JOINERS = 5_000;
/** Permissions qu'un exécutant « dépouillé » ne doit plus avoir (sinon la sanction a échoué). */
const DANGEROUS_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageGuild,
]);

const DESTRUCTIVE_LABELS = { channelDelete: 'Suppressions de salons', roleDelete: 'Suppressions de rôles', ban: 'Bannissements', kick: 'Expulsions' };
/** Sanctions de membres : expulser ou bannir un arrivant récent (raider) n'est pas compté. */
const MEMBER_SANCTIONS = new Set(['ban', 'kick']);
const EXECUTOR_LABELS = { strip: 'Rôles retirés', ban: 'Banni', none: 'Aucune' };

/** Bouton « Réessayer le lockdown » joint aux alertes dont le lockdown automatique a échoué. */
function retryLockdownButton() {
  return actionButton({ command: 'lockdown', action: 'enable', label: 'Réessayer le lockdown', emoji: '🚨', style: ButtonStyle.Danger });
}

/** Texte du champ « Lockdown » d'une alerte de vague d'arrivées. Pur. */
function lockdownText(lock) {
  if (lock == null) return 'Non configuré';
  if (lock.error) return `${ICONS.warning} **Lockdown non appliqué** : ${String(lock.error).slice(0, 200)}`;
  if (!lock.count) return `${ICONS.warning} **Lockdown non appliqué** : aucun salon verrouillable (permissions ?)`;
  return `🔒 ${lock.count} salon${lock.count > 1 ? 's' : ''} verrouillé${lock.count > 1 ? 's' : ''}`;
}

/** Bouton « Lever le lockdown » joint aux alertes qui ont déclenché un lockdown automatique. */
function liftLockdownButton() {
  return actionButton({ command: 'lockdown', action: 'disable', label: 'Lever le lockdown', emoji: ICONS.unlock, style: ButtonStyle.Success });
}

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
    /**
     * Fenêtre d'arrivées par serveur, avec les identifiants des arrivants : une
     * vague en mode kick/ban sanctionne les membres arrivés dans la fenêtre.
     * @type {Map<string, { windowMs: number, entries: { id: string, at: number }[] }>}
     */
    this.joinWindows = new Map();
    /** @type {Map<string, SlidingWindow>} */
    this.destructiveWindows = new Map();
    /** @type {Map<string, number>} dernier déclenchement d'alerte de vague par serveur */
    this.joinAlertAt = new Map();
    /**
     * Dernier déclenchement par serveur (mémoire, depuis le démarrage) : affiché
     * par le tableau de bord /antiraid.
     * @type {Map<string, { at: number, title: string, description?: string }>}
     */
    this.lastTrigger = new Map();
    this.lastWindowPrune = Date.now();
    /**
     * Arrivants récents par serveur (id → instant d'arrivée, ou de la vague qui les a
     * signalés) : exemption des bans de raiders dans la détection destructrice.
     * @type {Map<string, Map<string, number>>}
     */
    this.recentJoiners = new Map();
    /** @type {Map<string, SlidingWindow>} alertes « nouveau membre » publiées par serveur (minute glissante) */
    this.memberAlertWindows = new Map();
    /**
     * Regroupement des alertes pendant un raid, par serveur : sanctions individuelles et de vague
     * non annoncées, publiées dans une carte récapitulative par minute.
     * @type {Map<string, { guild: object, until: number, timer: NodeJS.Timeout|null, banned: number, kicked: number, failed: number, wave: number, lastError: string|null }>}
     */
    this.digests = new Map();
  }

  /** Arrêt du bot : minuteurs des cartes récapitulatives annulés. */
  stop() {
    for (const d of this.digests.values()) if (d.timer) clearTimeout(d.timer);
    this.digests.clear();
  }

  /** Regroupement en cours pour ce serveur (créé au besoin, pour une minute). */
  #digest(guild, now = Date.now()) {
    let d = this.digests.get(guild.id);
    if (!d) {
      d = { guild, until: now + DIGEST_INTERVAL_MS, timer: null, banned: 0, kicked: 0, failed: 0, wave: 0, lastError: null };
      this.digests.set(guild.id, d);
      this.#scheduleDigest(guild.id, d, DIGEST_INTERVAL_MS);
    }
    d.guild = guild;
    return d;
  }

  /** Ouvre (ou prolonge d'une minute) le regroupement : après une alerte de vague ou d'échec. */
  #quietFor(guild, now = Date.now()) {
    const d = this.#digest(guild, now);
    d.until = Math.max(d.until, now + DIGEST_INTERVAL_MS);
    return d;
  }

  #scheduleDigest(guildId, d, ms) {
    if (d.timer) clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      d.timer = null;
      this.flushDigest(guildId).catch((e) => logger.debug('flushDigest', e?.message));
    }, Math.max(1_000, ms));
    d.timer.unref?.();
  }

  /** Sanctions non annoncées prises au regroupement (compteurs remis à zéro). */
  #takeDigest(guildId) {
    const d = this.digests.get(guildId);
    if (!d) return null;
    const counts = { banned: d.banned, kicked: d.kicked, failed: d.failed, wave: d.wave, lastError: d.lastError };
    d.banned = 0;
    d.kicked = 0;
    d.failed = 0;
    d.wave = 0;
    d.lastError = null;
    return counts.banned + counts.kicked + counts.failed + counts.wave ? counts : null;
  }

  /**
   * Carte récapitulative du regroupement en cours (appelée chaque minute par le minuteur).
   * Rien de neuf : le regroupement prend fin à son échéance.
   * @returns {Promise<boolean>} true si une carte a été publiée
   */
  async flushDigest(guildId, now = Date.now()) {
    const d = this.digests.get(guildId);
    if (!d) return false;
    const counts = this.#takeDigest(guildId);
    if (!counts) {
      if (now < d.until) this.#scheduleDigest(guildId, d, d.until - now);
      else {
        if (d.timer) clearTimeout(d.timer);
        this.digests.delete(guildId);
      }
      return false;
    }
    // Raid toujours en cours : une minute de regroupement de plus.
    d.until = now + DIGEST_INTERVAL_MS;
    this.#scheduleDigest(guildId, d, DIGEST_INTERVAL_MS);
    await this.alert(d.guild, {
      tone: counts.failed ? 'danger' : 'caution',
      icon: ICONS.shield,
      title: 'Raid en cours : récapitulatif',
      description: 'Sanctions automatiques appliquées depuis la dernière alerte (regroupées pour ne pas inonder le salon).',
      fields: digestFields(counts),
      trigger: false,
      fallback: counts.failed > 0,
    });
    return true;
  }

  /** Mémorise un arrivant (ordre d'insertion = du plus ancien au plus récent). */
  #rememberJoin(guildId, userId, at = Date.now()) {
    let m = this.recentJoiners.get(guildId);
    if (!m) {
      m = new Map();
      this.recentJoiners.set(guildId, m);
    }
    m.delete(userId);
    m.set(userId, at);
    // Purge des plus anciens (expirés ou au-delà du plafond).
    for (const [id, t] of m) {
      if (m.size <= MAX_RECENT_JOINERS && at - t < RECENT_JOIN_MS) break;
      m.delete(id);
    }
  }

  /**
   * true si l'utilisateur est un arrivant récent : arrivée connue (`joinedAt`) ou
   * mémorisée depuis moins de 10 minutes (arrivée ou vague d'arrivées).
   */
  isRecentJoiner(guildId, userId, joinedAt = null, now = Date.now()) {
    if (joinedAt && now - joinedAt < RECENT_JOIN_MS) return true;
    const at = userId ? this.recentJoiners.get(guildId)?.get(userId) : null;
    return Boolean(at && now - at < RECENT_JOIN_MS);
  }

  /**
   * Départ d'un membre (guildMemberRemove) : s'il était arrivé il y a moins de 10 min,
   * son arrivée est mémorisée. L'entrée d'audit d'un kick arrive souvent APRÈS le départ
   * (membre sorti du cache) : l'exemption des raiders expulsés reste ainsi fiable, même
   * pour un arrivant que le bot n'a pas vu entrer (redémarrage).
   */
  rememberDeparture(member, now = Date.now()) {
    const guildId = member?.guild?.id;
    const joinedAt = member?.joinedTimestamp;
    if (!guildId || !member.id || !joinedAt || now - joinedAt >= RECENT_JOIN_MS) return false;
    if (!this.config.get(guildId).antiraid?.enabled) return false;
    if (this.recentJoiners.get(guildId)?.has(member.id)) return false;
    this.#rememberJoin(guildId, member.id, joinedAt);
    return true;
  }

  /** Oublie les fenêtres d'actions destructrices devenues vides. */
  pruneWindows(now = Date.now()) {
    this.lastWindowPrune = now;
    for (const [key, w] of this.destructiveWindows) {
      if (w.count(now) === 0) this.destructiveWindows.delete(key);
    }
  }

  /** Marque un ban lancé par le bot (pas de log en double dans guildBanAdd). */
  #markBan(guildId, userId) {
    this.client.services?.moderation?.markBotAction?.('ban', guildId, userId);
  }

  /**
   * Utilisateur ou rôle whitelisté. Un rôle géré (Booster, rôle de bot) n'immunise jamais :
   * il s'obtient sans contrôle du serveur (refusé par /whitelist et le tableau de bord).
   */
  isWhitelisted(guildId, userId, roleIds = []) {
    const wl = this.config.get(guildId).whitelist || { users: [], roles: [] };
    if (wl.users?.includes(userId)) return true;
    const roles = this.client.guilds?.cache?.get?.(guildId)?.roles?.cache;
    return roleIds.some((r) => wl.roles?.includes(r) && !roles?.get?.(r)?.managed);
  }

  /** Enregistre une arrivée et renvoie les arrivants encore dans la fenêtre (le plus ancien d'abord). */
  #recordJoin(guildId, memberId, ms, now = Date.now()) {
    let w = this.joinWindows.get(guildId);
    if (!w || w.windowMs !== ms) {
      w = { windowMs: ms, entries: [] };
      this.joinWindows.set(guildId, w);
    }
    w.entries = w.entries.filter((e) => e.at > now - ms && e.id !== memberId);
    w.entries.push({ id: memberId, at: now });
    return w.entries;
  }

  #window(map, key, ms) {
    let w = map.get(key);
    if (!w || w.windowMs !== ms) {
      w = new SlidingWindow(ms);
      map.set(key, w);
    }
    return w;
  }

  /**
   * @param {import('discord.js').GuildMember} member
   * @returns {Promise<{ punished: boolean }|undefined>} punished : le membre arrivant a été expulsé/banni
   */
  async handleJoin(member) {
    const cfg = this.config.get(member.guild.id).antiraid;
    if (!cfg?.enabled) return;
    this.#rememberJoin(member.guild.id, member.id);
    if (this.isWhitelisted(member.guild.id, member.id, [...(member.roles?.cache?.keys() ?? [])])) return;

    // Vague d'arrivées : TOUT arrivant hors whitelist est compté, avant les filtres individuels.
    // Un raid de comptes récents ou de bots déclenche ainsi la vague (lockdown), que leur
    // sanction individuelle réussisse ou échoue (permission perdue, hiérarchie, 429).
    const guild = member.guild;
    const entries = this.#recordJoin(guild.id, member.id, cfg.joinWindowSeconds * 1000);
    const entry = entries[entries.length - 1];
    const count = entries.length;
    const waveEntries = count >= cfg.joinThreshold ? entries : null;
    if (waveEntries) {
      // Réinitialise la fenêtre : une vague = un déclenchement.
      this.joinWindows.delete(guild.id);
      // Arrivants de la vague : leur bannissement par un modérateur reste exempté 10 min après la détection.
      const waveAt = Date.now();
      for (const e of waveEntries) this.#rememberJoin(guild.id, e.id, waveAt);
    }

    // Anti-bot (bot ajouté hors whitelist) et âge de compte minimal.
    let reason = null;
    if (cfg.antiBot && member.user.bot) reason = 'AntiRaid: bot non autorisé';
    else if (cfg.minAccountAgeDays > 0) {
      const ageDays = (Date.now() - member.user.createdTimestamp) / DAY_MS;
      if (ageDays < cfg.minAccountAgeDays) reason = `AntiRaid: compte trop récent (${ageDays.toFixed(1)}j)`;
    }
    let punished = false;
    if (reason) {
      const res = await this.#punishNewMember(member, reason, cfg);
      punished = res.ok;
      if (res.ok) entry.done = true; // déjà sanctionné : la vague ne le sanctionne pas une 2e fois
      await this.#reportNewMember(member, reason, res, { inWave: Boolean(waveEntries) });
    }
    if (!waveEntries) return { punished };

    // En mode kick/ban, les arrivants de la vague sont sanctionnés à chaque
    // déclenchement (le raid continue pendant le cooldown) ; seules l'alerte et
    // le lockdown sont limités à un par cooldown.
    const joinerIds = waveEntries.filter((e) => !e.done).map((e) => e.id);
    const wave = cfg.action === 'kick' || cfg.action === 'ban' ? await this.#punishWave(guild, joinerIds, cfg.action) : null;
    const now = Date.now();
    const cooling = now - (this.joinAlertAt.get(guild.id) || 0) < JOIN_ALERT_COOLDOWN_MS;
    if (!cooling) {
      this.joinAlertAt.set(guild.id, now);
      const lock = cfg.action === 'lockdown' ? await this.#tryLockdown(guild) : null;
      const locked = lock?.count ?? null;
      // Sanctions individuelles regroupées jusqu'ici, puis regroupement pour la minute qui suit.
      const counts = this.#takeDigest(guild.id);
      this.#quietFor(guild);
      await this.alert(guild, {
        tone: 'danger',
        icon: '🚨',
        title: 'Vague d\'arrivées détectée',
        description: `**${count}** membres ont rejoint le serveur en moins de **${cfg.joinWindowSeconds} s**.`,
        fields: [
          field(ICONS.members, 'Arrivées', `**${count}**`),
          field(ICONS.warning, 'Seuil', `${cfg.joinThreshold} en ${cfg.joinWindowSeconds} s`),
          wave
            ? field(cfg.action === 'ban' ? ICONS.ban : ICONS.kick, cfg.action === 'ban' ? 'Bannis' : 'Expulsés', waveSummary(wave))
            : field(ICONS.lock, 'Lockdown', lockdownText(lock)),
          ...(counts ? digestFields(counts) : []),
        ],
        buttons: lock && !lock.count ? [retryLockdownButton()] : locked ? [liftLockdownButton()] : [],
        fallback: true,
      });
    } else if (wave?.punished.length) {
      this.#digest(guild).wave += wave.punished.length;
      logger.info(`Vague continue sur ${guild.id} : ${wave.punished.length} arrivant(s) sanctionné(s) (${cfg.action}).`);
    }
    return { punished: punished || Boolean(wave?.punished.includes(member.id)) };
  }

  /**
   * Annonce la sanction (ou l'échec) d'un compte récent / bot. Pendant un raid (vague, regroupement
   * en cours ou plus de MEMBER_ALERTS_PER_MINUTE alertes dans la minute), la sanction est comptée
   * dans la carte récapitulative. Un échec est toujours signalé (puis regroupé une minute).
   */
  async #reportNewMember(member, reason, { ok, ban, error }, { inWave = false } = {}) {
    const guild = member.guild;
    const now = Date.now();
    const quiet = this.digests.has(guild.id) && now < this.digests.get(guild.id).until;
    if (inWave || quiet || (ok && this.#window(this.memberAlertWindows, guild.id, 60_000).hit(now) > MEMBER_ALERTS_PER_MINUTE)) {
      const d = this.#digest(guild, now);
      if (!ok) {
        d.failed += 1;
        d.lastError = error ?? d.lastError;
      } else if (ban) d.banned += 1;
      else d.kicked += 1;
      return;
    }
    if (ok) {
      await this.alert(guild, {
        tone: 'caution',
        icon: ICONS.shield,
        title: ban ? 'Nouveau membre banni' : 'Nouveau membre expulsé',
        description: `${member.user} a été ${ban ? 'banni' : 'expulsé'} automatiquement à son arrivée.`,
        thumbnail: member.user.displayAvatarURL?.(),
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user)),
          field(ban ? ICONS.ban : ICONS.kick, 'Sanction', ban ? 'Bannissement' : 'Expulsion'),
          wide(ICONS.reason, 'Motif', reason.replace(/^AntiRaid: /, '')),
        ],
        footer: `ID : ${member.id}`,
      }).catch((e) => logger.debug('alerte nouveau membre', e?.message));
      return;
    }
    // Échec : le membre est toujours là. Alerte immédiate, les suivantes sont regroupées une minute.
    this.#quietFor(guild, now);
    await this.alert(guild, {
      tone: 'danger',
      icon: ICONS.warning,
      title: 'Sanction automatique impossible',
      description: `${member.user} n'a pas pu être ${ban ? 'banni' : 'expulsé'} à son arrivée : **il est toujours sur le serveur**.`,
      thumbnail: member.user.displayAvatarURL?.(),
      fields: [
        field(ICONS.user, 'Membre', userLine(member.user)),
        field(ban ? ICONS.ban : ICONS.kick, 'Sanction prévue', ban ? 'Bannissement' : 'Expulsion'),
        wide(ICONS.reason, 'Motif', reason.replace(/^AntiRaid: /, '')),
        wide(ICONS.error, 'Erreur', String(error ?? 'inconnue').slice(0, 200)),
        wide(ICONS.info, 'Ensuite', 'Vérifiez mes permissions (Expulser / Bannir) et ma place dans la liste des rôles. Les échecs de la minute suivante sont regroupés dans un récapitulatif.'),
      ],
      footer: `ID : ${member.id}`,
      fallback: true,
    }).catch((e) => logger.debug('alerte échec', e?.message));
  }

  /**
   * Sanctionne (kick/ban) les membres arrivés pendant la vague. Whitelist
   * revérifiée (rôles attribués depuis l'arrivée), propriétaire et bot exclus,
   * au plus MAX_WAVE_PUNISH membres par déclenchement.
   * @returns {Promise<{ punished: string[], skipped: number, capped: number }>}
   */
  async #punishWave(guild, ids, action) {
    const reason = 'AntiRaid: vague d\'arrivées';
    const punished = [];
    let skipped = 0;
    const eligible = ids.filter((id) => id !== guild.ownerId && id !== this.client.user?.id);
    const capped = Math.max(0, eligible.length - MAX_WAVE_PUNISH);
    // Les départs provoqués par la sanction ne doivent pas être annoncés par l'accueil.
    this.client.services?.welcome?.silenceWave?.(guild.id);
    for (const id of eligible.slice(-MAX_WAVE_PUNISH)) {
      const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      if (this.isWhitelisted(guild.id, id, member ? [...(member.roles?.cache?.keys() ?? [])] : [])) {
        skipped += 1;
        continue;
      }
      try {
        this.client.services?.welcome?.silence?.(guild.id, id);
        if (action === 'ban') {
          if (member && member.bannable === false) throw new Error('non bannissable');
          this.#markBan(guild.id, id);
          await guild.bans.create(id, { reason });
        } else {
          if (!member) throw new Error('déjà parti');
          if (member.kickable === false) throw new Error('non expulsable');
          await member.kick(reason);
        }
        punished.push(id);
      } catch (e) {
        if (action === 'ban') this.client.services?.moderation?.unmarkBotAction?.('ban', guild.id, id);
        this.client.services?.welcome?.unsilence?.(guild.id, id); // sanction échouée : un vrai départ sera annoncé
        skipped += 1;
        logger.debug(`punishWave ${id}`, e?.message);
      }
    }
    return { punished, skipped, capped };
  }

  /**
   * Action destructrice détectée via audit log (suppression salon/rôle, ban…).
   * Alimentée par l'événement `guildAuditLogEntryCreate` (une entrée = une action,
   * pas de double comptage ni de fetch des audit logs par événement).
   * Aussi appelée par ModerationService après un ban ou un kick fait via le bot
   * (l'audit log l'attribue au bot) avec l'identifiant du modérateur.
   * @param {import('discord.js').Guild} guild
   * @param {string} executorId
   * @param {'channelDelete'|'roleDelete'|'ban'|'kick'} type
   * @param {{ targetId?: string|null, targetJoinedAt?: number|null }} [target] cible du ban/kick (exemption des arrivants récents)
   */
  async handleDestructive(guild, executorId, type, { targetId = null, targetJoinedAt = null } = {}) {
    const cfg = this.config.get(guild.id).antiraid;
    if (!cfg?.enabled || !executorId) return;
    if (executorId === this.client.user?.id) return;
    if (executorId === guild.ownerId) return;
    // Bannir ou expulser un raider (arrivé il y a moins de 10 min) n'est pas une action destructrice.
    if (MEMBER_SANCTIONS.has(type) && targetId) {
      const joinedAt = targetJoinedAt ?? guild.members?.cache?.get?.(targetId)?.joinedTimestamp ?? null;
      if (this.isRecentJoiner(guild.id, targetId, joinedAt)) return;
    }
    const executor = await guild.members.fetch(executorId).catch(() => null);
    if (this.isWhitelisted(guild.id, executorId, executor ? [...executor.roles.cache.keys()] : [])) return;

    const thresholds = {
      channelDelete: cfg.channelDeleteThreshold,
      roleDelete: cfg.roleDeleteThreshold,
      ban: cfg.banThreshold,
      kick: cfg.kickThreshold, // 0 / absent (anciennes configs) : désactivé
    };
    const limit = thresholds[type];
    if (!limit) return;

    const now = Date.now();
    if (now - this.lastWindowPrune > WINDOW_PRUNE_INTERVAL_MS) this.pruneWindows(now);
    const key = `${guild.id}:${executorId}:${type}`;
    const w = this.#window(this.destructiveWindows, key, cfg.destructiveWindowSeconds * 1000);
    const count = w.hit();
    if (count < limit) return;

    w.reset();
    const outcome = await this.#punishExecutor(guild, executorId, cfg, type);
    await this.alert(guild, {
      tone: 'danger',
      icon: '🚨',
      title: 'Activité destructrice anormale',
      description: `<@${executorId}> a effectué **${count}** actions destructrices en **${cfg.destructiveWindowSeconds} s**.`,
      thumbnail: executor?.user?.displayAvatarURL?.(),
      fields: [
        field(ICONS.user, 'Auteur', executor ? userLine(executor.user) : `<@${executorId}>`),
        field('💣', 'Type', `${DESTRUCTIVE_LABELS[type] ?? type} ×**${count}**`),
        field(ICONS.shield, 'Sanction', outcome.ok ? EXECUTOR_LABELS[cfg.punishExecutor] ?? cfg.punishExecutor : 'Aucune (échec ou désactivée)'),
        outcome.note ? wide(ICONS.warning, 'Attention', outcome.note) : null,
      ],
      footer: `ID : ${executorId}`,
      fallback: true,
    });
  }

  /**
   * Expulse / bannit un compte récent ou un bot à son arrivée (l'annonce est faite par l'appelant).
   * @returns {Promise<{ ok: boolean, ban: boolean, error?: string }>}
   */
  async #punishNewMember(member, reason, cfg) {
    const ban = newAccountAction(cfg) === 'ban';
    try {
      this.client.services?.welcome?.silence?.(member.guild.id, member.id);
      if (ban) {
        this.#markBan(member.guild.id, member.id);
        await member.ban({ reason });
      } else await member.kick(reason);
      return { ok: true, ban };
    } catch (e) {
      // Échec : l'événement guildBanAdd ne viendra pas du bot, la marque est retirée.
      if (ban) this.client.services?.moderation?.unmarkBotAction?.('ban', member.guild.id, member.id);
      this.client.services?.welcome?.unsilence?.(member.guild.id, member.id);
      logger.debug('punishNewMember', e?.message);
      return { ok: false, ban, error: e?.message ?? String(e) };
    }
  }

  /**
   * Sanctionne l'auteur d'actions destructrices.
   * « strip » n'est un succès que si au moins un rôle a été retiré ET qu'aucun rôle
   * restant (non modifiable par le bot, ou @everyone) ne confère de permission dangereuse.
   * @returns {Promise<{ ok: boolean, note?: string }>}
   */
  async #punishExecutor(guild, executorId, cfg, type) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return { ok: false };
    const reason = `AntiRaid: ${type} massif`;
    if (cfg.punishExecutor === 'ban') {
      try {
        this.#markBan(guild.id, member.id);
        await member.ban({ reason });
        return { ok: true };
      } catch (e) {
        this.client.services?.moderation?.unmarkBotAction?.('ban', guild.id, member.id);
        logger.debug('punishExecutor', e?.message);
        return { ok: false, note: 'Le bannissement de l\'auteur a échoué (rôle trop élevé ou permission manquante).' };
      }
    }
    if (cfg.punishExecutor === 'strip') {
      const roles = member.roles.cache.filter((r) => r.id !== guild.id);
      const removable = roles.filter((r) => r.editable);
      const remaining = [...roles.filter((r) => !r.editable).values()];
      const everyone = guild.roles?.everyone ?? guild.roles?.cache?.get?.(guild.id);
      if (everyone) remaining.push(everyone);
      if (!removable.size) return { ok: false, note: 'Aucun rôle n\'a pu être retiré (rôles trop élevés ou gérés).' };
      try {
        await member.roles.remove(removable, reason);
      } catch (e) {
        logger.debug('punishExecutor', e?.message);
        return { ok: false, note: 'Le retrait des rôles a échoué (permission ou hiérarchie).' };
      }
      const dangerous = remaining.filter((r) => r.permissions?.any?.(DANGEROUS_PERMISSIONS));
      if (dangerous.length) {
        return {
          ok: false,
          note: `Rôles retirés, mais l'auteur garde des permissions dangereuses via ${dangerous.map((r) => (r.id === guild.id ? '@everyone' : `${r}`)).join(', ')}.`,
        };
      }
      return { ok: true };
    }
    return { ok: false };
  }

  /**
   * Lockdown automatique. Un verrouillage ou une levée en cours (admin) est ATTENDU puis le
   * lockdown est appliqué : un raid ne reste jamais sans lockdown faute de verrou libre.
   * @returns {Promise<{ count: number, error?: string }|null>} null si le service est indisponible
   */
  async #tryLockdown(guild) {
    // Délègue au LockdownService s'il est disponible. Pas de carte « Lockdown activé » :
    // l'alerte AntiRaid (avec le nombre de salons et le bouton de levée) en tient lieu.
    const lockdown = this.client.services?.lockdown;
    if (!lockdown) return null;
    try {
      const n = await lockdown.enable(guild, guild.members.me, 'AntiRaid automatique', { log: false, wait: true });
      // Salons déjà verrouillés (lockdown manuel juste avant) : le lockdown est bien actif.
      return { count: n || (lockdown.status?.(guild) ?? 0) };
    } catch (err) {
      logger.warn(`Lockdown automatique impossible sur ${guild.id} :`, err?.message);
      return { count: 0, error: err?.message ?? String(err) };
    }
  }

  /** Dernier déclenchement connu sur ce serveur (null si aucun depuis le démarrage). */
  lastTriggerOf(guildId) {
    return this.lastTrigger.get(guildId) ?? null;
  }

  /**
   * Publie une alerte (carte danger/caution) dans le salon d'alertes et les logs sécurité.
   * Alerte critique (`fallback`) reçue nulle part (salon supprimé par un nukeur, logs sécurité
   * débranchés ou mis en pause, permissions) : MP au propriétaire, sinon salon système.
   * @param {import('discord.js').Guild} guild
   * @param {string | { tone?: string, icon?: string, title: string, description?: string, fields?: object[],
   *   thumbnail?: string, footer?: string, buttons?: import('discord.js').ButtonBuilder[], trigger?: boolean, fallback?: boolean }} alert
   * @returns {Promise<boolean>} true si l'alerte a été publiée quelque part
   */
  async alert(guild, alert) {
    const a = typeof alert === 'string' ? { description: alert } : alert;
    // Carte récapitulative : pas un nouveau déclenchement (le tableau de bord garde la vague).
    if (a.trigger !== false) this.lastTrigger.set(guild.id, { at: Date.now(), title: a.title ?? 'Alerte AntiRaid', description: a.description });
    const guildCfg = this.config.get(guild.id);
    const alertChannelId = guildCfg.antiraid?.alertChannel;
    const embed = card({
      tone: a.tone ?? 'danger',
      section: 'security',
      icon: a.icon ?? '🚨',
      title: a.title ?? 'Alerte AntiRaid',
      description: a.description,
      thumbnail: a.thumbnail,
      fields: a.fields ?? [],
      footer: a.footer,
    });
    const components = buttonRows(...(a.buttons ?? []));
    let delivered = false;
    // Salon d'alertes dédié uniquement s'il diffère du salon de logs sécurité,
    // sinon l'alerte serait postée deux fois au même endroit.
    if (alertChannelId && alertChannelId !== guildCfg.logChannels?.security) {
      const channel = guild.channels?.cache?.get?.(alertChannelId) ?? (await this.client.channels?.fetch?.(alertChannelId).catch(() => null));
      if (typeof channel?.send === 'function') delivered = await channel.send({ embeds: [embed], components }).then(() => true, () => false);
    }
    const logged = await this.logging.send(guild.id, 'security', embed, components, { event: 'antiraid' });
    delivered = delivered || logged === true;
    if (!delivered && a.fallback) delivered = await this.#fallback(guild, embed);
    return delivered;
  }

  /** Repli d'une alerte critique perdue : MP au propriétaire, sinon salon système (sans boutons). */
  async #fallback(guild, embed) {
    const payload = {
      content: `${ICONS.warning} **Alerte AntiRaid** sur **${escapeMarkdown(String(guild.name ?? guild.id)).slice(0, 100)}** : ni le salon d'alerte ni les logs sécurité n'ont pu la recevoir (salon supprimé, logs coupés ou permissions). Vérifiez /antiraid et /logs.`,
      embeds: fitEmbeds([embed]),
      allowedMentions: { parse: [] },
    };
    const owner = guild.ownerId ? await this.client.users?.fetch?.(guild.ownerId).catch(() => null) : null;
    if (owner && (await owner.send(payload).then(() => true, () => false))) return true;
    const system = guild.systemChannel;
    const me = guild.members?.me;
    if (typeof system?.send !== 'function') return false;
    if (me && typeof system.permissionsFor === 'function' && !system.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return false;
    return system.send(payload).then(() => true, () => false);
  }
}

/** Résumé d'une sanction de vague pour l'alerte. Pur. */
function waveSummary({ punished, skipped, capped }) {
  const parts = [`**${punished.length}**`];
  if (skipped) parts.push(`${skipped} ignoré${skipped > 1 ? 's' : ''}`);
  if (capped) parts.push(`${capped} hors plafond (${MAX_WAVE_PUNISH})`);
  return parts.join(' · ');
}

/** Champs d'une carte récapitulative (sanctions regroupées pendant un raid). Pur. */
function digestFields({ banned = 0, kicked = 0, failed = 0, wave = 0, lastError = null }) {
  const done = [banned && `**${banned}** banni${banned > 1 ? 's' : ''}`, kicked && `**${kicked}** expulsé${kicked > 1 ? 's' : ''}`].filter(Boolean);
  return [
    done.length ? field(ICONS.shield, 'Comptes récents / bots', done.join(' · ')) : null,
    wave ? field(ICONS.members, 'Arrivants de vague', `**${wave}** sanctionné${wave > 1 ? 's' : ''}`) : null,
    failed ? wide(ICONS.warning, 'Sanctions en échec', `**${failed}** échec${failed > 1 ? 's' : ''} : ces membres sont toujours sur le serveur.${lastError ? `\nDernière erreur : ${String(lastError).slice(0, 200)}` : ''}`) : null,
  ].filter(Boolean);
}

module.exports = { AntiRaidService, newAccountAction, waveSummary, digestFields, MAX_WAVE_PUNISH, RECENT_JOIN_MS, DANGEROUS_PERMISSIONS };
