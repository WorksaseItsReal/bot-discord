'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

/**
 * Découpe une liste de composants en rows de 5 (limite Discord).
 * @param {import('discord.js').AnyComponentBuilder[]} components
 */
function rows(components) {
  const out = [];
  for (let i = 0; i < components.length; i += 5) {
    out.push(row(...components.slice(i, i + 5)));
  }
  return out;
}

function selectMenu({ id, placeholder, options, min = 1, max = 1 }) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setMinValues(min)
    .setMaxValues(max)
    .addOptions(
      options.map((o) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(o.label)
          .setValue(o.value)
          .setDescription(o.description?.slice(0, 100) ?? null)
          .setEmoji(o.emoji ?? null)
          .setDefault(Boolean(o.default)),
      ),
    );
  return menu;
}

module.exports = { button, row, rows, selectMenu, ButtonStyle };
