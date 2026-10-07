'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { UserError } = require('../../core/errors');

/** Limites des sondages natifs Discord. */
const MAX_ANSWERS = 10;
const MAX_ANSWER_LENGTH = 55;

/** « Oui | Non | Peut-être » → réponses nettoyées. Pur. */
function parseAnswers(raw) {
  return [...new Set(String(raw ?? '').split('|').map((s) => s.trim()).filter(Boolean))];
}

module.exports = {
  parseAnswers,
  cooldown: 10_000,
  botPermissions: [PermissionFlagsBits.SendPolls],
  data: new SlashCommandBuilder()
    .setName('sondage')
    .setDescription('Crée un sondage natif Discord (votes et résultats gérés par Discord).')
    .addStringOption((o) => o.setName('question').setDescription('La question').setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName('choix').setDescription('Réponses séparées par | (2 à 10). Défaut : Oui | Non').setMaxLength(600))
    .addIntegerOption((o) => o.setName('duree').setDescription('Durée en heures (1 à 768, défaut 24)').setMinValue(1).setMaxValue(768))
    .addBooleanOption((o) => o.setName('multiple').setDescription('Autoriser plusieurs réponses')),
  async execute(interaction) {
    const question = interaction.options.getString('question');
    const answers = parseAnswers(interaction.options.getString('choix') || 'Oui | Non');
    if (answers.length < 2) throw new UserError('Il faut au moins 2 réponses différentes, séparées par `|`.');
    if (answers.length > MAX_ANSWERS) throw new UserError(`Discord limite les sondages à ${MAX_ANSWERS} réponses.`);
    const tooLong = answers.find((a) => a.length > MAX_ANSWER_LENGTH);
    if (tooLong) throw new UserError(`Réponse trop longue (${MAX_ANSWER_LENGTH} caractères max) : « ${tooLong.slice(0, 60)}… »`);

    await interaction.reply({
      poll: {
        question: { text: question },
        answers: answers.map((text) => ({ text })),
        duration: interaction.options.getInteger('duree') ?? 24,
        allowMultiselect: interaction.options.getBoolean('multiple') ?? false,
      },
    });
  },
};
