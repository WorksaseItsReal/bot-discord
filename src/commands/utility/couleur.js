'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { parseColor, formatColor } = require('../../utils/projectFormat');
const { UserError } = require('../../core/errors');

/** RGB → HSL (teinte en degrés, saturation et luminosité en %). Pur. */
function toHsl(r, g, b) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

module.exports = {
  guildOnly: false,
  toHsl,
  data: new SlashCommandBuilder()
    .setName('couleur')
    .setDescription('Affiche les informations d\'une couleur (ou une couleur aléatoire).')
    .addStringOption((o) => o.setName('hex').setDescription('Code hexadécimal, ex : #5865F2 (vide = aléatoire)').setMaxLength(9)),
  async execute(interaction) {
    const input = interaction.options.getString('hex');
    const value = input ? parseColor(input) : Math.floor(Math.random() * 0x1000000);
    if (value == null) throw new UserError('Couleur invalide. Exemples : `#5865F2`, `ff0000`, `#0f0`.');
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    const [h, s, l] = toHsl(r, g, b);
    const embed = embeds
      .custom(value, `🎨 ${formatColor(value)}${input ? '' : ' (aléatoire)'}`)
      .setDescription(`L'embed a pris cette couleur : regardez la bande à gauche !`)
      .addFields(
        { name: 'HEX', value: `\`${formatColor(value)}\``, inline: true },
        { name: 'RGB', value: `\`rgb(${r}, ${g}, ${b})\``, inline: true },
        { name: 'HSL', value: `\`hsl(${h}, ${s}%, ${l}%)\``, inline: true },
        { name: 'Entier (Discord)', value: `\`${value}\``, inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};
