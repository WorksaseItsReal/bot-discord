'use strict';

const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { brandFooter } = require('./embeds');
const { ICONS, deleteButton } = require('./ui');

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
  const ids = {
    first: `page:first:${interaction.id}`,
    prev: `page:prev:${interaction.id}`,
    label: `page:label:${interaction.id}`,
    next: `page:next:${interaction.id}`,
    last: `page:last:${interaction.id}`,
  };
  const nav = (id, emoji, disabled) => new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(ButtonStyle.Secondary).setDisabled(disabled);

  // ⏮ ◀ [ 2 / 5 ] ▶ ⏭  (+ 🗑️ sur les messages publics)
  const controls = (disabled = false) => {
    const buttons = [];
    if (pages.length > 1) {
      if (pages.length > 2) buttons.push(nav(ids.first, ICONS.first, disabled || index === 0));
      buttons.push(nav(ids.prev, ICONS.back, disabled || index === 0));
      buttons.push(new ButtonBuilder().setCustomId(ids.label).setLabel(`${index + 1} / ${pages.length}`).setStyle(ButtonStyle.Primary).setDisabled(true));
      buttons.push(nav(ids.next, ICONS.next, disabled || index === pages.length - 1));
      if (pages.length > 2) buttons.push(nav(ids.last, ICONS.last, disabled || index === pages.length - 1));
    }
    const rows = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
    if (!ephemeral) {
      if (rows.length && buttons.length < 5) rows[0].addComponents(deleteButton(interaction.user.id));
      else rows.push(new ActionRowBuilder().addComponents(deleteButton(interaction.user.id)));
    }
    return rows;
  };

  // Conserve le texte de pied de page propre à chaque page et y ajoute « Page x/y ».
  const baseFooters = pages.map((p) => p.data?.footer?.text?.split(' • ').slice(1).join(' • ') || '');
  const render = () => {
    const extra = baseFooters[index] ? `${baseFooters[index]} • ` : '';
    const footer = pages.length > 1 ? `${extra}Page ${index + 1}/${pages.length}` : baseFooters[index] || undefined;
    return { embeds: [pages[index].setFooter(brandFooter(footer))], components: controls() };
  };

  const message = interaction.deferred || interaction.replied
    ? await interaction.followUp({ ...render(), ephemeral, fetchReply: true })
    : await interaction.reply({ ...render(), ephemeral, fetchReply: true });

  if (pages.length <= 1) return;


  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id && [ids.first, ids.prev, ids.next, ids.last].includes(i.customId),
    time: timeout,
  });

  collector.on('collect', async (i) => {
    if (i.customId === ids.first) index = 0;
    else if (i.customId === ids.last) index = pages.length - 1;
    else if (i.customId === ids.next) index = Math.min(index + 1, pages.length - 1);
    else index = Math.max(index - 1, 0);
    await i.update(render());
  });

  collector.on('end', async () => {
    // On édite le message de pagination LUI-MÊME (qui peut être un followUp),
    // pas forcément la réponse d'origine de l'interaction.
    // Fin de navigation : seules restent les commandes encore utiles (🗑️).
    await editPrompt(interaction, message, { components: ephemeral ? [] : [new ActionRowBuilder().addComponents(deleteButton(interaction.user.id))] });
  });
}

/**
 * Édite le message `message` envoyé via l'interaction (réponse d'origine ou
 * followUp, éphémère ou non) ; repli sur message.edit().
 */
async function editPrompt(interaction, message, payload) {
  try {
    await interaction.editReply({ ...payload, message: message?.id ?? '@original' });
  } catch {
    await message?.edit?.(payload).catch(() => {});
  }
}

module.exports = { paginate, editPrompt };
