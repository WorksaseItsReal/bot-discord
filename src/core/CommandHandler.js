'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');
const { createLogger } = require('./logger');

const logger = createLogger('commands');

/**
 * Charge récursivement les modules de commandes depuis src/commands.
 * Chaque module exporte : { data: SlashCommandBuilder, category, execute, autocomplete? }.
 */
class CommandHandler {
  constructor() {
    /** @type {Collection<string, object>} */
    this.commands = new Collection();
  }

  /** @param {string} dir dossier des commandes */
  loadAll(dir) {
    const files = this.#walk(dir);
    for (const file of files) {
      try {
        const command = require(file);
        if (!command?.data?.name || typeof command.execute !== 'function') {
          logger.warn(`Commande ignorée (structure invalide) : ${path.relative(dir, file)}`);
          continue;
        }
        command.category = command.category || path.basename(path.dirname(file));
        this.commands.set(command.data.name, command);
      } catch (err) {
        logger.error(`Échec du chargement de ${file} :`, err);
      }
    }
    logger.info(`${this.commands.size} commande(s) chargée(s).`);
    return this.commands;
  }

  /** Payload JSON pour l'API REST (déploiement des slash commands). */
  toJSON() {
    return this.commands.map((c) => c.data.toJSON());
  }

  #walk(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.#walk(full));
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }
}

module.exports = { CommandHandler };
