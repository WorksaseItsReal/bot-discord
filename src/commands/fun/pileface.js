'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const SIDES = ['pile', 'face'];
const NO_BET = '-';

function render(bet, ownerId, rng = Math.random) {
  const result = rng() < 0.5 ? 'pile' : 'face';
  const won = bet ? bet === result : null;
  return {
    embeds: [
      card({
        tone: 'fun',
        section: 'fun',
        icon: '🪙',
        title: 'Pile ou face',
        description: [`La pièce tourne… et tombe sur **${result.toUpperCase()}** !`, bet ? null : subtext('Astuce : ajoutez un pari avec l\'option « pari ».')],
        fields: bet
          ? [
              field(ICONS.user, 'Votre pari', `**${bet[0].toUpperCase()}${bet.slice(1)}**`),
              field('🪙', 'Résultat', `**${result[0].toUpperCase()}${result.slice(1)}**`),
              field(ICONS.status, 'Verdict', won ? `${ICONS.success} Gagné !` : `${ICONS.error} Perdu…`),
            ]
          : [],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'pileface', action: 'flip', args: [ownerId, bet || NO_BET], label: 'Relancer', emoji: '🪙', style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  guildOnly: false,
  render,
  data: new SlashCommandBuilder()
    .setName('pileface')
    .setDescription('Lance une pièce : pile ou face ?')
    .addStringOption((o) => o.setName('pari').setDescription('Votre pari').addChoices({ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' })),
  async execute(interaction) {
    await interaction.reply(render(interaction.options.getString('pari'), interaction.user.id));
  },
  buttons: {
    /** cmd:pileface:flip:<ownerId>:<pile|face|-> — relance avec le même pari. */
    async flip(interaction, client, [ownerId, bet]) {
      assertInvoker(interaction, ownerId, 'Lancez votre propre pièce avec `/pileface`.');
      if (bet !== NO_BET && !SIDES.includes(bet)) throw new UserError('Ce bouton est invalide. Relancez `/pileface`.');
      await interaction.update(render(bet === NO_BET ? null : bet, ownerId));
    },
  },
};
