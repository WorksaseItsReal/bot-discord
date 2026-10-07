'use strict';

const { SlashCommandBuilder, PermissionsBitField, OAuth2Scopes } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { button, row } = require('../../utils/components');

/** Permissions demandées à l'invitation : de quoi faire fonctionner toutes les commandes. */
const INVITE_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions',
  'UseExternalEmojis', 'ManageMessages', 'ManageChannels', 'ManageRoles', 'ManageNicknames', 'ManageThreads', 'KickMembers',
  'BanMembers', 'ModerateMembers', 'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ViewAuditLog', 'SendPolls', 'Connect',
];

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder().setName('invite').setDescription('Obtenir le lien pour inviter le bot sur un serveur.'),
  async execute(interaction, client) {
    const url = client.generateInvite({
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      permissions: new PermissionsBitField(INVITE_PERMISSIONS),
    });
    const embed = embeds
      .neutral(`✉️ Inviter ${client.user.username}`)
      .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
      .setDescription('Cliquez sur le bouton ci-dessous pour ajouter le bot à votre serveur.\nLes permissions demandées couvrent toutes les fonctionnalités (modération, tickets, projets…).');
    await interaction.reply({ embeds: [embed], components: [row(button({ label: 'Inviter le bot', url, emoji: '➕' }))], ephemeral: true });
  },
};
