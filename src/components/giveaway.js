'use strict';

const { embeds } = require('../utils/embeds');

/**
 * Bouton de participation aux giveaways.
 * customId : giveaway:enter:<id>
 */
module.exports = {
  id: 'giveaway',
  /** @param {import('discord.js').ButtonInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isButton()) return;
    const [, action, idStr] = interaction.customId.split(':');
    if (action !== 'enter') return;
    // On accuse réception tout de suite (la mise à jour du message peut être lente).
    await interaction.deferReply({ ephemeral: true });
    const joined = await client.services.giveaways.toggleEntry(interaction, Number(idStr));
    await interaction.reply({
      embeds: [joined ? embeds.success('Participation enregistrée ! 🎉') : embeds.warning('Participation retirée.')],
      ephemeral: true,
    });
  },
};
