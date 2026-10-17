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
 *
 * Blrank (/secur blrank) : un membre listé ne peut recevoir AUCUN rôle. Ses AJOUTS sont ignorés
 * (comptés dans `skipped`, présent seulement s'il n'est pas vide, sans appel à Discord) : rôles
 * d'arrivée, menus, boutique, niveaux, rendus… Les retraits restent appliqués, de même que l'ajout
 * d'un rôle RESTRICTIF (rôle Muted, rôle « non vérifié » en mode retrait : blacklist.restrictiveRoleIds).
 * @param {import('discord.js').GuildMember} member
 * @param {{ add?: string[], remove?: string[] }} changes
 * @param {string} [reason]
 * @param {(roleId: string, error: Error, action: 'add'|'remove') => void} [onError]
 * @returns {Promise<{ added: string[], removed: string[], failed: string[], skipped?: string[] }>}
 */
async function applyRoles(member, { add = [], remove = [] } = {}, reason, onError) {
  const out = { added: [], removed: [], failed: [] };
  let blocked = null; // lu une fois, au premier ajout
  let restrictive = null; // rôles restrictifs, lus une fois pour un membre du blrank
  for (const [action, ids, done] of [['remove', remove, out.removed], ['add', add, out.added]]) {
    for (const id of new Set(ids)) {
      if (action === 'add' && (blocked ??= isRankBlocked(member)) && !(restrictive ??= restrictiveRoles(member)).has(id)) {
        (out.skipped ??= []).push(id);
        continue;
      }
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

/** Membre du blrank (services.blacklist, SEC3) ? Faux si le service est absent ou en erreur. */
function isRankBlocked(member) {
  try {
    return Boolean(member?.guild?.id && member.client?.services?.blacklist?.isRankBlocked?.(member.guild.id, member.id));
  } catch {
    return false;
  }
}

/** Rôles restrictifs du serveur (Muted, « non vérifié » en mode retrait), que le blrank laisse passer. */
function restrictiveRoles(member) {
  try {
    return member?.client?.services?.blacklist?.restrictiveRoleIds?.(member.guild) ?? new Set();
  } catch {
    return new Set();
  }
}

module.exports = { applyRoles, isRankBlocked };
