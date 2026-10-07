'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, truncate } = require('../../utils/embeds');
const { parseDice, rollDice } = require('../../utils/random');
const { UserError } = require('../../core/errors');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('de')
    .setDescription('Lance des dés (notation JDR : d20, 2d6, 3d8+2…).')
    .addStringOption((o) => o.setName('lancer').setDescription('Notation des dés (défaut : 1d6)').setMaxLength(20)),
  async execute(interaction) {
    const notation = interaction.options.getString('lancer') || '1d6';
    const dice = parseDice(notation);
    if (!dice) throw new UserError('Notation invalide. Exemples : `d20`, `2d6`, `3d8+2` (100 dés et 1000 faces maximum).');
    const { rolls, total } = rollDice(dice);
    const mod = dice.modifier ? ` ${dice.modifier > 0 ? '+' : '−'} ${Math.abs(dice.modifier)}` : '';
    const isCrit = dice.count === 1 && dice.sides === 20 && (rolls[0] === 20 || rolls[0] === 1);
    const embed = embeds
      .fun(`🎲 ${dice.count}d${dice.sides}${dice.modifier ? (dice.modifier > 0 ? `+${dice.modifier}` : dice.modifier) : ''}`)
      .setDescription(`# ${total}${isCrit ? (rolls[0] === 20 ? '  💥 Réussite critique !' : '  💀 Échec critique !') : ''}`)
      .addFields({ name: 'Détail', value: truncate(`\`${rolls.join(' · ')}\`${mod}`, 1024) });
    await interaction.reply({ embeds: [embed] });
  },
};
