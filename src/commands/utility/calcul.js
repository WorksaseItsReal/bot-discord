'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { evaluate, formatNumber, CalcError } = require('../../utils/calc');
const { card, wide, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** Bloc de code sûr (les accents graves de l'utilisateur sont neutralisés). */
function block(text, lang = '') {
  return `\`\`\`${lang}\n${String(text).replace(/`/g, 'ˋ')}\n\`\`\``;
}

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
    const embed = card({
      tone: 'info',
      section: 'utility',
      icon: '🧮',
      title: 'Calculatrice',
      description: subtext('Opérateurs + − × ÷ % ^ · fonctions sqrt, sin, cos, log, abs… · constantes pi, e'),
      fields: [wide('✏️', 'Expression', block(expression)), wide('🟰', 'Résultat', block(formatNumber(result), 'fix'))],
    });
    await interaction.reply({ embeds: [embed] });
  },
};
