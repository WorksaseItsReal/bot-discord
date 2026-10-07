'use strict';

const { card, ICONS, linkButton, buttonRows } = require('../utils/ui');
const { UserError } = require('../core/errors');

/**
 * Boutons persistants du système de tickets.
 * customIds : ticket:create | ticket:claim | ticket:close | ticket:transcript
 * (les anciens messages ne contiennent que create/claim/close : toujours pris en charge)
 */
module.exports = {
  id: 'ticket',
  /** @param {import('discord.js').ButtonInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isButton()) return;
    const action = interaction.customId.split(':')[1];
    const { tickets } = client.services;

    if (action === 'create') {
      await interaction.deferReply({ ephemeral: true });
      const channel = await tickets.create(interaction.guild, interaction.user);
      return interaction.editReply({
        embeds: [tickets.createdReply(channel)],
        components: channel.url ? buttonRows(linkButton('Accéder au ticket', channel.url, ICONS.ticket)) : [],
      });
    }

    const record = client.repositories.tickets.getByChannel(interaction.channelId);
    if (!record) throw new UserError('Ce salon n\'est plus un ticket actif.');

    if (action === 'claim') {
      // La vérification « support » est refaite par le service.
      await interaction.deferUpdate();
      await tickets.claim(interaction.channel, interaction.member, { message: interaction.message });
      return;
    }
    if (action === 'transcript') {
      tickets.assertParticipant(interaction.member, record);
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply(await tickets.transcriptPayload(interaction.channel));
    }
    if (action === 'close') {
      tickets.assertParticipant(interaction.member, record);
      // Un second clic pendant le délai est refusé par le service (UserError).
      await tickets.close(interaction.channel, interaction.user, {
        delayMs: 5000,
        onAccepted: () =>
          interaction.reply({
            embeds: [card({ tone: 'neutral', icon: ICONS.lock, title: 'Fermeture en cours', description: 'Le ticket sera supprimé dans **5 secondes**.' })],
            ephemeral: true,
          }),
      });
    }
  },
};
