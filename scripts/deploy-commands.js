'use strict';

const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { config, validate } = require('../src/config');
const { CommandHandler } = require('../src/core/CommandHandler');
const { logger } = require('../src/core/logger');

/**
 * Enregistre les slash commands.
 *
 *   node scripts/deploy-commands.js                 → serveur DEV_GUILD_ID (instantané),
 *                                                     ou global si DEV_GUILD_ID est vide
 *   node scripts/deploy-commands.js --global        → globalement (jusqu'à 1 h de propagation)
 *   node scripts/deploy-commands.js --clear-guild   → supprime toutes les commandes du serveur
 *                                                     DEV_GUILD_ID (PUT []), utile après un
 *                                                     passage en global pour éviter les doublons
 *   node scripts/deploy-commands.js --dry-run       → affiche ce qui serait déployé (nombre +
 *                                                     noms), sans appel à l'API ni token requis
 *
 * Sort en code 1 si une commande n'a pas pu être chargée : on ne déploie jamais
 * un jeu de commandes incomplet (cela supprimerait les commandes manquantes).
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  const global = args.has('--global');
  const dryRun = args.has('--dry-run');
  const clearGuild = args.has('--clear-guild');

  if (clearGuild && global) {
    logger.error('--clear-guild et --global sont incompatibles.');
    process.exit(1);
  }

  const target = clearGuild || (!global && config.devGuildId) ? 'guild' : 'global';
  if (target === 'guild' && !config.devGuildId) {
    logger.error('--clear-guild nécessite DEV_GUILD_ID dans .env');
    process.exit(1);
  }

  let body = [];
  if (!clearGuild) {
    const handler = new CommandHandler();
    handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));
    if (handler.failures.length) {
      logger.error(`${handler.failures.length} commande(s) n'ont pas pu être chargée(s) — déploiement annulé :`);
      for (const f of handler.failures) logger.error(`  - ${f.file} : ${f.reason}`);
      process.exit(1);
    }
    body = handler.toJSON();
  }

  const where = target === 'guild' ? `sur le serveur ${config.devGuildId}` : 'globalement';
  if (dryRun) {
    if (clearGuild) logger.info(`[dry-run] Toutes les commandes seraient supprimées ${where}.`);
    else logger.info(`[dry-run] ${body.length} commande(s) seraient déployée(s) ${where} : ${body.map((c) => c.name).sort().join(', ')}`);
    return;
  }

  const errors = validate({ requireToken: true });
  if (errors.length) {
    for (const e of errors) logger.error(`  - ${e}`);
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = target === 'guild' ? Routes.applicationGuildCommands(config.clientId, config.devGuildId) : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body });
  if (clearGuild) logger.info(`Commandes supprimées ${where}.`);
  else logger.info(`${body.length} commande(s) déployée(s) ${where}.`);
}

main().catch((err) => {
  logger.error('Échec du déploiement :', err);
  process.exit(1);
});
