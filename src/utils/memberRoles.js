'use strict';

/**
 * Ajout / retrait de rôles UN PAR UN, par les routes de Discord dédiées à un rôle
 * (PUT / DELETE /guilds/:id/members/:id/roles/:role), atomiques côté Discord.
 *
 * Pourquoi : `member.roles.add([...])` (tableau) envoie un PATCH de la liste
 * COMPLÈTE des rôles calculée depuis le cache, et ce cache n'est pas mis à jour
 * par l'appel précédent. Deux appels successifs (ajout puis retrait), ou un PUT
 * concurrent (rôle Muted réappliqué à l'arrivée), sont alors écrasés.
 *
 * Les retraits passent en premier ; une erreur sur un rôle n'empêche pas les autres.
 * @param {import('discord.js').GuildMember} member
 * @param {{ add?: string[], remove?: string[] }} changes
 * @param {string} [reason]
 * @param {(roleId: string, error: Error, action: 'add'|'remove') => void} [onError]
 * @returns {Promise<{ added: string[], removed: string[], failed: string[] }>}
 */
async function applyRoles(member, { add = [], remove = [] } = {}, reason, onError) {
  const out = { added: [], removed: [], failed: [] };
  for (const [action, ids, done] of [['remove', remove, out.removed], ['add', add, out.added]]) {
    for (const id of new Set(ids)) {
      try {
        await member.roles[action](id, reason);
        done.push(id);
      } catch (err) {
        out.failed.push(id);
        onError?.(id, err, action);
      }
    }
  }
  return out;
}

module.exports = { applyRoles };
