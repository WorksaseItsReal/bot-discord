'use strict';

const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { card, status, ICONS, subtext } = require('./ui');
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
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel(confirmLabel).setEmoji(ICONS.success).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Annuler').setEmoji(ICONS.error).setStyle(ButtonStyle.Secondary),
    ),
  ];

  const prompt = card({
    tone: 'warning',
    icon: ICONS.warning,
    title: 'Confirmation requise',
    description: [description, '', subtext(`Sans réponse sous ${Math.round(timeout / 1000)} secondes, l'action est annulée.`)],
  });
  const payload = { embeds: [prompt], components, ephemeral: true };
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
    await editPrompt(interaction, message, { embeds: [status.warn('Délai dépassé : action annulée.')], components: [] });
    return false;
  }
  const confirmed = click.customId === confirmId;
  await click
    .update({
      embeds: [confirmed ? status.wait('Confirmé, exécution en cours…') : status.warn('Action annulée. Rien n\'a été modifié.')],
      components: [],
    })
    .catch(() => {});
  // Si l'action échoue ensuite, le gestionnaire d'erreurs remplacera ce message
  // « exécution en cours » par la carte d'erreur (au lieu d'un second message).
  if (confirmed) interaction.pendingConfirmation = { message };
  return confirmed;
}

module.exports = { confirm };
