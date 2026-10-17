'use strict';

const { card, status, ICONS, subtext } = require('../utils/ui');
const { button, row, ButtonStyle } = require('../utils/components');
const { truncate } = require('../utils/embeds');

/**
 * Boutons de participation aux giveaways.
 * customIds : giveaway:enter:<id> (inscription idempotente : un double clic ne
 *             désinscrit jamais) · giveaway:leave:<id> (retrait explicite,
 *             proposé en éphémère à un membre déjà inscrit)
 */
module.exports = {
  id: 'giveaway',
  /** @param {import('discord.js').ButtonInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isButton()) return;
    const [, action, idStr] = interaction.customId.split(':');
    if (action !== 'enter' && action !== 'leave') return;
    const id = Number(idStr);
    // On accuse réception tout de suite (la mise à jour du message peut être lente).
    await interaction.deferReply({ ephemeral: true });
    const { giveaways } = client.services;

    if (action === 'leave') {
      const left = await giveaways.leave(interaction, id);
      const g = giveaways.get(id);
      const prize = g ? truncate(g.prize, 200) : 'ce giveaway';
      return interaction.editReply({
        embeds: [
          left
            ? status.note(`Vous ne participez plus à **${prize}**. Cliquez sur ${ICONS.gift} **Participer** pour revenir.`, 'Participation retirée')
            : status.note(`Vous ne participiez pas à **${prize}**.`, 'Aucune participation'),
        ],
        components: [],
      });
    }

    const joined = await giveaways.enter(interaction, id);
    const g = giveaways.get(id);
    const prize = g ? truncate(g.prize, 200) : 'ce giveaway';
    const draw = g ? subtext(`Tirage <t:${Math.floor(g.ends_at / 1000)}:R> · ${giveaways.countEntries(id)} participant(s)`) : null;
    if (!joined) {
      // Déjà inscrit (double clic, ou second clic volontaire) : rien ne change,
      // le retrait passe par un bouton dédié.
      return interaction.editReply({
        embeds: [
          card({
            tone: 'celebrate',
            section: 'giveaways',
            icon: ICONS.gift,
            title: 'Vous participez déjà',
            description: [`Votre participation à **${prize}** est bien enregistrée.`, draw],
          }),
        ],
        components: [row(button({ id: `giveaway:leave:${id}`, label: 'Se retirer', style: ButtonStyle.Secondary, emoji: '➖' }))],
      });
    }
    return interaction.editReply({
      embeds: [
        card({
          tone: 'celebrate',
          section: 'giveaways',
          icon: ICONS.gift,
          title: 'Participation enregistrée',
          description: [`Vous participez à **${prize}**. Bonne chance !`, draw],
        }),
      ],
    });
  },
};
