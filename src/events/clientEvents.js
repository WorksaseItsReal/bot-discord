'use strict';

const { createLogger } = require('../core/logger');

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
    name: 'shardDisconnect',
    execute(client, event, shardId) {
      logger.warn(`Shard ${shardId} déconnecté (code ${event?.code ?? '?'}). Reconnexion automatique…`);
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
