'use strict';

const { PermissionsBitField } = require('discord.js');

/** Libellés français des permissions Discord les plus courantes. */
const LABELS = {
  Administrator: 'Administrateur',
  ManageGuild: 'Gérer le serveur',
  ManageRoles: 'Gérer les rôles',
  ManageChannels: 'Gérer les salons',
  ManageMessages: 'Gérer les messages',
  ManageNicknames: 'Gérer les pseudos',
  ManageWebhooks: 'Gérer les webhooks',
  ManageThreads: 'Gérer les fils',
  CreatePublicThreads: 'Créer des fils publics',
  CreatePrivateThreads: 'Créer des fils privés',
  ManageGuildExpressions: 'Gérer les expressions',
  ManageEvents: 'Gérer les événements',
  KickMembers: 'Expulser des membres',
  BanMembers: 'Bannir des membres',
  ModerateMembers: 'Exclure temporairement des membres',
  ViewChannel: 'Voir les salons',
  SendMessages: 'Envoyer des messages',
  SendMessagesInThreads: 'Envoyer des messages dans les fils',
  EmbedLinks: 'Intégrer des liens',
  AttachFiles: 'Joindre des fichiers',
  ReadMessageHistory: 'Voir l\'historique des messages',
  AddReactions: 'Ajouter des réactions',
  UseExternalEmojis: 'Utiliser des emojis externes',
  MentionEveryone: 'Mentionner @everyone',
  MuteMembers: 'Rendre muet',
  DeafenMembers: 'Mettre en sourdine',
  MoveMembers: 'Déplacer des membres',
  Connect: 'Se connecter',
  Speak: 'Parler',
  ViewAuditLog: 'Voir les logs du serveur',
  CreateInstantInvite: 'Créer une invitation',
  ChangeNickname: 'Changer de pseudo',
  SendPolls: 'Créer des sondages',
};

/** @param {string} flag nom de flag (ex: 'BanMembers') */
function permissionLabel(flag) {
  return LABELS[flag] || flag.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Permissions manquantes parmi `required`.
 * @param {import('discord.js').PermissionsBitField | null | undefined} have
 * @param {Array<bigint|string>} required
 * @returns {string[]} noms de flags manquants
 */
function missingPermissions(have, required) {
  if (!required?.length) return [];
  if (!have) return [];
  const bits = new PermissionsBitField(have);
  if (bits.has(PermissionsBitField.Flags.Administrator)) return [];
  return new PermissionsBitField(required).toArray().filter((flag) => !bits.has(PermissionsBitField.Flags[flag]));
}

module.exports = { permissionLabel, missingPermissions, LABELS };
