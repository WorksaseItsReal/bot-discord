'use strict';

const { createLogger } = require('../core/logger');
const { handleFatal } = require('../core/errors');

const logger = createLogger('gateway');

/**
 * Événements de santé de la connexion Discord. Sans écouteur `error`, une erreur
 * émise par le client ferait planter le processus Node.
 */
module.exports = [
  {
    name: 'error',
    execute(client, error) {
      logger.error('Erreur du client Discord :', error);
    },
  },
  {
    name: 'warn',
    execute(client, message) {
      logger.warn(message);
    },
  },
  {
    // discord.js n'émet shardDisconnect QUE pour une fermeture non récupérable (4004 jeton
    // invalide, 4010-4013, 4014 intents privilégiés refusés) : AUCUNE reconnexion n'aura lieu.
    // Rester en vie ferait un processus zombie (plus aucun événement, /healthz à 200) : on
    // passe par le chemin fatal (arrêt propre puis exit(1)) pour que le superviseur relance.
    name: 'shardDisconnect',
    execute(client, event, shardId) {
      const err = new Error(`Shard ${shardId} fermé définitivement par Discord (code ${event?.code ?? '?'}) : jeton, intents privilégiés ou sharding à corriger.`);
      return handleFatal(logger, err, { label: 'Connexion à Discord perdue sans reconnexion possible' });
    },
  },
  {
    name: 'shardReconnecting',
    execute(client, shardId) {
      logger.info(`Shard ${shardId} : reconnexion en cours…`);
    },
  },
  {
    name: 'shardResume',
    execute(client, shardId, replayed) {
      logger.info(`Shard ${shardId} reconnecté (${replayed} événement(s) rejoué(s)).`);
    },
  },
  {
    name: 'shardError',
    execute(client, error, shardId) {
      logger.error(`Erreur WebSocket sur le shard ${shardId} :`, error);
    },
  },
];
