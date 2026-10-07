'use strict';

const { SlashCommandBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { button, row } = require('../../utils/components');
const { pick } = require('../../utils/random');

const MOVES = {
  pierre: { emoji: '🪨', beats: 'ciseaux' },
  feuille: { emoji: '📄', beats: 'pierre' },
  ciseaux: { emoji: '✂️', beats: 'feuille' },
};

/** 1 = joueur gagne, 0 = égalité, -1 = bot gagne. Pur. */
function duel(player, bot) {
  if (player === bot) return 0;
  return MOVES[player].beats === bot ? 1 : -1;
}

module.exports = {
  guildOnly: false,
  duel,
  data: new SlashCommandBuilder().setName('pfc').setDescription('Joue à pierre-feuille-ciseaux contre le bot.'),
  async execute(interaction) {
    const ids = Object.keys(MOVES).map((m) => `pfc:${m}:${interaction.id}`);
    const buttons = (disabled = false) =>
      row(...Object.entries(MOVES).map(([m, v], i) => button({ id: ids[i], label: m[0].toUpperCase() + m.slice(1), emoji: v.emoji, style: ButtonStyle.Primary, disabled })));

    const message = await interaction.reply({
      embeds: [embeds.fun('✊ Pierre · Feuille · Ciseaux').setDescription('Choisis ton coup ! (30 secondes)')],
      components: [buttons()],
      fetchReply: true,
    });

    try {
      const click = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => ids.includes(i.customId) && i.user.id === interaction.user.id,
        time: 30_000,
      });
      const player = click.customId.split(':')[1];
      const bot = pick(Object.keys(MOVES));
      const outcome = duel(player, bot);
      const verdict = outcome === 1 ? '🎉 **Tu gagnes !**' : outcome === 0 ? '🤝 **Égalité !**' : '😈 **J\'ai gagné !**';
      await click.update({
        embeds: [
          embeds
            .custom(outcome === 1 ? 0x57f287 : outcome === 0 ? 0xfee75c : 0xed4245, '✊ Pierre · Feuille · Ciseaux')
            .setDescription(`${MOVES[player].emoji} **${player}** contre ${MOVES[bot].emoji} **${bot}**\n\n${verdict}`),
        ],
        components: [buttons(true)],
      });
    } catch {
      await interaction.editReply({ embeds: [embeds.warning('Temps écoulé, partie annulée.')], components: [buttons(true)] }).catch(() => {});
    }
  },
};
