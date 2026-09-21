'use strict';

/**
 * Vérification de démarrage SANS connexion à Discord.
 * Prouve que tout le câblage fonctionne : base de données + migrations,
 * services, chargement des commandes/événements, et sérialisation REST
 * (toJSON) de chaque slash command. Sort en code 1 au moindre problème.
 *
 * Usage : npm run check   (ne nécessite pas de DISCORD_TOKEN)
 */
const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(os.tmpdir(), `gadget-healthcheck-${Date.now()}.sqlite`);

const { GadgetClient } = require('../src/core/GadgetClient');
const { logger } = require('../src/core/logger');

function main() {
  const client = new GadgetClient();
  client.bootstrap();

  const problems = [];

  // 1) Base de données connectée + migrations appliquées
  const migrations = client.database.raw.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n;
  if (migrations < 1) problems.push('Aucune migration appliquée.');

  // 2) Services présents
  for (const svc of ['config', 'logging', 'strikes', 'moderation', 'scheduler']) {
    if (!client.services[svc]) problems.push(`Service manquant : ${svc}`);
  }

  // 3) Chaque commande se sérialise correctement pour l'API Discord
  const names = new Set();
  for (const [name, command] of client.commands) {
    try {
      const json = command.data.toJSON();
      if (!json.name) problems.push(`Commande sans nom : ${name}`);
      if (names.has(json.name)) problems.push(`Nom de commande dupliqué : ${json.name}`);
      names.add(json.name);
    } catch (err) {
      problems.push(`toJSON() a échoué pour /${name} : ${err.message}`);
    }
  }

  // 4) La config d'un serveur fictif se résout avec les valeurs par défaut
  const cfg = client.services.config.get('000000000000000000');
  if (!cfg || cfg.locale !== 'fr') problems.push('La configuration par défaut ne se résout pas correctement.');

  client.database.close();

  logger.info('--- Résumé du healthcheck ---');
  logger.info(`Commandes chargées : ${client.commands.size} (${[...names].sort().join(', ')})`);
  logger.info(`Événements chargés : ${client.eventHandler.count}`);
  logger.info(`Migrations appliquées : ${migrations}`);

  if (problems.length) {
    logger.error(`Healthcheck ÉCHOUÉ (${problems.length} problème(s)) :`);
    for (const p of problems) logger.error(`  - ${p}`);
    process.exit(1);
  }
  logger.info('Healthcheck RÉUSSI ✅ — le bot est correctement câblé.');
  process.exit(0);
}

main();
