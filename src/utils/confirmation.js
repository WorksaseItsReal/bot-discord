'use strict';

const { button, row, ButtonStyle } = require('./components');
const { embeds } = require('./embeds');
const { editPrompt } = require('./pagination');

/**
 * Demande de confirmation interactive pour les actions dangereuses.
 * Affiche deux boutons (Confirmer / Annuler) et résout un booléen.
 *
 * @param {import('discord.js').RepliableInteraction} interaction
 * @param {{ description: string, confirmLabel?: string, timeout?: number }} opts
 * @returns {Promise<boolean>}
 */
async function confirm(interaction, opts) {
  const { description, confirmLabel = 'Confirmer', timeout = 30_000 } = opts;
  const confirmId = `confirm:${interaction.id}`;
  const cancelId = `cancel:${interaction.id}`;

  const components = [
    row(
      button({ id: confirmId, label: confirmLabel, style: ButtonStyle.Danger }),
      button({ id: cancelId, label: 'Annuler', style: ButtonStyle.Secondary }),
    ),
  ];

  const payload = { embeds: [embeds.warning(description, 'Confirmation requise')], components, ephemeral: true };
  const message = interaction.deferred || interaction.replied
    ? await interaction.followUp({ ...payload, fetchReply: true })
    : await interaction.reply({ ...payload, fetchReply: true });

  let click;
  try {
    click = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id && [confirmId, cancelId].includes(i.customId),
      time: timeout,
    });
  } catch {
    // Édite le message de confirmation lui-même (souvent un followUp après un deferReply).
    await editPrompt(interaction, message, { embeds: [embeds.warning('Délai dépassé, action annulée.')], components: [] });
    return false;
  }
  const confirmed = click.customId === confirmId;
  await click
    .update({
      embeds: [confirmed ? embeds.info('Action confirmée.') : embeds.warning('Action annulée.')],
      components: [],
    })
    .catch(() => {});
  return confirmed;
}

module.exports = { confirm };
