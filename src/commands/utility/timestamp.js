'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { parseDuration } = require('../../utils/time');
const { parseLocalDateTime, isValidTimeZone } = require('../../utils/datetime');
const { card, field, ICONS, code, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** [style, libellé, icône] des formats de timestamp Discord. */
const STYLES = [
  ['t', 'Heure courte', ICONS.time],
  ['T', 'Heure longue', ICONS.time],
  ['R', 'Relatif', ICONS.duration],
  ['d', 'Date courte', ICONS.date],
  ['D', 'Date longue', ICONS.date],
  ['f', 'Date et heure', ICONS.date],
  ['F', 'Complet', ICONS.date],
];

/** Carte des timestamps pour un instant donné (ms). Pur. */
function render(ts, timeZone) {
  const unix = Math.floor(ts / 1000);
  return card({
    tone: 'info',
    section: 'utility',
    icon: ICONS.time,
    title: 'Timestamps Discord',
    description: [
      `<t:${unix}:F> · <t:${unix}:R>`,
      subtext(`Copiez un code : chaque lecteur le verra dans son propre fuseau. Saisie interprétée en ${timeZone}.`),
    ],
    fields: [
      ...STYLES.map(([style, label, icon]) => field(icon, label, `<t:${unix}:${style}>\n${code(`<t:${unix}:${style}>`)}`)),
      field(ICONS.count, 'Unix', code(unix)),
    ],
  });
}

module.exports = {
  guildOnly: false,
  render,
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
    await interaction.reply({ embeds: [render(ts, timeZone)], ephemeral: true });
  },
};
