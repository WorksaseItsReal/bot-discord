'use strict';

/**
 * Erreur "utilisateur" : message sûr à afficher directement dans Discord.
 * Utilisée par les services/commandes pour signaler un échec attendu
 * (permission manquante, hiérarchie, cible invalide, etc.).
 */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.isUserError = true;
  }
}

/**
 * Enregistre les gestionnaires de processus globaux afin qu'une erreur
 * non capturée ne fasse jamais crasher le bot.
 * @param {import('./logger').logger} logger
 */
function registerGlobalHandlers(logger) {
  process.on('unhandledRejection', (reason) => {
    logger.error('Rejet de promesse non géré :', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Exception non capturée :', err);
  });
}

module.exports = { UserError, registerGlobalHandlers };
