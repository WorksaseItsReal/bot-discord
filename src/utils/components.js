'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

/**
 * Helpers de composants Discord (boutons, menus, rows) pour éviter de
 * recréer la même logique partout.
 */

function button({ id, label, style = ButtonStyle.Secondary, emoji, disabled = false, url }) {
  const b = new ButtonBuilder().setLabel(label).setStyle(url ? ButtonStyle.Link : style);
  if (url) b.setURL(url);
  else b.setCustomId(id);
  if (emoji) b.setEmoji(emoji);
  if (disabled) b.setDisabled(true);
  return b;
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function selectMenu({ id, placeholder, options, min = 1, max = 1 }) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setMinValues(min)
    .setMaxValues(max)
    .addOptions(
      options.map((o) => {
        // Les validateurs des builders lèvent sur null/undefined : on ne
        // renseigne les champs optionnels que lorsqu'ils sont fournis.
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(String(o.label).slice(0, 100) || '—')
          .setValue(String(o.value).slice(0, 100))
          .setDefault(Boolean(o.default));
        if (o.description) option.setDescription(String(o.description).slice(0, 100));
        if (o.emoji) option.setEmoji(o.emoji);
        return option;
      }),
    );
  return menu;
}

/**
 * Remet à zéro un menu déroulant PUBLIC après traitement. Sans cela, le client
 * Discord garde la sélection précédente cochée (réponse éphémère, message
 * jamais réédité) et la renvoie au clic suivant. Rééditer le message avec ses
 * propres composants suffit. Best effort : jamais d'exception.
 * @param {import('discord.js').MessageComponentInteraction} interaction
 */
async function resetSelectMenu(interaction) {
  const message = interaction?.message;
  if (typeof message?.edit !== 'function' || !message.components) return false;
  // Message éphémère : non éditable par l'API des messages.
  if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
  return message.edit({ components: message.components }).then(() => true, () => false);
}

module.exports = { button, row, selectMenu, resetSelectMenu, ButtonStyle };
