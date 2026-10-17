'use strict';

/**
 * Liste noire, blrank (/secur blacklist|blrank) et mesures d'incident (/lockdown suspendre,
 * reprendre, riposte) — SEC3. Chemin « succès » des explorations : un utilisateur absent du
 * serveur (jamais un membre du banc de test), une entrée déjà en liste noire pour retirer et info.
 */

/** Utilisateur hors du serveur, banni et en liste noire (préparation de retirer / info). */
function listedUser(h) {
  const user = h.addUser('Blackliste', { ageDays: 300 });
  h.fake.bans.set(user.id, { user, reason: 'Blacklist : préparation e2e' });
  h.client.repositories.securityBlacklist.add({ guildId: h.guild.id, userId: user.id, kind: 'ban', reason: 'Préparation e2e', authorId: h.IDS.users.owner, createdAt: Date.now(), nextCheckAt: Date.now() + 6 * 3_600_000 });
  return user.id;
}

module.exports = {
  'secur blacklist ajouter': { membre: (h) => h.addUser('ABlacklister', { ageDays: 300 }).id, raison: 'Raid de test e2e' },
  'secur blacklist retirer': { utilisateur: listedUser, debannir: true },
  'secur blacklist info': { utilisateur: listedUser },
  'secur blrank ajouter': { membre: (h) => h.IDS.users.target, raison: 'Test e2e du blrank' },
  'secur blrank retirer': { membre: (h) => h.IDS.users.target },
  'lockdown suspendre': { invitations: true, messages_prives: false, duree: 6 },
  'lockdown reprendre': { invitations: true, messages_prives: true },
  'lockdown riposte': { actif: true, invitations: true, messages_prives: false, duree: 6 },
};
