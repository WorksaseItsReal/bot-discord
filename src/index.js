'use strict';

const { GadgetClient } = require('./core/GadgetClient');
const { validate } = require('./config');
const { logger } = require('./core/logger');
const { registerGlobalHandlers } = require('./core/errors');

async function main() {
  registerGlobalHandlers(logger);

  const errors = validate({ requireToken: true });
  if (errors.length) {
    logger.error('Configuration invalide :');
    for (const e of errors) logger.error(`  - ${e}`);
    logger.error('Copiez .env.example en .env et remplissez les valeurs requises.');
    process.exit(1);
  }

  const client = new GadgetClient();

  const shutdown = (signal) => {
    logger.info(`Signal ${signal} reçu, arrêt propre...`);
    client.services?.scheduler?.stop();
    client.database?.close();
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.start();
}

main().catch((err) => {
  logger.error('Échec du démarrage du bot :', err);
  process.exit(1);
});
