'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { parseDice, rollDice } = require('../../utils/random');
const { card, field, wide, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

/** Notation canonique : { count: 2, sides: 6, modifier: -1 } → « 2d6-1 ». Pur. */
function notationOf({ count, sides, modifier }) {
  return `${count}d${sides}${modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : ''}`;
}

function render(dice, ownerId, rng) {
  const { rolls, total } = rollDice(dice, rng);
  const notation = notationOf(dice);
  const isD20 = dice.count === 1 && dice.sides === 20;
  const crit = isD20 && rolls[0] === 20 ? '💥 Réussite critique !' : isD20 && rolls[0] === 1 ? '💀 Échec critique !' : null;
  const mod = dice.modifier ? ` ${dice.modifier > 0 ? '+' : '−'} ${Math.abs(dice.modifier)}` : '';
  const min = dice.count + dice.modifier;
  const max = dice.count * dice.sides + dice.modifier;
  return {
    embeds: [
      card({
        tone: 'fun',
        section: 'fun',
        icon: ICONS.dice,
        title: `Lancer de ${notation}`,
        description: [`# ${total}`, crit ? `**${crit}**` : null, subtext(`Résultat possible : de ${min} à ${max}`)],
        fields: [
          field(ICONS.count, 'Dés', `**${dice.count}**`),
          field('🎯', 'Faces', `**${dice.sides}**`),
          field('➕', 'Modificateur', dice.modifier ? `**${dice.modifier > 0 ? '+' : ''}${dice.modifier}**` : 'Aucun'),
          dice.count > 1 || dice.modifier ? wide(ICONS.list, 'Détail', truncate(`\`${rolls.join(' · ')}\`${mod}`, 1024)) : null,
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'de', action: 'roll', args: [ownerId, notation], label: 'Relancer', emoji: ICONS.dice, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

const INVALID = 'Notation invalide. Exemples : `d20`, `2d6`, `3d8+2` (100 dés et 1000 faces maximum).';

module.exports = {
  guildOnly: false,
  notationOf,
  render,
  data: new SlashCommandBuilder()
    .setName('de')
    .setDescription('Lance des dés (notation JDR : d20, 2d6, 3d8+2…).')
    .addStringOption((o) => o.setName('lancer').setDescription('Notation des dés (défaut : 1d6)').setMaxLength(20)),
  async execute(interaction) {
    const dice = parseDice(interaction.options.getString('lancer') || '1d6');
    if (!dice) throw new UserError(INVALID);
    await interaction.reply(render(dice, interaction.user.id));
  },
  buttons: {
    /** cmd:de:roll:<ownerId>:<notation> — relance les mêmes dés. */
    async roll(interaction, client, [ownerId, notation]) {
      assertInvoker(interaction, ownerId, 'Lancez vos propres dés avec `/de`.');
      const dice = typeof notation === 'string' && notation.length <= 20 ? parseDice(notation) : null;
      if (!dice) throw new UserError(`${INVALID} Relancez \`/de\`.`);
      await interaction.update(render(dice, ownerId));
    },
  },
};
