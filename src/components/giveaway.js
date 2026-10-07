'use strict';

const { card, status, ICONS, subtext } = require('../utils/ui');
const { truncate } = require('../utils/embeds');

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
    const id = Number(idStr);
    // On accuse réception tout de suite (la mise à jour du message peut être lente).
    await interaction.deferReply({ ephemeral: true });
    const { giveaways } = client.services;
    const joined = await giveaways.toggleEntry(interaction, id);
    const g = giveaways.get(id);
    const prize = g ? truncate(g.prize, 200) : 'ce giveaway';
    await interaction.editReply({
      embeds: [
        joined
          ? card({
              tone: 'celebrate',
              section: 'giveaways',
              icon: ICONS.gift,
              title: 'Participation enregistrée',
              description: [
                `Vous participez à **${prize}**. Bonne chance !`,
                g ? subtext(`Tirage <t:${Math.floor(g.ends_at / 1000)}:R> · ${giveaways.countEntries(id)} participant(s)`) : null,
              ],
            })
          : status.note(`Vous ne participez plus à **${prize}**. Cliquez à nouveau sur 🎉 pour revenir.`, 'Participation retirée'),
      ],
    });
  },
};
