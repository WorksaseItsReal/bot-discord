'use strict';

const path = require('node:path');
const { Client, Collection } = require('discord.js');
const { intents, partials } = require('../config/intents');
const { config } = require('../config');
const { createLogger } = require('./logger');
const { CommandHandler } = require('./CommandHandler');
const { EventHandler } = require('./EventHandler');
const { DatabaseManager } = require('../database');
const { GuildConfigRepository } = require('../database/repositories/GuildConfigRepository');
const { SanctionRepository } = require('../database/repositories/SanctionRepository');
const { StrikeRepository } = require('../database/repositories/StrikeRepository');
const { ReminderRepository } = require('../database/repositories/ReminderRepository');
const { ConfigService } = require('../services/ConfigService');
const { StrikeService } = require('../services/StrikeService');
const { LoggingService } = require('../services/LoggingService');
const { ModerationService } = require('../services/ModerationService');
const { SchedulerService } = require('../services/SchedulerService');

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

    this.database = new DatabaseManager(config.databasePath);
    this.commandHandler = new CommandHandler();
    this.eventHandler = new EventHandler(this);
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
    };

    const configService = new ConfigService(this.repositories.guildConfig);
    const logging = new LoggingService(this, configService);
    this.services = {
      config: configService,
      logging,
      strikes: new StrikeService(this.repositories.strikes, configService),
      moderation: new ModerationService({ sanctions: this.repositories.sanctions, config: configService, logging }),
      scheduler: new SchedulerService({ client: this, sanctions: this.repositories.sanctions, reminders: this.repositories.reminders }),
    };

    this.commands = this.commandHandler.loadAll(path.join(__dirname, '..', 'commands'));
    this.eventHandler.loadAll(path.join(__dirname, '..', 'events'));
    return this;
  }

  async start() {
    this.bootstrap();
    await this.login(config.token);
    this.services.scheduler.start();
  }

  get uptime() {
    return Date.now() - this.startedAt;
  }
}

module.exports = { GadgetClient };
