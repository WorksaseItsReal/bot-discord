'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { parseDuration } = require('../../utils/time');
const { parseLocalDateTime, isValidTimeZone } = require('../../utils/datetime');
const { UserError } = require('../../core/errors');

const STYLES = [
  ['t', 'Heure courte'],
  ['T', 'Heure longue'],
  ['d', 'Date courte'],
  ['D', 'Date longue'],
  ['f', 'Date et heure'],
  ['F', 'Date et heure complètes'],
  ['R', 'Relatif'],
];

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('timestamp')
    .setDescription('Génère des timestamps Discord (affichés dans le fuseau de chacun).')
    .addStringOption((o) => o.setName('quand').setDescription('JJ/MM/AAAA HH:MM, HH:MM, ou durée (2h, 3d). Défaut : maintenant').setMaxLength(30))
    .addStringOption((o) => o.setName('fuseau').setDescription('Fuseau IANA (défaut : Europe/Paris)').setMaxLength(50)),
  async execute(interaction) {
    const input = interaction.options.getString('quand');
    const timeZone = interaction.options.getString('fuseau') || 'Europe/Paris';
    if (!isValidTimeZone(timeZone)) throw new UserError('Fuseau inconnu. Exemples : `Europe/Paris`, `America/Montreal`, `UTC`.');

    let ts = Date.now();
    if (input) {
      const duration = parseDuration(input);
      ts = duration ? Date.now() + duration : parseLocalDateTime(input, timeZone);
      if (ts == null) throw new UserError('Date invalide. Exemples : `25/12/2026 18:30`, `14:00`, `2h`, `3d`.');
    }
    const unix = Math.floor(ts / 1000);
    const embed = embeds
      .utility('🕒 Timestamps Discord')
      .setDescription(`Copiez le code de votre choix : il s'affichera dans le fuseau horaire de chaque lecteur.\n​`)
      .addFields(STYLES.map(([style, label]) => ({ name: label, value: `<t:${unix}:${style}>\n\`<t:${unix}:${style}>\``, inline: true })))
      .addFields({ name: 'Unix', value: `\`${unix}\``, inline: true });
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
