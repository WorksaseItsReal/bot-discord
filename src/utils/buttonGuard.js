'use strict';

const { UserError } = require('../core/errors');

/**
 * Réserve un bouton à la personne qui a lancé la commande.
 * L'identifiant de cette personne est encodé dans le customId du bouton.
 */
function assertInvoker(interaction, ownerId, message = 'Ce bouton est réservé à la personne qui a lancé la commande.') {
  // Échoue fermé : un propriétaire absent du customId n'autorise personne.
  if (!ownerId || interaction.user.id !== ownerId) throw new UserError(message);
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Valide un identifiant Discord reçu dans un customId (contrôlé par le client)
 * et le renvoie. À utiliser AVANT tout appel à l'API Discord.
 */
function snowflake(value, label = 'identifiant') {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw new UserError(`Bouton invalide (${label}).`);
  return value;
}

module.exports = { assertInvoker, snowflake, SNOWFLAKE };
