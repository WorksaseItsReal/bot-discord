'use strict';

const { UserError } = require('../core/errors');

/**
 * Boutons persistants des cartes de sécurité (préfixe « secur: ») :
 *   secur:restore:<incident>            « Rendre les rôles » / « Débannir » (niveau owner)
 *   secur:kickbot:<botId>               « Expulser ce bot » (permission « Expulser »)
 *   secur:grant:<accès>:approve|revoke  accès de whitelist en attente (niveau owner)
 * Chaque gestionnaire revérifie la permission du cliqueur (SecurService).
 */
module.exports = {
  id: 'secur',
  guildOnly: true,
  async execute(interaction, client) {
    const [, action, a, b] = String(interaction.customId).split(':');
    const secur = client.services?.secur;
    if (!secur) throw new UserError('La sécurité est indisponible pour le moment. Réessayez dans un instant.');
    if (action === 'restore') {
      const id = Number(a);
      if (!Number.isSafeInteger(id) || id <= 0) throw new UserError('Ce bouton est invalide.');
      return secur.restore(interaction, id);
    }
    if (action === 'kickbot') return secur.kickBot(interaction, a);
    if (action === 'grant') {
      const id = Number(a);
      if (!Number.isSafeInteger(id) || id <= 0 || (b !== 'approve' && b !== 'revoke')) throw new UserError('Ce bouton est invalide.');
      return secur.decideGrant(interaction, id, b);
    }
    throw new UserError('Ce bouton n\'est plus disponible.');
  },
};
