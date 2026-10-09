'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { pick } = require('../../utils/random');
const { card, wide, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const CHOSEN = '➜';
const OTHER = '›';
const OPTIONS_LABEL = 'options';

/** « pizza | sushi, burger » → options uniques. Pur. */
function parseOptions(raw) {
  return [...new Set(String(raw ?? '').split(/[|,]/).map((s) => s.trim()).filter(Boolean))];
}

/** Liste affichée, une option par ligne ; l'option choisie est marquée. Pur. */
function formatOptions(options, choice) {
  return options.map((o) => (o === choice ? `${CHOSEN} **${o}**` : `${OTHER} ${o}`)).join('\n');
}

/** Relit les options depuis la liste affichée (inverse de formatOptions). Pur. */
function parseDisplayed(value) {
  if (!value || value.endsWith('…')) return null;
  const out = [];
  for (const line of value.split('\n')) {
    if (line.startsWith(`${CHOSEN} **`) && line.endsWith('**')) out.push(line.slice(CHOSEN.length + 3, -2));
    else if (line.startsWith(`${OTHER} `)) out.push(line.slice(OTHER.length + 1));
    else return null;
  }
  return out.length >= 2 ? out : null;
}

function render(options, ownerId, round = 1) {
  const choice = pick(options);
  const list = formatOptions(options, choice);
  // Le bouton relit la liste depuis la carte : on ne le propose que si elle tient entière dans un champ.
  const canReroll = list.length <= 1024;
  return {
    embeds: [
      card({
        tone: 'fun',
        section: 'fun',
        icon: '🤔',
        title: 'Après mûre réflexion…',
        description: [`Je choisis : **${choice}**`, round > 1 ? subtext(`Tirage n° ${round}`) : null],
        fields: [wide(ICONS.list, `Parmi ${options.length} ${OPTIONS_LABEL}`, list)],
      }),
    ],
    components: buttonRows(
      canReroll
        ? actionButton({ command: 'choisir', action: 'again', args: [ownerId, Math.min(round + 1, 999)], label: 'Choisir à nouveau', emoji: '🔁', style: ButtonStyle.Primary })
        : null,
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  guildOnly: false,
  parseOptions,
  formatOptions,
  parseDisplayed,
  render,
  data: new SlashCommandBuilder()
    .setName('choisir')
    .setDescription('Laisse le bot choisir pour toi.')
    .addStringOption((o) => o.setName('options').setDescription('Choix séparés par | ou des virgules (ex: pizza | sushi | burger)').setRequired(true).setMaxLength(1000)),
  async execute(interaction) {
    const options = parseOptions(interaction.options.getString('options'));
    if (options.length < 2) throw new UserError('Donnez au moins deux choix, séparés par `|` ou des virgules.');
    await interaction.reply(render(options, interaction.user.id));
  },
  buttons: {
    /** cmd:choisir:again:<ownerId>:<tirage> — nouveau tirage parmi les mêmes options (relues depuis la carte). */
    async again(interaction, client, [ownerId, round]) {
      assertInvoker(interaction, ownerId, 'Lancez votre propre tirage avec `/choisir`.');
      const f = interaction.message?.embeds?.[0]?.fields?.find((x) => x.name?.includes(OPTIONS_LABEL));
      const options = parseDisplayed(f?.value);
      if (!options) throw new UserError('Impossible de retrouver les options. Relancez `/choisir`.');
      const n = Number.parseInt(round, 10);
      await interaction.update(render(options, ownerId, Number.isInteger(n) && n > 1 ? n : 2));
    },
  },
};
