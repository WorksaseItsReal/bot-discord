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
const { ReportRepository } = require('../database/repositories/ReportRepository');
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
const { ReportService } = require('../services/ReportService');

const logger = createLogger('client');

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
      reports: new ReportRepository(db),
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
      reports: new ReportService({ reports: this.repositories.reports, config: configService, logging }),
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
    try {
      // Attendre le tick en cours : il écrit en base, qu'on ne doit pas fermer sous lui.
      await this.services?.scheduler?.stop();
    } catch (err) {
      logger.warn('Arrêt du scheduler :', err?.message);
    }
    try {
      await this.services?.levels?.stop();
    } catch (err) {
      logger.warn('Arrêt du suivi des niveaux :', err?.message);
    }
    // Travail différé (éditions de cartes, suppression de tickets fermés) : terminé avant de couper.
    // Tickets d'abord (suppression de salons promise aux membres), chaque vidage borné à 3 s
    // pour rester sous le garde-fou d'arrêt.
    for (const name of ['tickets', 'giveaways', 'projects']) {
      try {
        const flush = this.services?.[name]?.flush?.();
        if (flush) await Promise.race([flush, new Promise((r) => setTimeout(r, 3000).unref?.())]);
      } catch (err) {
        logger.warn(`Vidage du service ${name} :`, err?.message);
      }
    }
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
