'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { parseColor, formatColor } = require('../../utils/projectFormat');
const { card, field, ICONS, code, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
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

/** Texte lisible sur cette couleur (luminance relative WCAG). Pur. */
function readableText(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.179 ? 'Noir' : 'Blanc';
}

/** Rendu d'une couleur ; `ownerId` non nul = couleur aléatoire (bouton « Autre couleur »). */
function render(value, { random = false, ownerId = null } = {}) {
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const [h, s, l] = toHsl(r, g, b);
  const hex = formatColor(value);
  return {
    embeds: [
      card({
        tone: value,
        section: 'utility',
        icon: ICONS.color,
        title: random ? `${hex} · aléatoire` : hex,
        description: ['La bande à gauche de cette carte affiche la couleur.', subtext('Astuce : collez le code HEX dans /embed ou les paramètres d\'un rôle.')],
        fields: [
          field('#️⃣', 'HEX', code(hex)),
          field('🔴', 'RGB', code(`rgb(${r}, ${g}, ${b})`)),
          field('🌈', 'HSL', code(`hsl(${h}, ${s}%, ${l}%)`)),
          field(ICONS.count, 'Entier', code(value)),
          field('🔤', 'Texte lisible', readableText(r, g, b)),
        ],
      }),
    ],
    components:
      random && ownerId
        ? buttonRows(
            actionButton({ command: 'couleur', action: 'random', args: [ownerId], label: 'Autre couleur', emoji: ICONS.dice, style: ButtonStyle.Primary }),
            deleteButton(ownerId),
          )
        : [],
  };
}

const randomColor = () => Math.floor(Math.random() * 0x1000000);

module.exports = {
  guildOnly: false,
  toHsl,
  readableText,
  render,
  data: new SlashCommandBuilder()
    .setName('couleur')
    .setDescription('Affiche les informations d\'une couleur (ou une couleur aléatoire).')
    .addStringOption((o) => o.setName('hex').setDescription('Code hexadécimal, ex : #5865F2 (vide = aléatoire)').setMaxLength(9)),
  async execute(interaction) {
    const input = interaction.options.getString('hex');
    if (!input) return interaction.reply(render(randomColor(), { random: true, ownerId: interaction.user.id }));
    const value = parseColor(input);
    if (value == null) throw new UserError('Couleur invalide. Exemples : `#5865F2`, `ff0000`, `#0f0`.');
    await interaction.reply(render(value));
  },
  buttons: {
    /** cmd:couleur:random:<ownerId> — tire une nouvelle couleur. */
    async random(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.update(render(randomColor(), { random: true, ownerId }));
    },
  },
};
