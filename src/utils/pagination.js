'use strict';

const { button, row, ButtonStyle } = require('./components');

/**
 * Pagination interactive à partir d'une liste de pages (EmbedBuilder[]).
 * Gère les boutons précédent/suivant et désactive les composants à la fin.
 *
 * @param {import('discord.js').RepliableInteraction} interaction
 * @param {import('discord.js').EmbedBuilder[]} pages
 * @param {{ timeout?: number, ephemeral?: boolean }} [opts]
 */
async function paginate(interaction, pages, opts = {}) {
  const { timeout = 120_000, ephemeral = false } = opts;
  if (!pages.length) throw new Error('paginate: aucune page fournie');

  let index = 0;
  const prevId = `page:prev:${interaction.id}`;
  const nextId = `page:next:${interaction.id}`;

  const controls = (disabled = false) =>
    pages.length > 1
      ? [
          row(
            button({ id: prevId, label: '◀', style: ButtonStyle.Secondary, disabled: disabled || index === 0 }),
            button({ id: nextId, label: '▶', style: ButtonStyle.Secondary, disabled: disabled || index === pages.length - 1 }),
          ),
        ]
      : [];

  const render = () => ({ embeds: [pages[index].setFooter({ text: `Page ${index + 1}/${pages.length}` })], components: controls() });

  const message = interaction.deferred || interaction.replied
    ? await interaction.followUp({ ...render(), ephemeral, fetchReply: true })
    : await interaction.reply({ ...render(), ephemeral, fetchReply: true });

  if (pages.length <= 1) return;

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id && [prevId, nextId].includes(i.customId),
    time: timeout,
  });

  collector.on('collect', async (i) => {
    index = i.customId === nextId ? Math.min(index + 1, pages.length - 1) : Math.max(index - 1, 0);
    await i.update(render());
  });

  collector.on('end', async () => {
    await interaction.editReply({ components: controls(true) }).catch(() => {});
  });
}

module.exports = { paginate };
