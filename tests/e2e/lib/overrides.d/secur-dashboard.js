'use strict';

const { IDS } = require('../fixtures');

/**
 * Panneau /secur (SEC2) : chemin « succès » des explorations automatiques. Les modifications
 * exigent le niveau owner (propriétaire du serveur ou owner de sécurité) : en administrateur, la
 * commande répond par un refus en embed, ce que vérifient ux.e2e et commands.e2e.
 */
module.exports = {
  'secur module': { module: 'channelDelete', mode: 'on', punition: null, annulation: null, seuil: 3, fenetre: 10 },
  'secur owner ajouter': { membre: IDS.users.mod },
  'secur owner retirer': { membre: IDS.users.mod },
  'secur confiance ajouter': { bot: IDS.users.otherBot },
  'secur confiance retirer': { bot: IDS.users.otherBot },
};
