'use strict';

const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { reportModal, assertNoCooldown } = require('./signalements');

/**
 * Menu contextuel MESSAGE « Signaler le message » (tous les membres) : ouvre le
 * formulaire de signalement (raison facultative). L'envoi est traité par
 * cmd:signalements:submit (enregistrement, carte du staff, log).
 */
module.exports = {
  category: 'moderation',
  description: 'Signale un message à l\'équipe de modération (anonyme vis-à-vis du membre signalé).',
  data: new ContextMenuCommandBuilder().setName('Signaler le message').setType(ApplicationCommandType.Message),

  /** @param {import('discord.js').MessageContextMenuCommandInteraction} interaction */
  async execute(interaction, client) {
    const { reports } = client.services;
    reports.assertAvailable(interaction.guild);
    reports.assertReportable(interaction.guildId, interaction.user.id, interaction.targetMessage);
    assertNoCooldown(client, interaction.user.id);
    await interaction.showModal(reportModal(interaction.targetMessage.channelId, interaction.targetId));
  },
};
