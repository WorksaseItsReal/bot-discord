'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { pick } = require('../../utils/random');
const { card, field, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { UserError } = require('../../core/errors');

const MOVES = {
  pierre: { emoji: '🪨', beats: 'ciseaux' },
  feuille: { emoji: '📄', beats: 'pierre' },
  ciseaux: { emoji: '✂️', beats: 'feuille' },
};
const TITLE = 'Pierre · Feuille · Ciseaux';
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** 1 = joueur gagne, 0 = égalité, -1 = bot gagne. Pur. */
function duel(player, bot) {
  if (player === bot) return 0;
  return MOVES[player].beats === bot ? 1 : -1;
}

/** Score « victoires-nuls-défaites » encodé dans les boutons. Pur, tolérant. */
function parseScore(raw) {
  const m = /^(\d{1,4})-(\d{1,4})-(\d{1,4})$/.exec(String(raw ?? ''));
  return m ? m.slice(1, 4).map(Number) : [0, 0, 0];
}
const scoreArg = ([w, t, l]) => [w, t, l].map((n) => Math.min(n, 9999)).join('-');
const scoreLine = ([w, t, l]) => `**${w}** victoire${w > 1 ? 's' : ''} · **${t}** nul${t > 1 ? 's' : ''} · **${l}** défaite${l > 1 ? 's' : ''}`;

/** Écran de choix du coup. */
function renderBoard(ownerId, score = [0, 0, 0]) {
  const played = score.some(Boolean);
  return {
    embeds: [
      card({
        tone: 'fun',
        section: 'fun',
        icon: '✊',
        title: TITLE,
        description: ['Choisissez votre coup !', played ? subtext(`Score : ${scoreLine(score)}`) : subtext('La pierre bat les ciseaux, qui battent la feuille, qui bat la pierre.')],
      }),
    ],
    components: buttonRows(
      ...Object.entries(MOVES).map(([move, v]) =>
        actionButton({ command: 'pfc', action: 'play', args: [ownerId, move, scoreArg(score)], label: cap(move), emoji: v.emoji }),
      ),
      deleteButton(ownerId),
    ),
  };
}

/** Résultat d'une manche. */
function renderResult(ownerId, player, bot, score) {
  const outcome = duel(player, bot);
  const [w, t, l] = score;
  const next = outcome === 1 ? [w + 1, t, l] : outcome === 0 ? [w, t + 1, l] : [w, t, l + 1];
  const verdict = outcome === 1 ? '🎉 **Vous gagnez !**' : outcome === 0 ? '🤝 **Égalité !**' : '😈 **J\'ai gagné !**';
  return {
    embeds: [
      card({
        tone: outcome === 1 ? 'success' : outcome === 0 ? 'warning' : 'danger',
        section: 'fun',
        icon: '✊',
        title: TITLE,
        description: [verdict, subtext(`Score : ${scoreLine(next)}`)],
        fields: [
          field(ICONS.user, 'Vous', `${MOVES[player].emoji} ${cap(player)}`),
          field(ICONS.bot, 'Moi', `${MOVES[bot].emoji} ${cap(bot)}`),
          field(ICONS.status, 'Manche', outcome === 1 ? 'Gagnée' : outcome === 0 ? 'Nulle' : 'Perdue'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'pfc', action: 'again', args: [ownerId, scoreArg(next)], label: 'Rejouer', emoji: '🔁', style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  guildOnly: false,
  duel,
  parseScore,
  renderBoard,
  renderResult,
  data: new SlashCommandBuilder().setName('pfc').setDescription('Joue à pierre-feuille-ciseaux contre le bot.'),
  async execute(interaction) {
    await interaction.reply(renderBoard(interaction.user.id));
  },
  buttons: {
    /** cmd:pfc:play:<ownerId>:<coup>:<score> — joue une manche. */
    async play(interaction, client, [ownerId, move, score]) {
      assertInvoker(interaction, ownerId, 'Lancez votre propre partie avec `/pfc`.');
      if (!Object.hasOwn(MOVES, move ?? '')) throw new UserError('Coup inconnu. Relancez `/pfc`.');
      await interaction.update(renderResult(ownerId, move, pick(Object.keys(MOVES)), parseScore(score)));
    },
    /** cmd:pfc:again:<ownerId>:<score> — nouvelle manche, score conservé. */
    async again(interaction, client, [ownerId, score]) {
      assertInvoker(interaction, ownerId, 'Lancez votre propre partie avec `/pfc`.');
      await interaction.update(renderBoard(ownerId, parseScore(score)));
    },
  },
};
