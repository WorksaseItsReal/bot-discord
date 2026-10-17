'use strict';

/**
 * Données « resolved » d'une interaction : discord.js les consulte par la VALEUR de
 * chaque option (`resolved.roles[option.value]`), y compris pour une option texte.
 * Une saisie comme `constructor`, `toString` ou `__proto__` atteignait alors
 * Object.prototype : un rôle, un utilisateur, un membre ou un salon SANS identifiant
 * entrait dans les caches (plantage de /roles, /role list, /diagnostics… jusqu'au
 * redémarrage). Les tables sont recopiées sans prototype avant que discord.js ne
 * construise l'interaction : l'événement `raw` est émis, de façon synchrone, juste
 * avant le traitement du paquet.
 */
const RESOLVED_TABLES = ['users', 'members', 'roles', 'channels', 'attachments', 'messages'];

/** Remplace (sur place) chaque table de `resolved` par une copie sans prototype. */
function neutralizeResolved(resolved) {
  if (!resolved || typeof resolved !== 'object') return resolved;
  for (const key of RESOLVED_TABLES) {
    const table = resolved[key];
    if (table && typeof table === 'object' && Object.getPrototypeOf(table) !== null) {
      resolved[key] = Object.assign(Object.create(null), table);
    }
  }
  return resolved;
}

module.exports = {
  name: 'raw',
  neutralizeResolved,
  execute(client, packet) {
    if (packet?.t === 'INTERACTION_CREATE') neutralizeResolved(packet.d?.data?.resolved);
  },
};
