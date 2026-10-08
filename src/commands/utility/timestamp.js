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

/**
 * Instant visé par une saisie libre. L'heure française passe AVANT la durée :
 * « 14h », « 14h30 », « 14:30 » ou « 25/12/2026 18h » sont des heures (dans `timeZone`) ;
 * une durée s'écrit avec un signe ou « dans » (« +2h », « dans 3d ») ou sous une forme
 * qui ne peut pas être une heure (« 3d », « 90m », « 36h »).
 * @returns {number|null} timestamp en ms, ou null si la saisie est invalide. Pur.
 */
function parseWhen(input, timeZone = 'Europe/Paris', now = Date.now()) {
  const str = String(input ?? '').trim();
  if (!str) return null;
  const explicit = /^(?:\+|dans\s+)(.+)$/i.exec(str);
  if (explicit) {
    const ms = parseDuration(explicit[1]);
    return ms ? now + ms : null;
  }
  // « 14h » (sans minutes) → « 14h00 », seul ou après une date.
  const asTime = str.replace(/(^|[\sT])(\d{1,2})h$/i, '$1$2h00');
  const local = parseLocalDateTime(asTime, timeZone, now);
  if (local != null) return local;
  const ms = parseDuration(str);
  return ms ? now + ms : null;
}

module.exports = {
  guildOnly: false,
  render,
  parseWhen,
  data: new SlashCommandBuilder()
    .setName('timestamp')
    .setDescription('Génère des timestamps Discord (affichés dans le fuseau de chacun).')
    .addStringOption((o) => o.setName('quand').setDescription('JJ/MM/AAAA HH:MM, 14h30, ou durée (+2h, dans 3d). Défaut : maintenant').setMaxLength(30))
    .addStringOption((o) => o.setName('fuseau').setDescription('Fuseau IANA (défaut : Europe/Paris)').setMaxLength(50)),
  async execute(interaction) {
    const input = interaction.options.getString('quand');
    const timeZone = interaction.options.getString('fuseau') || 'Europe/Paris';
    if (!isValidTimeZone(timeZone)) throw new UserError('Fuseau inconnu. Exemples : `Europe/Paris`, `America/Montreal`, `UTC`.');

    let ts = Date.now();
    if (input) {
      ts = parseWhen(input, timeZone);
      if (ts == null) throw new UserError('Date invalide. Exemples : `25/12/2026 18:30`, `14h30`, `14h`, `+2h`, `dans 3d`.');
    }
    await interaction.reply({ embeds: [render(ts, timeZone)], ephemeral: true });
  },
};
