'use strict';

/**
 * Boutons de vote des suggestions.
 * customIds : suggestion:up:<id> | suggestion:down:<id>
 */
module.exports = {
  id: 'suggestion',
  /** @param {import('discord.js').ButtonInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isButton()) return;
    const [, dir, idStr] = interaction.customId.split(':');
    const value = dir === 'up' ? 1 : -1;
    await client.services.suggestions.vote(interaction, Number(idStr), value);
  },
};
