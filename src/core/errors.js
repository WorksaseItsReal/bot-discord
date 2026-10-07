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

/** Délai maximal laissé à l'arrêt propre après une exception non capturée. */
const FATAL_SHUTDOWN_TIMEOUT_MS = 10_000;

/** @type {(() => Promise<void> | void) | null} */
let shutdownHook = null;

/**
 * Enregistre la fonction d'arrêt propre (scheduler, connexion Discord, base)
 * appelée avant de quitter après une exception non capturée.
 * @param {(() => Promise<void> | void) | null} fn
 */
function setShutdownHook(fn) {
  shutdownHook = typeof fn === 'function' ? fn : null;
}

/**
 * Exception non capturée : l'état du processus est incertain (Node le
 * recommande), on journalise, on tente un arrêt propre puis on quitte en code 1
 * (le superviseur — pm2, systemd, Docker — redémarre le bot).
 * @param {import('./logger').logger} logger
 * @param {unknown} err
 * @param {{ exit?: (code: number) => void, timeoutMs?: number }} [opts] injectables (tests)
 */
let fatalInProgress = false;
async function handleFatal(logger, err, { exit = (code) => process.exit(code), timeoutMs = FATAL_SHUTDOWN_TIMEOUT_MS } = {}) {
  logger.error('Exception non capturée :', err);
  if (fatalInProgress) return;
  fatalInProgress = true;
  const guard = setTimeout(() => exit(1), timeoutMs);
  guard.unref?.();
  try {
    if (shutdownHook) {
      logger.error('Arrêt propre avant redémarrage…');
      await shutdownHook();
    }
  } catch (shutdownErr) {
    logger.error('Échec de l\'arrêt propre :', shutdownErr);
  } finally {
    clearTimeout(guard);
    exit(1);
  }
}

/**
 * Enregistre les gestionnaires de processus globaux.
 *  - unhandledRejection : journalisé uniquement (le bot continue).
 *  - uncaughtException : journalisé, arrêt propre (si un hook est enregistré), puis exit(1).
 * @param {import('./logger').logger} logger
 */
function registerGlobalHandlers(logger) {
  process.on('unhandledRejection', (reason) => {
    logger.error('Rejet de promesse non géré :', reason);
  });
  process.on('uncaughtException', (err) => {
    handleFatal(logger, err);
  });
}

/** Réinitialise l'état interne (tests uniquement). */
function _resetFatalState() {
  fatalInProgress = false;
  shutdownHook = null;
}

module.exports = { UserError, registerGlobalHandlers, setShutdownHook, handleFatal, _resetFatalState };
