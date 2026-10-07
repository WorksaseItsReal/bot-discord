'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, truncate } = require('../../utils/embeds');
const { pick } = require('../../utils/random');
const { UserError } = require('../../core/errors');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('choisir')
    .setDescription('Laisse le bot choisir pour toi.')
    .addStringOption((o) => o.setName('options').setDescription('Choix séparés par | ou des virgules (ex: pizza | sushi | burger)').setRequired(true).setMaxLength(1000)),
  async execute(interaction) {
    const raw = interaction.options.getString('options');
    const options = [...new Set(raw.split(/[|,]/).map((s) => s.trim()).filter(Boolean))];
    if (options.length < 2) throw new UserError('Donnez au moins deux choix, séparés par `|` ou des virgules.');
    const choice = pick(options);
    const embed = embeds
      .fun('🤔 Après mûre réflexion…')
      .setDescription(`Je choisis : **${truncate(choice, 500)}**`)
      .addFields({ name: `Parmi ${options.length} options`, value: truncate(options.map((o) => (o === choice ? `**➜ ${o}**` : o)).join(' · '), 1024) });
    await interaction.reply({ embeds: [embed] });
  },
};
