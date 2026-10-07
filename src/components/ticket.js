'use strict';

const { embeds } = require('../utils/embeds');

/**
 * Boutons persistants du système de tickets.
 * customIds : ticket:create | ticket:claim | ticket:close
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
      return interaction.editReply({ embeds: [embeds.success(`Votre ticket a été créé : ${channel}`)] });
    }
    if (action === 'claim') {
      await tickets.claim(interaction.channel, interaction.member);
      return interaction.reply({ embeds: [embeds.success(`Ticket réclamé par ${interaction.user}.`)], ephemeral: true });
    }
    if (action === 'close') {
      // Un second clic pendant le délai est refusé par le service (UserError).
      await tickets.close(interaction.channel, interaction.user, {
        delayMs: 3000,
        onAccepted: () => interaction.reply({ embeds: [embeds.warning('Fermeture du ticket dans 3 secondes…')], ephemeral: true }),
      });
    }
  },
};
