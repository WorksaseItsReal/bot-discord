'use strict';

const { SlashCommandBuilder, PermissionsBitField, OAuth2Scopes } = require('discord.js');
const { card, field, ICONS, linkButton, buttonRows, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** Permissions demandées à l'invitation : de quoi faire fonctionner toutes les commandes. */
const INVITE_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions',
  'UseExternalEmojis', 'ManageMessages', 'ManageChannels', 'ManageRoles', 'ManageNicknames', 'ManageThreads', 'KickMembers',
  'BanMembers', 'ModerateMembers', 'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ViewAuditLog', 'SendPolls', 'Connect',
];

/** Emoji du bouton « Inviter » (identique dans /invite, /botinfo et /help). */
const INVITE_EMOJI = '➕';

/** Lien d'invitation du bot, ou null si l'application n'est pas encore prête. */
function inviteUrl(client) {
  try {
    return client.generateInvite({
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      permissions: new PermissionsBitField(INVITE_PERMISSIONS),
    });
  } catch {
    return null;
  }
}

/** Bouton lien « ➕ Inviter », ou null si le lien est indisponible. */
function inviteButton(client) {
  const url = inviteUrl(client);
  return url ? linkButton('Inviter', url, INVITE_EMOJI) : null;
}

module.exports = {
  guildOnly: false,
  INVITE_PERMISSIONS,
  INVITE_EMOJI,
  inviteUrl,
  inviteButton,
  data: new SlashCommandBuilder().setName('invite').setDescription('Obtenir le lien pour inviter le bot sur un serveur.'),
  async execute(interaction, client) {
    const url = inviteUrl(client);
    if (!url) throw new UserError('Le lien d\'invitation n\'est pas encore disponible. Réessayez dans un instant.');
    const embed = card({
      tone: 'brand',
      section: 'utility',
      icon: INVITE_EMOJI,
      title: `Inviter ${client.user.username}`,
      description: [
        `Ajoutez **${client.user.username}** à votre serveur en un clic avec le bouton ci-dessous.`,
        subtext('Il faut la permission « Gérer le serveur » sur le serveur visé.'),
      ],
      thumbnail: client.user.displayAvatarURL({ size: 256 }),
      fields: [
        field(ICONS.moderator, 'Modération', 'Sanctions, logs, automod'),
        field(ICONS.ticket, 'Communauté', 'Tickets, giveaways, rôles'),
        field(ICONS.project, 'Organisation', 'Projets, rappels, outils'),
        field('🔑', 'Permissions', `**${INVITE_PERMISSIONS.length}** demandées, toutes utiles aux fonctionnalités.`, false),
      ],
    });
    await interaction.reply({ embeds: [embed], components: buttonRows(linkButton('Inviter le bot', url, INVITE_EMOJI)), ephemeral: true });
  },
};
