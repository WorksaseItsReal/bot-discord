'use strict';

const { GadgetClient } = require('./core/GadgetClient');
const { validate } = require('./config');
const { logger } = require('./core/logger');
const { registerGlobalHandlers, setShutdownHook } = require('./core/errors');

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
  // Exception non capturée : arrêt propre (scheduler, Discord, base) avant exit(1).
  setShutdownHook(() => client.shutdown());

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`Signal ${signal} reçu, arrêt propre...`);
    // Garde-fou : si la fermeture bloque, on quitte quand même après 10 s.
    setTimeout(() => process.exit(0), 10_000).unref();
    await client.shutdown();
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
