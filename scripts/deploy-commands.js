'use strict';

const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { config, validate } = require('../src/config');
const { CommandHandler } = require('../src/core/CommandHandler');
const { logger } = require('../src/core/logger');

/**
 * Enregistre les slash commands.
 *  - Par défaut : sur le serveur DEV_GUILD_ID (mise à jour instantanée).
 *  - Avec --global : globalement (peut prendre jusqu'à 1h à se propager).
 */
async function main() {
  const global = process.argv.includes('--global');
  const errors = validate({ requireToken: true });
  if (errors.length) {
    for (const e of errors) logger.error(`  - ${e}`);
    process.exit(1);
  }

  const handler = new CommandHandler();
  handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));
  const body = handler.toJSON();

  const rest = new REST({ version: '10' }).setToken(config.token);

  if (!global && config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), { body });
    logger.info(`${body.length} commande(s) déployée(s) sur le serveur ${config.devGuildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    logger.info(`${body.length} commande(s) déployée(s) globalement.`);
  }
}

main().catch((err) => {
  logger.error('Échec du déploiement :', err);
  process.exit(1);
});
