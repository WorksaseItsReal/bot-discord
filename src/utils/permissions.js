'use strict';

const { UserError } = require('../core/errors');

/**
 * Vérifications de permissions et de hiérarchie pour les actions de modération.
 * On ne contourne JAMAIS les permissions Discord : ces helpers ajoutent des
 * garde-fous en plus des permissions natives (déclarées sur chaque commande).
 */

/**
 * Détermine si `actor` peut agir sur `target` selon la hiérarchie des rôles.
 * Logique pure pour faciliter les tests.
 * @param {{isOwner:boolean, highestRolePosition:number}} actor
 * @param {{isOwner:boolean, highestRolePosition:number}} target
 * @returns {boolean}
 */
function canActOnByHierarchy(actor, target) {
  if (target.isOwner) return false;
  if (actor.isOwner) return true;
  return actor.highestRolePosition > target.highestRolePosition;
}

/**
 * Garde-fou complet pour une action de modération d'un membre sur un autre.
 * Lance une UserError explicite si l'action est interdite.
 * @param {import('discord.js').GuildMember} moderator
 * @param {import('discord.js').GuildMember} target
 * @param {import('discord.js').GuildMember} me le membre du bot
 * @param {{ action?: string }} [opts]
 */
function assertCanModerate(moderator, target, me, opts = {}) {
  const action = opts.action || 'sanctionner';
  if (!target) throw new UserError('Membre introuvable sur ce serveur.');
  if (target.id === moderator.id) throw new UserError(`Vous ne pouvez pas vous ${action} vous-même.`);
  if (target.id === me.id) throw new UserError(`Je ne peux pas me ${action} moi-même.`);
  if (target.id === target.guild.ownerId) {
    throw new UserError(`Impossible de ${action} le propriétaire du serveur.`);
  }

  const actorInfo = {
    isOwner: moderator.id === moderator.guild.ownerId,
    highestRolePosition: moderator.roles.highest.position,
  };
  const targetInfo = {
    isOwner: target.id === target.guild.ownerId,
    highestRolePosition: target.roles.highest.position,
  };
  if (!canActOnByHierarchy(actorInfo, targetInfo)) {
    throw new UserError(`Vous ne pouvez pas ${action} ce membre : son rôle est supérieur ou égal au vôtre.`);
  }

  // Le bot doit aussi être au-dessus de la cible
  const botInfo = {
    isOwner: me.id === me.guild.ownerId,
    highestRolePosition: me.roles.highest.position,
  };
  if (!canActOnByHierarchy(botInfo, targetInfo)) {
    throw new UserError(`Je ne peux pas ${action} ce membre : mon rôle est trop bas dans la hiérarchie.`);
  }
}

module.exports = { canActOnByHierarchy, assertCanModerate };
