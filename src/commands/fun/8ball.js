'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { pick } = require('../../utils/random');
const { card, wide, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const ANSWERS = [
  ['🟢', 'C\'est certain.'], ['🟢', 'Sans aucun doute.'], ['🟢', 'Oui, absolument.'], ['🟢', 'Tu peux compter dessus.'],
  ['🟢', 'Très probablement.'], ['🟢', 'Les signes disent oui.'], ['🟡', 'Réponse floue, réessaie.'], ['🟡', 'Redemande plus tard.'],
  ['🟡', 'Mieux vaut ne pas te le dire maintenant.'], ['🟡', 'Concentre-toi et redemande.'], ['🔴', 'N\'y compte pas.'],
  ['🔴', 'Ma réponse est non.'], ['🔴', 'Mes sources disent non.'], ['🔴', 'Les perspectives ne sont pas bonnes.'], ['🔴', 'Très peu probable.'],
];

const QUESTION_LABEL = 'Question';

function render(question, ownerId, attempt = 1) {
  const [dot, answer] = pick(ANSWERS);
  return {
    embeds: [
      card({
        tone: 'fun',
        section: 'fun',
        icon: '🎱',
        title: 'La boule magique a parlé',
        description: [`${dot} **${answer}**`, attempt > 1 ? subtext(`Tentative n° ${attempt}`) : null],
        fields: [wide(ICONS.help, QUESTION_LABEL, question)],
      }),
    ],
    components: buttonRows(
      actionButton({ command: '8ball', action: 'again', args: [ownerId, Math.min(attempt + 1, 999)], label: 'Redemander', emoji: '🔮', style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

/** Relit la question depuis la carte affichée (aucune donnée longue dans le customId). */
function questionFrom(message) {
  const f = message?.embeds?.[0]?.fields?.find((x) => x.name?.endsWith(QUESTION_LABEL));
  return f?.value && f.value !== '—' ? f.value : null;
}

module.exports = {
  guildOnly: false,
  cooldown: 3_000,
  render,
  questionFrom,
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Pose une question à la boule magique.')
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true).setMaxLength(300)),
  async execute(interaction) {
    await interaction.reply(render(interaction.options.getString('question'), interaction.user.id));
  },
  buttons: {
    /** cmd:8ball:again:<ownerId>:<tentative> — même question, nouvelle réponse. */
    async again(interaction, client, [ownerId, attempt]) {
      assertInvoker(interaction, ownerId, 'Posez votre propre question avec `/8ball`.');
      const question = questionFrom(interaction.message);
      if (!question) throw new UserError('Impossible de retrouver la question. Relancez `/8ball`.');
      const n = Number.parseInt(attempt, 10);
      await interaction.update(render(question, ownerId, Number.isInteger(n) && n > 1 ? n : 2));
    },
  },
};
