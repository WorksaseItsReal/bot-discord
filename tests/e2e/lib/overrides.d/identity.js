'use strict';

/**
 * Identité et parole du bot (ADM3) : /embed texte, /settings theme|profil, /bot.
 * Chemin « succès » des explorations automatiques : pas de fichier ni de lien de réponse, pas
 * de mention de masse ; images non fournies (le téléchargement est coupé dans les tests).
 */
module.exports = {
  'embed texte': { message: 'Bonjour depuis le bot', repondre_a: null, fichier: null, mentionner_roles: null, notifier_tous: null },
  'settings theme': { couleur: '#FF8800' },
  'settings profil': { pseudo: 'Gadget e2e', avatar: null, banniere: null, bio: null, reinitialiser: null },
  'bot nom': { nom: 'Gadget e2e' },
  'bot activite': { type: 'joue', texte: 'Tests de bout en bout', url: null },
  'bot statut': { statut: 'inactif' },
  'bot quitter': { serveur: '123456789012345678' },
};
