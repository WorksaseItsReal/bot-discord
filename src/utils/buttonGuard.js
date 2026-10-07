'use strict';

const { UserError } = require('../core/errors');

/**
 * Réserve un bouton à la personne qui a lancé la commande.
 * L'identifiant de cette personne est encodé dans le customId du bouton.
 */
function assertInvoker(interaction, ownerId, message = 'Ce bouton est réservé à la personne qui a lancé la commande.') {
  if (ownerId && interaction.user.id !== ownerId) throw new UserError(message);
}

module.exports = { assertInvoker };
