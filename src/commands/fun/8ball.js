'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, truncate } = require('../../utils/embeds');
const { pick } = require('../../utils/random');

const ANSWERS = [
  ['🟢', 'C\'est certain.'], ['🟢', 'Sans aucun doute.'], ['🟢', 'Oui, absolument.'], ['🟢', 'Tu peux compter dessus.'],
  ['🟢', 'Très probablement.'], ['🟢', 'Les signes disent oui.'], ['🟡', 'Réponse floue, réessaie.'], ['🟡', 'Redemande plus tard.'],
  ['🟡', 'Mieux vaut ne pas te le dire maintenant.'], ['🟡', 'Concentre-toi et redemande.'], ['🔴', 'N\'y compte pas.'],
  ['🔴', 'Ma réponse est non.'], ['🔴', 'Mes sources disent non.'], ['🔴', 'Les perspectives ne sont pas bonnes.'], ['🔴', 'Très peu probable.'],
];

module.exports = {
  guildOnly: false,
  cooldown: 3_000,
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Pose une question à la boule magique.')
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true).setMaxLength(300)),
  async execute(interaction) {
    const question = interaction.options.getString('question');
    const [color, answer] = pick(ANSWERS);
    const embed = embeds
      .fun('🎱 La boule magique a parlé')
      .addFields({ name: '❓ Question', value: truncate(question, 1024) }, { name: `${color} Réponse`, value: `**${answer}**` });
    await interaction.reply({ embeds: [embed] });
  },
};
