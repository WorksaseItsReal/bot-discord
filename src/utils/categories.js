'use strict';

/**
 * Métadonnées d'affichage des catégories de commandes (pour /help).
 * L'ordre définit l'ordre d'affichage.
 */
const CATEGORIES = {
  information: { emoji: '📊', label: 'Informations', description: 'Inspecter serveur, membres, rôles, salons.' },
  moderation: { emoji: '🔨', label: 'Modération', description: 'Sanctions et gestion des membres.' },
  configuration: { emoji: '⚙️', label: 'Configuration', description: 'Réglages et diagnostics du serveur.' },
  utility: { emoji: '🔧', label: 'Utilitaires', description: 'Outils divers et pratiques.' },
  security: { emoji: '🛡️', label: 'Sécurité', description: 'AntiRaid, whitelist, lockdown.' },
  automod: { emoji: '🤖', label: 'AutoMod', description: 'Filtres automatiques de messages.' },
  tickets: { emoji: '🎫', label: 'Tickets', description: 'Support et tickets.' },
  giveaways: { emoji: '🎉', label: 'Giveaways', description: 'Concours et tirages.' },
  roles: { emoji: '🎭', label: 'Rôles', description: 'Gestion des rôles.' },
  voice: { emoji: '🔊', label: 'Vocaux', description: 'Gestion des salons vocaux.' },
  fun: { emoji: '🎲', label: 'Fun', description: 'Divertissement.' },
};

function categoryMeta(key) {
  return CATEGORIES[key] || { emoji: '🧩', label: key, description: '—' };
}

module.exports = { CATEGORIES, categoryMeta };
