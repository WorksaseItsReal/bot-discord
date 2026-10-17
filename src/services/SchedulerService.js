'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('../core/logger');
const { truncate } = require('../utils/embeds');
const { neutralizeMaskedLinks } = require('../utils/safeText');
const { discordTimestamp } = require('../utils/time');
const { card, field, ICONS } = require('../utils/ui');
const { sanctionCard } = require('./ModerationService');

const logger = createLogger('scheduler');

const DAY_MS = 86_400_000;
/** Un rappel non délivrable (erreurs transitoires) est abandonné 24 h après son échéance. */
const REMINDER_MAX_LATE_MS = DAY_MS;
/** Données d'un serveur quitté supprimées après 30 jours d'absence. */
const LEFT_GUILD_RETENTION_MS = 30 * DAY_MS;
/** Fréquence de la purge des serveurs quittés. */
const PURGE_INTERVAL_MS = DAY_MS;
/**
 * Budget de temps d'une étape « service » (rôles temporaires, annonces, anniversaires) par
 * tick : au-delà, l'étape s'interrompt entre deux lignes et reprend au tick suivant, pour
 * ne pas retarder les autres étapes (débans, mutes, rappels…) ni les ticks suivants.
 */
const SERVICE_STAGE_BUDGET_MS = 15_000;
/** Levée échue en échec (débans, fins de mute) : nouvel essai après 1 min, doublé à chaque échec, 1 h au plus. */
const EXPIRY_RETRY_BASE_MS = 60_000;
const EXPIRY_RETRY_MAX_MS = 3_600_000;
/** Levée toujours impossible plus de 24 h après l'échéance : le staff est prévenu (une fois). */
const EXPIRY_ALERT_LATE_MS = DAY_MS;
/** Appels Discord de levée par étape (débans, fins de mute) et par passage : la suite au passage suivant. */
const MAX_EXPIRY_CALLS_PER_PASS = 25;
/** Giveaways terminés en parallèle, HORS du passage du scheduler. */
const MAX_GIVEAWAY_ENDINGS = 3;

/** Salon définitivement inutilisable (supprimé, accès ou permission retirés). */
const PERMANENT_CHANNEL_CODES = new Set([10003, 10004, 50001, 50008, 50013, 50024, 50083]);
/** Utilisateur définitivement injoignable en MP. */
const PERMANENT_USER_CODES = new Set([10013, 50007, 50278]);

/**
 * Boucle périodique robuste qui réconcilie l'état persistant avec la réalité :
 *  - expiration des bans temporaires et des mutes (levée automatique) ;
 *  - déclenchement des rappels arrivés à échéance ;
 *  - fin des giveaways, sauvegardes automatiques, purge des serveurs quittés ;
 *  - rôles temporaires, annonces programmées, anniversaires et levées automatiques
 *    (lock, mode lent, lockdown) : services dédiés ;
 *  - flux RSS / YouTube (FeedService) ; rattrapage du rôle vocal (AutomationService) ;
 *  - purge quotidienne des statistiques expirées (ActivityService).
 * Tout survit au redémarrage car l'état vit en base. Chaque étape est isolée :
 * une erreur dans l'une n'empêche pas les suivantes.
 */
class SchedulerService {
  /**
   * @param {object} deps
   * @param {import('discord.js').Client} deps.client
   * @param {import('../database/repositories/SanctionRepository').SanctionRepository} deps.sanctions
   * @param {import('../database/repositories/ReminderRepository').ReminderRepository} deps.reminders
   * @param {number} [deps.intervalMs]
   */
  constructor({ client, sanctions, reminders, intervalMs = 30_000, stageBudgetMs = SERVICE_STAGE_BUDGET_MS }) {
    this.client = client;
    this.sanctions = sanctions;
    this.reminders = reminders;
    this.intervalMs = intervalMs;
    this.stageBudgetMs = stageBudgetMs;
    this.timer = null;
    this.running = false;
    this.stopping = false;
    /** @type {Promise<void> | null} tick en cours (attendu par stop()) */
    this.currentTick = null;
    this.lastPurgeAt = 0;
    /** Rattrapage des serveurs quittés hors ligne fait (une fois par démarrage). */
    this.leftGuildsReconciled = false;
    /** Levées échues en échec : id de sanction → { at: prochain essai, attempts }. */
    this.expiryRetries = new Map();
    /** Sanctions dont l'échec prolongé (> 24 h) a déjà été signalé au staff. */
    this.expiryAlerted = new Set();
    /** Fins de giveaways en cours (hors passage) : id → promesse. */
    this.giveawayEndings = new Map();
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.tick().catch((e) => logger.error('tick', e)), this.intervalMs);
    this.timer.unref?.();
    logger.info(`Scheduler démarré (intervalle ${this.intervalMs}ms)`);
  }

  /** Arrête la boucle et attend la fin du tick et des tirages en cours (avant fermeture de la base). */
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.currentTick) await this.currentTick.catch(() => {});
    if (this.giveawayEndings.size) await Promise.allSettled([...this.giveawayEndings.values()]);
  }

  tick() {
    // Garde anti-réentrance : un tick lent (rate limit, API lente) ne doit jamais
    // se chevaucher avec le suivant, sinon les mêmes échéances (bans, rappels,
    // giveaways) seraient traitées deux fois.
    if (this.running) return this.currentTick ?? Promise.resolve();
    this.running = true;
    this.currentTick = this.#runStages().finally(() => {
      this.running = false;
      this.currentTick = null;
    });
    return this.currentTick;
  }

  /** Interruption d'une étape « service » : arrêt du bot, ou budget de temps épuisé. */
  #budget() {
    const deadline = Date.now() + this.stageBudgetMs;
    return () => this.stopping || Date.now() > deadline;
  }

  async #runStages() {
    const stages = [
      ['tempbans', () => this.#processExpiredTempbans()],
      ['mutes', () => this.#processExpiredMutes()],
      ['reminders', () => this.#processDueReminders()],
      ['giveaways', () => this.#processDueGiveaways()],
      ['autobackup', () => this.#processAutobackup()],
      ['purge', () => this.#processLeftGuildPurge()],
      ['temproles', () => this.client.services?.tempRoles?.processDue({ isStopping: this.#budget() })],
      ['announcements', () => this.client.services?.announcements?.processDue({ isStopping: this.#budget() })],
      ['birthdays', () => this.client.services?.birthdays?.processDue({ isStopping: this.#budget() })],
      ['timedlocks', () => this.client.services?.timedLocks?.processDue({ isStopping: this.#budget() })],
      ['activity', () => this.client.services?.activity?.processDue({ isStopping: this.#budget() })],
      ['feeds', () => this.client.services?.feeds?.processDue({ isStopping: this.#budget() })],
      ['voiceroles', () => this.client.services?.automations?.processDue({ isStopping: this.#budget() })],
      // Sécurité : chaque service qui l'expose (Secur : purge des incidents et des accès ; liste noire…).
      ['security', () => this.#processSecurityDue()],
    ];
    for (const [name, run] of stages) {
      if (this.stopping) return;
      try {
        await run();
      } catch (e) {
        logger.error(`Étape « ${name} » du scheduler en échec :`, e);
      }
    }
  }

  /**
   * Étape `security` : processSecurityDue({ isStopping }) de chaque service qui l'expose (Secur,
   * puis la liste noire), chacun isolé et sous son propre budget de temps.
   */
  async #processSecurityDue() {
    for (const [name, service] of Object.entries(this.client.services ?? {})) {
      if (this.stopping) return;
      if (typeof service?.processSecurityDue !== 'function') continue;
      try {
        await service.processSecurityDue({ isStopping: this.#budget() });
      } catch (e) {
        logger.error(`Étape « security » (${name}) en échec :`, e);
      }
    }
  }

  /**
   * Fins de giveaways lancées HORS du passage : un tirage lent (une requête par participant
   * parti, limite de débit) ne retarde plus les débans, fins de mute, rappels… ni les ticks
   * suivants. Au plus MAX_GIVEAWAY_ENDINGS à la fois ; un giveaway en cours de tirage n'est
   * jamais relancé. stop() attend les tirages en cours.
   */
  async #processDueGiveaways() {
    const giveaways = this.client.services?.giveaways;
    const repo = this.client.repositories?.giveaways;
    if (!giveaways || !repo) return;
    for (const g of repo.findDue()) {
      if (this.stopping || this.giveawayEndings.size >= MAX_GIVEAWAY_ENDINGS) return;
      if (this.giveawayEndings.has(g.id)) continue;
      const run = Promise.resolve()
        .then(() => giveaways.end(g.id))
        // Annonce impossible (salon supprimé, permission retirée) : visible dans les logs,
        // le staff peut la retenter avec /giveaway end.
        .catch((e) => logger.warn(`Fin du giveaway #${g.id} (serveur ${g.guild_id}) :`, e?.message ?? e))
        .finally(() => this.giveawayEndings.delete(g.id));
      this.giveawayEndings.set(g.id, run);
    }
  }

  async #processAutobackup() {
    const backup = this.client.services?.backup;
    const config = this.client.services?.config;
    if (!backup || !config) return;
    for (const guild of this.client.guilds.cache.values()) {
      // Serveur indisponible (panne Discord) : cache vide ou partiel, la sauvegarde
      // serait incomplète et évincerait une bonne sauvegarde du quota.
      if (!guild.available) continue;
      const cfg = config.get(guild.id).autobackup;
      if (!cfg?.enabled) continue;
      const dueAt = (cfg.lastRun || 0) + (cfg.intervalHours || 24) * 3_600_000;
      if (Date.now() < dueAt) continue;
      try {
        // Créateur null : la sauvegarde apparaît comme automatique.
        backup.create(guild, null, 'Auto-backup');
        config.update(guild.id, { autobackup: { lastRun: Date.now() } });
        logger.info(`Auto-backup créé pour ${guild.id}`);
      } catch (e) {
        logger.warn(`Auto-backup échoué pour ${guild.id} :`, e?.message);
      }
    }
  }

  /**
   * Purge quotidienne des serveurs quittés depuis plus de 30 jours : TOUTES leurs données
   * (tables à guild_id et tables filles, en une transaction : GuildPurgeRepository) et les
   * caches mémoire des services. Si le bot y est de nouveau, la date de départ est effacée.
   * Au premier passage après le démarrage, rattrapage des serveurs quittés hors ligne.
   */
  async #processLeftGuildPurge(now = Date.now()) {
    const repo = this.client.repositories?.guildConfig;
    const config = this.client.services?.config;
    if (!repo?.findLeftBefore || !config) return;
    // Cache incomplet tant que le client n'est pas prêt : on ne purge jamais à l'aveugle.
    if (!this.client.isReady?.()) return;
    if (!this.leftGuildsReconciled) this.leftGuildsReconciled = await this.#reconcileLeftGuilds(now);
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    const isStopping = this.#budget();
    for (const guildId of repo.findLeftBefore(now - LEFT_GUILD_RETENTION_MS)) {
      if (isStopping()) {
        // Budget épuisé : la suite au prochain tick (pas dans 24 h).
        if (!this.stopping) this.lastPurgeAt = 0;
        return;
      }
      if (this.client.guilds.cache.has(guildId)) {
        config.clearLeft(guildId);
        continue;
      }
      try {
        this.#purgeGuild(guildId);
      } catch (e) {
        logger.warn(`Purge du serveur quitté ${guildId} en échec (nouvel essai demain) :`, e?.message ?? e);
      }
      await new Promise((resolve) => setImmediate(resolve)); // une purge par tour de boucle
    }
  }

  /** Supprime toutes les données d'un serveur quitté, puis les caches mémoire des services. */
  #purgeGuild(guildId) {
    const purge = this.client.repositories?.guildPurge;
    const counts = purge?.purgeGuild ? purge.purgeGuild(guildId) : {};
    this.client.services.config.forget(guildId);
    for (const service of Object.values(this.client.services ?? {})) {
      if (typeof service?.forgetGuild !== 'function') continue;
      try {
        service.forgetGuild(guildId);
      } catch (e) {
        logger.debug(`Cache du serveur purgé ${guildId} :`, e?.message);
      }
    }
    const rows = Object.values(counts).reduce((n, c) => n + c, 0);
    logger.info(`Données du serveur ${guildId} purgées (quitté depuis plus de 30 jours) : ${rows} ligne(s) dans ${Object.keys(counts).length} table(s), configuration comprise.`);
  }

  /**
   * Rattrapage au démarrage : un serveur quitté pendant que le bot était hors ligne n'émet
   * jamais guildDelete. Tout serveur présent en base mais absent du cache est daté (purge dans
   * 30 jours) ; un serveur daté mais de nouveau présent (retour hors ligne) ne l'est plus.
   * Seulement si AUCUN serveur n'est indisponible (panne Discord : liste incertaine).
   * @returns {Promise<boolean>} true une fois fait (sinon nouvel essai au prochain tick)
   */
  async #reconcileLeftGuilds(now) {
    const repo = this.client.repositories.guildConfig;
    const config = this.client.services.config;
    const cache = this.client.guilds.cache;
    for (const guild of cache.values()) if (guild?.available === false) return false;
    const dated = new Set(repo.findLeftBefore(Number.MAX_SAFE_INTEGER));
    for (const guildId of dated) if (cache.has(guildId)) config.clearLeft(guildId);
    const purge = this.client.repositories?.guildPurge;
    if (!purge?.guildTables) return true;
    const missing = new Set();
    for (const table of purge.guildTables()) {
      if (this.stopping) return false;
      for (const guildId of purge.guildIds(table)) if (!cache.has(guildId) && !dated.has(guildId)) missing.add(guildId);
      await new Promise((resolve) => setImmediate(resolve)); // une table par tour de boucle
    }
    for (const guildId of missing) config.markLeft(guildId, now);
    if (missing.size) logger.info(`${missing.size} serveur(s) quitté(s) pendant l'arrêt du bot : données purgées dans 30 jours s'il n'y revient pas.`);
    return true;
  }

  /**
   * Serveur d'une sanction échue, ou null (réessai plus tard). Serveur absent (bot retiré,
   * peut-être temporairement) ou indisponible : la sanction reste ACTIVE — levée au retour du
   * bot, supprimée par la purge des serveurs quittés s'il ne revient pas sous 30 jours. (La
   * clore ici laissait le membre banni ou muet à vie après une réinvitation.)
   */
  #resolveGuild(s) {
    const guild = this.client.guilds.cache.get(s.guild_id);
    if (!guild || !guild.available) return null;
    return guild;
  }

  /** Levée en attente d'un nouvel essai (backoff) ? */
  #retryPending(s) {
    return (this.expiryRetries.get(s.id)?.at ?? 0) > Date.now();
  }

  /** Oublie l'état d'échec des sanctions qui ne sont plus échues (levées, closes, supprimées). */
  #forgetSettledRetries(due) {
    const ids = new Set(due.map((s) => s.id));
    for (const id of this.expiryRetries.keys()) if (!ids.has(id)) this.expiryRetries.delete(id);
    for (const id of this.expiryAlerted) if (!ids.has(id)) this.expiryAlerted.delete(id);
  }

  #expirySucceeded(s) {
    this.expiryRetries.delete(s.id);
    this.expiryAlerted.delete(s.id);
  }

  /** Vérification faite une fois par serveur et par passage (cache `memo`). */
  static #memo(memo, key, check) {
    if (!memo.has(key)) memo.set(key, check());
    return memo.get(key);
  }

  /** Le bot peut-il débannir ? (membre du bot inconnu : Discord tranchera) */
  #canUnban(guild) {
    const me = guild.members?.me;
    return !me?.permissions || me.permissions.has(PermissionFlagsBits.BanMembers);
  }

  /** Le bot peut-il retirer le rôle Muted (permission et hiérarchie) ? */
  #canUnmute(guild, roleId) {
    const me = guild.members?.me;
    if (!me?.permissions) return true;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
    const role = guild.roles?.cache?.get(roleId);
    return !role || role.position < (me.roles?.highest?.position ?? Infinity);
  }

  /**
   * Levée échue en échec : nouvel essai différé (1 min, doublé, 1 h au plus) au lieu de toutes
   * les 30 s ; plus de 24 h après l'échéance, le staff est prévenu une fois (logs Modération).
   * La sanction reste active : retentée toutes les heures, levée dès que la cause est corrigée.
   */
  async #expiryFailed(guild, s, reason) {
    const attempts = (this.expiryRetries.get(s.id)?.attempts ?? 0) + 1;
    this.expiryRetries.set(s.id, { attempts, at: Date.now() + Math.min(EXPIRY_RETRY_MAX_MS, EXPIRY_RETRY_BASE_MS * 2 ** (attempts - 1)) });
    const what = s.type === 'mute' ? 'Fin du mute' : 'Débannissement';
    const line = `${what} automatique échoué (essai ${attempts}, nouvel essai plus tard) guild=${s.guild_id} user=${s.user_id} : ${reason}`;
    if (attempts === 1) logger.warn(line);
    else logger.debug(line);
    if (Date.now() - s.expires_at <= EXPIRY_ALERT_LATE_MS || this.expiryAlerted.has(s.id)) return;
    this.expiryAlerted.add(s.id);
    const logging = this.client.services?.logging;
    if (!logging) return;
    const mute = s.type === 'mute';
    const embed = card({
      tone: 'warning',
      section: 'moderation',
      icon: ICONS.warning,
      title: mute ? 'Fin de mute impossible' : 'Débannissement automatique impossible',
      description: [
        `${mute ? 'Le mute temporaire' : 'Le bannissement temporaire'} de <@${s.user_id}> est terminé depuis plus de 24 h, mais je n'arrive pas à le lever : ${truncate(String(reason), 300)}.`,
        `Je réessaie toutes les heures. Corrigez ${mute ? 'la permission « Gérer les rôles » ou la position de mon rôle' : 'la permission « Bannir des membres »'}, ou faites-le à la main avec \`${mute ? '/unmute' : '/unban'}\`.`,
      ].join('\n'),
      fields: [field(ICONS.user, 'Membre', `<@${s.user_id}>`), field(ICONS.date, 'Échéance', discordTimestamp(s.expires_at, 'R'))],
      footer: `Sanction #${s.id}`,
    });
    await logging.send(guild.id, 'moderation', embed, undefined, { event: 'revocation' }).catch(() => {});
  }

  async #processExpiredTempbans() {
    const due = this.sanctions.findDue();
    this.#forgetSettledRetries(due);
    const allowed = new Map();
    let calls = 0;
    for (const s of due) {
      if (this.stopping) return;
      if (s.type === 'mute') continue; // étape dédiée
      if (s.type !== 'tempban') {
        this.sanctions.deactivate(s.id); // timeout : expiré côté Discord
        continue;
      }
      if (this.#retryPending(s)) continue;
      const guild = this.#resolveGuild(s);
      if (!guild) continue;
      // findDue() est lu une fois par tick : la sanction a pu changer pendant les appels
      // réseau précédents (levée, remplacée, prolongée). On relit la ligne avant d'agir.
      if (!this.#stillDue(s)) continue;
      // Un ban définitif actif existe (converti pendant le tick, ou données anciennes) : par
      // prudence on ne débannit pas (on ne sait pas lequel des deux tient côté Discord), seule
      // la ligne temporaire est close — et le staff est PRÉVENU, il peut /unban si la ligne
      // « ban » était périmée.
      const permanent = this.sanctions.listActive?.(s.guild_id, s.user_id)?.find((r) => r.type === 'ban');
      if (permanent) {
        this.sanctions.deactivateActive(s.guild_id, s.user_id, 'tempban', { by: null, reason: 'Remplacé par un bannissement définitif' });
        await this.#logExpiry(guild, s, 'unban', `Le bannissement temporaire de <@${s.user_id}> est arrivé à échéance, mais un **bannissement définitif** (\`#${permanent.id}\`) est enregistré : il reste banni. Utilisez \`/unban\` si ce bannissement définitif n'a plus lieu d'être.`).catch(() => {});
        continue;
      }
      // Liste noire (SEC3) : le tempban échu d'un blacklisté n'est PAS levé ; la ligne temporaire
      // est close et le staff prévenu (seul /secur blacklist retirer peut le débannir).
      if (this.client.services?.blacklist?.has?.(s.guild_id, s.user_id, 'ban')) {
        this.sanctions.deactivateActive(s.guild_id, s.user_id, 'tempban', { by: null, reason: 'Liste noire : bannissement maintenu' });
        await this.#logBlacklistedTempban(guild, s).catch(() => {});
        continue;
      }
      // Sans « Bannir des membres », aucun appel voué au 403 (limite des requêtes invalides).
      if (!SchedulerService.#memo(allowed, guild.id, () => this.#canUnban(guild))) {
        await this.#expiryFailed(guild, s, 'la permission « Bannir des membres » manque au bot');
        continue;
      }
      if (calls >= MAX_EXPIRY_CALLS_PER_PASS) continue; // la suite au prochain passage
      calls += 1;
      const moderation = this.client.services?.moderation;
      // Marqué AVANT l'appel : guildBanRemove ne journalise pas une seconde fois cette levée.
      moderation?.markBotAction?.('unban', guild.id, s.user_id);
      try {
        await guild.bans.remove(s.user_id, 'Fin du bannissement temporaire');
      } catch (e) {
        moderation?.unmarkBotAction?.('unban', guild.id, s.user_id);
        // 10026 Unknown Ban : déjà débanni manuellement → rien à faire.
        if (e?.code === 10026) {
          this.sanctions.deactivate(s.id);
          this.#expirySucceeded(s);
        } else {
          await this.#expiryFailed(guild, s, e?.message ?? String(e));
        }
        continue;
      }
      this.#expirySucceeded(s);
      this.sanctions.deactivate(s.id);
      logger.info(`Ban temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
      await this.#logExpiry(guild, s, 'unban', `<@${s.user_id}> a purgé son bannissement temporaire et peut de nouveau rejoindre le serveur.`);
    }
  }

  /**
   * Mutes expirés : la sanction n'est désactivée qu'une fois le rôle réellement
   * retiré (ou si le membre est parti / n'a plus le rôle). Un échec transitoire
   * (permissions, hiérarchie, API) la garde active pour un nouvel essai.
   */
  async #processExpiredMutes() {
    const allowed = new Map();
    let calls = 0;
    for (const s of this.sanctions.findDue()) {
      if (this.stopping) return;
      if (s.type !== 'mute') continue;
      if (this.#retryPending(s)) continue;
      const guild = this.#resolveGuild(s);
      if (!guild) continue;
      // Rôle Muted au-dessus du bot ou « Gérer les rôles » retirée : aucun appel voué au 403.
      const roleId = this.client.services?.config?.get(guild.id)?.moderation?.mutedRoleId;
      if (roleId && !SchedulerService.#memo(allowed, guild.id, () => this.#canUnmute(guild, roleId))) {
        await this.#expiryFailed(guild, s, 'le rôle Muted est au-dessus du mien ou « Gérer les rôles » me manque');
        continue;
      }
      if (calls >= MAX_EXPIRY_CALLS_PER_PASS) continue; // la suite au prochain passage
      calls += 1;
      try {
        await this.#expireMute(guild, s);
        this.#expirySucceeded(s);
      } catch (e) {
        await this.#expiryFailed(guild, s, e?.message ?? String(e));
      }
    }
  }

  async #expireMute(guild, s) {
    const roleId = this.client.services?.config?.get(guild.id)?.moderation?.mutedRoleId;
    // Aucun rôle muet configuré : rien à retirer.
    if (!roleId) return this.sanctions.deactivate(s.id);
    let member;
    try {
      member = await guild.members.fetch(s.user_id);
    } catch (e) {
      // 10007 Unknown Member / 10013 Unknown User : parti, plus rien à lever.
      if (e?.code === 10007 || e?.code === 10013) return this.sanctions.deactivate(s.id);
      throw e;
    }
    if (!member?.roles?.cache?.has(roleId)) return this.sanctions.deactivate(s.id);
    // Relecture après le fetch : levée ou prolongée entre-temps → rien à faire.
    if (!this.#stillDue(s)) return undefined;
    // Un AUTRE mute est en vigueur (remute pendant le tick) : l'ancienne ligne est close, le rôle reste.
    const other = this.sanctions.activeMute?.(s.guild_id, s.user_id);
    if (other && other.id !== s.id) return this.sanctions.deactivate(s.id);
    try {
      await member.roles.remove(roleId, 'Fin du mute temporaire');
    } catch (e) {
      // Parti entre-temps, ou rôle supprimé : le membre n'est plus muet.
      if (e?.code === 10007 || e?.code === 10011) return this.sanctions.deactivate(s.id);
      throw e; // pas de carte « unmute » : le rôle est toujours là
    }
    this.sanctions.deactivate(s.id);
    logger.info(`Mute temporaire expiré retiré: guild=${s.guild_id} user=${s.user_id}`);
    await this.#logExpiry(guild, s, 'unmute', `${member} peut de nouveau écrire et parler : son mute temporaire est terminé.`, member.user);
  }

  /** true si la sanction (relue en base) est toujours active et arrivée à échéance. */
  #stillDue(s, now = Date.now()) {
    const fresh = this.sanctions.get ? this.sanctions.get(s.guild_id, s.id) : s;
    return Boolean(fresh?.active && fresh.expires_at && fresh.expires_at <= now);
  }

  /** Tempban échu d'un blacklisté : maintenu, staff prévenu (logs Modération). */
  async #logBlacklistedTempban(guild, s) {
    const logging = this.client.services?.logging;
    if (!logging) return;
    const embed = card({
      tone: 'warning',
      section: 'moderation',
      icon: ICONS.ban,
      title: 'Bannissement temporaire maintenu',
      description: `Le bannissement temporaire de <@${s.user_id}> est arrivé à échéance, mais il est sur la **liste noire** de sécurité : il reste banni. Un owner peut le retirer de la liste avec \`/secur blacklist retirer\`.`,
      fields: [field(ICONS.user, 'Membre', `<@${s.user_id}>`), field(ICONS.date, 'Échéance', discordTimestamp(s.expires_at, 'R'))],
      footer: `Sanction #${s.id}`,
    });
    await logging.send(guild.id, 'moderation', embed, undefined, { event: 'revocation' });
  }

  /** Log de modération d'une levée automatique (même carte que les levées manuelles). */
  async #logExpiry(guild, sanction, type, description, user) {
    const logging = this.client.services?.logging;
    if (!logging) return;
    await logging
      .send(guild.id, 'moderation', sanctionCard({
        type,
        user,
        userId: sanction.user_id,
        moderator: this.client.user,
        reason: 'Expiration automatique',
        description,
        id: sanction.id,
      }), undefined, { event: 'revocation' })
      .catch(() => {});
  }

  /** Carte de rappel (salon d'origine ou message privé). */
  /**
   * L'auteur d'un rappel peut-il encore écrire dans ce salon ? Relu à la livraison : un membre
   * parti, banni ou privé du droit d'écrire ne fait jamais publier son texte par le bot.
   */
  static async authorCanPost(channel, userId) {
    if (!channel.guild) return true; // messages privés
    const member = await channel.guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    const send = channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    return Boolean(channel.permissionsFor?.(member)?.has([PermissionFlagsBits.ViewChannel, send]));
  }

  static reminderCard(reminder) {
    return card({
      tone: 'info',
      section: 'utility',
      icon: '⏰',
      title: 'Rappel',
      description: neutralizeMaskedLinks(truncate(reminder.message, 3900)),
      fields: [reminder.created_at ? field(ICONS.date, 'Programmé', discordTimestamp(reminder.created_at, 'R')) : null],
      footer: `Rappel #${reminder.id}`,
    });
  }

  /**
   * Rappels échus : salon d'origine d'abord, puis MP en secours. La ligne n'est
   * supprimée qu'après une livraison réussie, ou si l'utilisateur et le salon
   * sont définitivement injoignables. Sur erreur transitoire, le rappel est gardé
   * (réessai au prochain tick) — au plus 24 h après son échéance.
   */
  async #processDueReminders(now = Date.now()) {
    for (const r of this.reminders.findDue(now)) {
      if (this.stopping) return;
      let outcome;
      try {
        outcome = await this.#deliverReminder(r);
      } catch (e) {
        logger.debug(`Rappel #${r.id} : erreur inattendue`, e?.message);
        outcome = 'retry';
      }
      if (outcome === 'sent' || outcome === 'unreachable') {
        if (outcome === 'unreachable') logger.info(`Rappel #${r.id} abandonné : utilisateur ${r.user_id} injoignable.`);
        this.reminders.deleteById(r.id);
      } else if (now - r.remind_at > REMINDER_MAX_LATE_MS) {
        logger.warn(`Rappel #${r.id} abandonné : non délivré plus de 24 h après son échéance (utilisateur ${r.user_id}).`);
        this.reminders.deleteById(r.id);
      }
    }
  }

  /** @returns {Promise<'sent' | 'unreachable' | 'retry'>} */
  async #deliverReminder(r) {
    const embed = SchedulerService.reminderCard(r);
    let permanent = true;

    if (r.channel_id) {
      try {
        const channel = await this.client.channels.fetch(r.channel_id);
        if (channel?.isTextBased?.() && typeof channel.send === 'function' && (await SchedulerService.authorCanPost(channel, r.user_id))) {
          await channel.send({ content: `<@${r.user_id}>`, embeds: [embed], allowedMentions: { users: [r.user_id] } });
          return 'sent';
        }
        // Salon devenu non textuel, auteur parti, banni ou sans droit d'écrire : MP.
      } catch (e) {
        if (!PERMANENT_CHANNEL_CODES.has(e?.code)) permanent = false;
        logger.debug(`Rappel #${r.id} : salon ${r.channel_id} indisponible (${e?.code ?? e?.message}), envoi en MP.`);
      }
    }

    try {
      const user = await this.client.users.fetch(r.user_id);
      await user.send({ embeds: [embed] });
      return 'sent';
    } catch (e) {
      if (!PERMANENT_USER_CODES.has(e?.code)) permanent = false;
      logger.debug(`Rappel #${r.id} : MP impossible (${e?.code ?? e?.message}).`);
    }
    return permanent ? 'unreachable' : 'retry';
  }
}

module.exports = { SchedulerService, REMINDER_MAX_LATE_MS, LEFT_GUILD_RETENTION_MS, SERVICE_STAGE_BUDGET_MS, MAX_EXPIRY_CALLS_PER_PASS };
