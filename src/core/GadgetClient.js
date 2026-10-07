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
const { ModNoteRepository } = require('../database/repositories/ModNoteRepository');
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

const logger = createLogger('client');

/**
 * Client Discord étendu : conteneur d'injection de dépendances pour la base,
 * les repositories et les services, plus le chargement des commandes/événements.
 */
class GadgetClient extends Client {
  constructor() {
    super({ intents, partials });

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
      modNotes: new ModNoteRepository(db),
    };

    const configService = new ConfigService(this.repositories.guildConfig);
    const logging = new LoggingService(this, configService);
    const moderation = new ModerationService({ sanctions: this.repositories.sanctions, config: configService, logging });
    const strikes = new StrikeService(this.repositories.strikes, configService);
    this.services = {
      config: configService,
      logging,
      moderation,
      strikes,
      scheduler: new SchedulerService({ client: this, sanctions: this.repositories.sanctions, reminders: this.repositories.reminders }),
      automod: new AutoModService({ config: configService, logging, moderation, strikes, events: this.repositories.automodEvents }),
      antiraid: new AntiRaidService({ client: this, config: configService, logging }),
      lockdown: new LockdownService({ locks: this.repositories.locks, logging }),
      tickets: new TicketService({ tickets: this.repositories.tickets, config: configService, logging }),
      giveaways: new GiveawayService({ client: this, giveaways: this.repositories.giveaways }),
      suggestions: new SuggestionService({ client: this, suggestions: this.repositories.suggestions, config: configService }),
      backup: new BackupService({ backups: this.repositories.backups }),
      modmail: new ModmailService({ client: this, modmail: this.repositories.modmail, config: configService }),
      tempVoice: new TempVoiceService({ tempVoice: this.repositories.tempVoice, config: configService }),
      projects: new ProjectService({ client: this, projects: this.repositories.projects, config: configService }),
      logSetup: new LogSetupService({ config: configService }),
    };

    this.commands = this.commandHandler.loadAll(path.join(__dirname, '..', 'commands'));
    this.componentHandler.loadAll(path.join(__dirname, '..', 'components'));
    this.eventHandler.loadAll(path.join(__dirname, '..', 'events'));
    return this;
  }

  async start() {
    this.bootstrap();
    await this.login(config.token);
    this.services.scheduler.start();
  }

  /**
   * Arrêt propre : stoppe le scheduler (en attendant la fin du tick en cours),
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
      // Attendre le tick en cours : il écrit en base, qu'on ne doit pas fermer sous lui.
      await this.services?.scheduler?.stop();
    } catch (err) {
      logger.warn('Arrêt du scheduler :', err?.message);
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
