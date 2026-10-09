'use strict';

const path = require('node:path');
const { Client, Collection } = require('discord.js');
const { intents, partials } = require('../config/intents');
const { config } = require('../config');
const { createLogger } = require('./logger');
const { CommandHandler } = require('./CommandHandler');
const { EventHandler } = require('./EventHandler');
const { ComponentHandler } = require('./ComponentHandler');
const { CooldownManager } = require('./cooldowns');
const { DatabaseManager } = require('../database');
const { AutoBackup, backupStem, defaultBackupDir } = require('../database/backup');
const { startHealthServer } = require('./healthServer');
const { GuildConfigRepository } = require('../database/repositories/GuildConfigRepository');
const { SanctionRepository } = require('../database/repositories/SanctionRepository');
const { StrikeRepository } = require('../database/repositories/StrikeRepository');
const { ReminderRepository } = require('../database/repositories/ReminderRepository');
const { TicketRepository } = require('../database/repositories/TicketRepository');
const { GiveawayRepository } = require('../database/repositories/GiveawayRepository');
const { SuggestionRepository } = require('../database/repositories/SuggestionRepository');
const { CustomCommandRepository } = require('../database/repositories/CustomCommandRepository');
const { RoleMenuRepository } = require('../database/repositories/RoleMenuRepository');
const { BackupRepository } = require('../database/repositories/BackupRepository');
const { ModmailRepository } = require('../database/repositories/ModmailRepository');
const { TempVoiceRepository } = require('../database/repositories/TempVoiceRepository');
const { LockRepository } = require('../database/repositories/LockRepository');
const { ProjectRepository } = require('../database/repositories/ProjectRepository');
const { AutomodEventRepository } = require('../database/repositories/AutomodEventRepository');
const { AutomodQuarantineRepository } = require('../database/repositories/AutomodQuarantineRepository');
const { ModNoteRepository } = require('../database/repositories/ModNoteRepository');
const { LevelRepository } = require('../database/repositories/LevelRepository');
const { InviteJoinRepository } = require('../database/repositories/InviteJoinRepository');
const { ReportRepository } = require('../database/repositories/ReportRepository');
const { StarboardRepository } = require('../database/repositories/StarboardRepository');
const { StickyRepository } = require('../database/repositories/StickyRepository');
const { TempRoleRepository } = require('../database/repositories/TempRoleRepository');
const { ScheduledAnnouncementRepository } = require('../database/repositories/ScheduledAnnouncementRepository');
const { BirthdayRepository } = require('../database/repositories/BirthdayRepository');
const { AfkRepository } = require('../database/repositories/AfkRepository');
const { HighlightRepository } = require('../database/repositories/HighlightRepository');
const { EconomyRepository } = require('../database/repositories/EconomyRepository');
const { GameScoreRepository } = require('../database/repositories/GameScoreRepository');
const { ConfigService } = require('../services/ConfigService');
const { StrikeService } = require('../services/StrikeService');
const { LoggingService } = require('../services/LoggingService');
const { ModerationService } = require('../services/ModerationService');
const { SchedulerService } = require('../services/SchedulerService');
const { AutoModService } = require('../services/AutoModService');
const { AntiRaidService } = require('../services/AntiRaidService');
const { LockdownService } = require('../services/LockdownService');
const { TicketService } = require('../services/TicketService');
const { GiveawayService } = require('../services/GiveawayService');
const { SuggestionService } = require('../services/SuggestionService');
const { BackupService } = require('../services/BackupService');
const { ModmailService } = require('../services/ModmailService');
const { TempVoiceService } = require('../services/TempVoiceService');
const { ProjectService } = require('../services/ProjectService');
const { LogSetupService } = require('../services/LogSetupService');
const { WelcomeService } = require('../services/WelcomeService');
const { LevelService } = require('../services/LevelService');
const { InviteTrackerService } = require('../services/InviteTrackerService');
const { StatsCounterService } = require('../services/StatsCounterService');
const { ReportService } = require('../services/ReportService');
const { StarboardService } = require('../services/StarboardService');
const { StickyService } = require('../services/StickyService');
const { AutoResponderService } = require('../services/AutoResponderService');
const { TempRoleService } = require('../services/TempRoleService');
const { AnnouncementService } = require('../services/AnnouncementService');
const { BirthdayService } = require('../services/BirthdayService');
const { AfkService } = require('../services/AfkService');
const { HighlightService } = require('../services/HighlightService');
const { SnipeService } = require('../services/SnipeService');
const { EconomyService } = require('../services/EconomyService');
const { GameService } = require('../services/GameService');

const logger = createLogger('client');

/**
 * Échéance GLOBALE des arrêts de services (scheduler, niveaux, compteurs, communauté,
 * vidages) lancés en parallèle : il reste ensuite de quoi fermer la passerelle et la base
 * sous le garde-fou de 10 s (src/index.js, src/core/errors.js).
 */
const SHUTDOWN_DEADLINE_MS = 6_000;

/**
 * Client Discord étendu : conteneur d'injection de dépendances pour la base,
 * les repositories et les services, plus le chargement des commandes/événements.
 */
class GadgetClient extends Client {
  constructor() {
    // Défense en profondeur : sans autorisation explicite, aucun message du bot ne peut
    // notifier @everyone/@here ou un rôle (les envois qui doivent pinguer passent allowedMentions).
    super({ intents, partials, allowedMentions: { parse: ['users'], repliedUser: false } });

    this.config = config;
    this.logger = logger;
    /** @type {Collection<string, object>} */
    this.commands = new Collection();
    this.startedAt = Date.now();
    this.cooldowns = new CooldownManager();
    /** Compteurs d'exécution (affichés par /botinfo et /health). */
    this.stats = { commandsRun: 0, errors: 0 };

    this.database = new DatabaseManager(config.databasePath);
    /** Échéance des arrêts de services (modifiable par les tests). */
    this.shutdownDeadlineMs = SHUTDOWN_DEADLINE_MS;
    this.commandHandler = new CommandHandler();
    this.eventHandler = new EventHandler(this);
    this.componentHandler = new ComponentHandler();
  }

  /**
   * Prépare tout ce qui n'exige pas de connexion Discord : base de données,
   * repositories, services, chargement des commandes et événements.
   * Utilisé aussi par le healthcheck (sans login).
   */
  bootstrap() {
    const db = this.database.connect();

    this.repositories = {
      guildConfig: new GuildConfigRepository(db),
      sanctions: new SanctionRepository(db),
      strikes: new StrikeRepository(db),
      reminders: new ReminderRepository(db),
      tickets: new TicketRepository(db),
      giveaways: new GiveawayRepository(db),
      suggestions: new SuggestionRepository(db),
      customCommands: new CustomCommandRepository(db),
      roleMenus: new RoleMenuRepository(db),
      backups: new BackupRepository(db),
      modmail: new ModmailRepository(db),
      tempVoice: new TempVoiceRepository(db),
      locks: new LockRepository(db),
      projects: new ProjectRepository(db),
      automodEvents: new AutomodEventRepository(db),
      automodQuarantines: new AutomodQuarantineRepository(db),
      modNotes: new ModNoteRepository(db),
      levels: new LevelRepository(db),
      inviteJoins: new InviteJoinRepository(db),
      reports: new ReportRepository(db),
      starboard: new StarboardRepository(db),
      sticky: new StickyRepository(db),
      tempRoles: new TempRoleRepository(db),
      announcements: new ScheduledAnnouncementRepository(db),
      birthdays: new BirthdayRepository(db),
      afk: new AfkRepository(db),
      highlights: new HighlightRepository(db),
      economy: new EconomyRepository(db),
      gameScores: new GameScoreRepository(db),
    };

    const configService = new ConfigService(this.repositories.guildConfig);
    const logging = new LoggingService(this, configService);
    // L'AntiRaid est injecté dans la modération : les bans faits via le bot alimentent
    // la détection des bannissements en masse (l'audit log les attribue au bot).
    const antiraid = new AntiRaidService({ client: this, config: configService, logging });
    const moderation = new ModerationService({ sanctions: this.repositories.sanctions, config: configService, logging, antiraid });
    const strikes = new StrikeService(this.repositories.strikes, configService);
    this.services = {
      config: configService,
      logging,
      moderation,
      strikes,
      scheduler: new SchedulerService({ client: this, sanctions: this.repositories.sanctions, reminders: this.repositories.reminders }),
      automod: new AutoModService({ config: configService, logging, moderation, strikes, events: this.repositories.automodEvents, quarantines: this.repositories.automodQuarantines }),
      antiraid,
      lockdown: new LockdownService({ locks: this.repositories.locks, logging }),
      tickets: new TicketService({ tickets: this.repositories.tickets, config: configService, logging }),
      giveaways: new GiveawayService({ client: this, giveaways: this.repositories.giveaways }),
      suggestions: new SuggestionService({ client: this, suggestions: this.repositories.suggestions, config: configService }),
      backup: new BackupService({ backups: this.repositories.backups }),
      modmail: new ModmailService({ client: this, modmail: this.repositories.modmail, config: configService }),
      tempVoice: new TempVoiceService({ tempVoice: this.repositories.tempVoice, config: configService }),
      projects: new ProjectService({ client: this, projects: this.repositories.projects, config: configService }),
      logSetup: new LogSetupService({ config: configService }),
      welcome: new WelcomeService({ client: this, config: configService, logging }),
      levels: new LevelService({ client: this, levels: this.repositories.levels, config: configService }),
      invites: new InviteTrackerService({ client: this, joins: this.repositories.inviteJoins, config: configService }),
      counters: new StatsCounterService({ client: this, config: configService }),
      reports: new ReportService({ reports: this.repositories.reports, config: configService, logging }),
      // Communauté : starboard, messages épinglés automatiquement, réponses automatiques.
      starboard: new StarboardService({ client: this, starboard: this.repositories.starboard, config: configService }),
      sticky: new StickyService({ client: this, sticky: this.repositories.sticky }),
      autoResponses: new AutoResponderService({ client: this, config: configService }),
      // Tâches planifiées : chacune est une étape isolée du SchedulerService.
      tempRoles: new TempRoleService({ client: this, tempRoles: this.repositories.tempRoles }),
      announcements: new AnnouncementService({ client: this, announcements: this.repositories.announcements }),
      birthdays: new BirthdayService({ client: this, birthdays: this.repositories.birthdays, config: configService }),
      // Outils des membres : absences (/afk), alertes de mots-clés (/alertes), snipe (/snipe).
      afk: new AfkService({ client: this, afk: this.repositories.afk, config: configService }),
      highlights: new HighlightService({ client: this, highlights: this.repositories.highlights, config: configService }),
      snipe: new SnipeService({ client: this, config: configService }),
      // Économie : synchrone (transactions SQLite), aucun minuteur à arrêter.
      economy: new EconomyService({ economy: this.repositories.economy, config: configService }),
      // Mini-jeux (/jeu) : parties en mémoire (minuteurs unref, arrêtés dans shutdown), scores en base.
      games: new GameService({ client: this, scores: this.repositories.gameScores }),
    };

    this.commands = this.commandHandler.loadAll(path.join(__dirname, '..', 'commands'));
    this.componentHandler.loadAll(path.join(__dirname, '..', 'components'));
    this.eventHandler.loadAll(path.join(__dirname, '..', 'events'));
    return this;
  }

  async start() {
    this.bootstrap();
    // Avant le login : /healthz répond 503 tant que la connexion n'est pas prête.
    await this.startOperations();
    await this.login(config.token);
    this.services.scheduler.start();
    this.services.levels.start(); // suivi vocal des niveaux (minuteur unref, arrêté dans shutdown)
    this.services.counters.start(); // compteurs de statistiques (minuteur unref, arrêté dans shutdown)
  }

  /**
   * Exploitation (optionnelle, pilotée par l'environnement) : serveur /healthz +
   * /metrics (HEALTH_PORT) et sauvegarde automatique de la base
   * (DB_BACKUP_INTERVAL_HOURS). Un échec ici n'empêche jamais le bot de démarrer.
   */
  async startOperations(opts = config) {
    if (opts === config) {
      // Valeur présente mais rejetée par la config (hors bornes, non numérique) : on le signale.
      const env = { HEALTH_PORT: 'healthPort', DB_BACKUP_INTERVAL_HOURS: 'dbBackupIntervalHours', DB_BACKUP_KEEP: 'dbBackupKeep' };
      for (const [name, key] of Object.entries(env)) {
        const raw = process.env[name]?.trim();
        if (raw && Number(raw) !== opts[key]) logger.warn(`${name}=${raw} invalide : ignoré (voir .env.example).`);
      }
    }
    if (opts.healthPort !== null && opts.healthPort !== undefined) {
      try {
        this.healthServer = await startHealthServer(this, { port: opts.healthPort, host: opts.healthHost });
        logger.info(`Supervision : http://${opts.healthHost}:${this.healthServer.port}/healthz et /metrics`);
      } catch (err) {
        logger.warn(`Serveur de supervision non démarré (port ${opts.healthPort}) :`, err?.message);
      }
    }
    if (opts.dbBackupIntervalHours) {
      try {
        this.autoBackup = new AutoBackup({
          database: this.database,
          intervalHours: opts.dbBackupIntervalHours,
          dir: opts.dbBackupDir || defaultBackupDir(this.database.filePath),
          stem: backupStem(this.database.filePath),
          keep: opts.dbBackupKeep,
        });
        this.autoBackup.start();
      } catch (err) {
        logger.warn('Sauvegarde automatique non démarrée :', err?.message);
      }
    }
  }

  /**
   * Arrêt propre : ferme le serveur de supervision, stoppe la sauvegarde
   * automatique et le scheduler (en attendant ce qui est en cours),
   * ferme la connexion Discord puis la base. Idempotent : un signal et une
   * exception fatale simultanés partagent le même arrêt.
   */
  shutdown() {
    if (!this.shutdownPromise) this.shutdownPromise = this.#doShutdown();
    return this.shutdownPromise;
  }

  /**
   * Lance toutes les tâches EN PARALLÈLE et attend qu'elles finissent, au plus `deadlineMs`
   * au total (une tâche bloquée n'empêche jamais la suite de l'arrêt).
   * @param {Array<[string, () => unknown]>} tasks [libellé, fonction]
   * @returns {Promise<string[]>} libellés des tâches encore en cours à l'échéance
   */
  async #settleAll(tasks, deadlineMs) {
    const pending = new Set(tasks.map(([label]) => label));
    const runs = tasks.map(async ([label, fn]) => {
      try {
        await fn();
      } catch (err) {
        logger.warn(`${label} :`, err?.message);
      } finally {
        pending.delete(label);
      }
    });
    let timer;
    // Minuteur NON « unref » : il doit réveiller l'arrêt même si plus rien d'autre ne tourne.
    const deadline = new Promise((r) => {
      timer = setTimeout(r, deadlineMs);
    });
    await Promise.race([Promise.all(runs), deadline]);
    clearTimeout(timer);
    return [...pending];
  }

  async #doShutdown() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    try {
      await this.healthServer?.close();
    } catch (err) {
      logger.warn('Fermeture du serveur de supervision :', err?.message);
    }
    try {
      // Attendre une éventuelle sauvegarde en cours avant de fermer la base.
      await this.autoBackup?.stop();
    } catch (err) {
      logger.warn('Arrêt de la sauvegarde automatique :', err?.message);
    }
    // Un SEUL passage parallèle, borné globalement (SHUTDOWN_DEADLINE_MS) : arrêt des boucles
    // (scheduler et niveaux attendent leur tick en cours, qui écrit en base), des compteurs et
    // de la communauté (minuteurs d'anti-rebond, écritures en cours), et vidage du travail
    // différé (suppression des tickets fermés promise aux membres, cartes de giveaways et de
    // projets). Avant, ces attentes s'enchaînaient (3 s + 3 s + 3 s + boucles non bornées) et
    // le garde-fou de 10 s pouvait tuer le processus avant la fermeture de la base.
    const s = this.services ?? {};
    const tasks = [
      ['Arrêt du scheduler', () => s.scheduler?.stop()],
      ['Arrêt du suivi des niveaux', () => s.levels?.stop()],
      ['Arrêt des compteurs de statistiques', () => s.counters?.stop()],
      ['Arrêt des réponses automatiques', () => s.autoResponses?.stop()],
      ['Arrêt des messages épinglés', () => s.sticky?.stop()],
      ['Arrêt du starboard', () => s.starboard?.stop()],
      // Outils des membres : envois en attente annulés, réponses d'absence affichées supprimées.
      ['Arrêt des absences', () => s.afk?.stop()],
      ['Arrêt des alertes de mots-clés', () => s.highlights?.stop()],
      ['Arrêt du snipe', () => s.snipe?.stop()],
      // Mini-jeux : nettoyage périodique et minuteurs (défis, questions) annulés.
      ['Arrêt des mini-jeux', () => s.games?.stop()],
      ['Vidage des tickets', () => s.tickets?.flush?.()],
      ['Vidage des giveaways', () => s.giveaways?.flush?.()],
      ['Vidage des projets', () => s.projects?.flush?.()],
    ];
    const late = await this.#settleAll(tasks, this.shutdownDeadlineMs);
    if (late.length) logger.warn(`Arrêt : échéance de ${this.shutdownDeadlineMs} ms atteinte, toujours en cours : ${late.join(', ')}.`);
    try {
      await this.destroy();
    } catch (err) {
      logger.warn('Fermeture de la connexion Discord :', err?.message);
    }
    try {
      this.database?.close();
    } catch (err) {
      logger.warn('Fermeture de la base :', err?.message);
    }
  }

  get uptime() {
    return Date.now() - this.startedAt;
  }
}

module.exports = { GadgetClient };
