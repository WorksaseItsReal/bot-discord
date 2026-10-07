'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, truncate } = require('../../utils/embeds');
const { evaluate, formatNumber, CalcError } = require('../../utils/calc');
const { UserError } = require('../../core/errors');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('calcul')
    .setDescription('Calculatrice : + - * / % ^, parenthèses, sqrt, sin, cos, log, pi…')
    .addStringOption((o) => o.setName('expression').setDescription('Ex : (2+3)^2 / sqrt(16)').setRequired(true).setMaxLength(200)),
  async execute(interaction) {
    const expression = interaction.options.getString('expression');
    let result;
    try {
      result = evaluate(expression);
    } catch (err) {
      if (err instanceof CalcError) throw new UserError(`Calcul impossible : ${err.message}`);
      throw err;
    }
    const embed = embeds
      .utility('🧮 Calculatrice')
      .addFields(
        { name: 'Expression', value: `\`\`\`\n${truncate(expression, 900)}\n\`\`\`` },
        { name: 'Résultat', value: `\`\`\`fix\n${formatNumber(result)}\n\`\`\`` },
      );
    await interaction.reply({ embeds: [embed] });
  },
};
