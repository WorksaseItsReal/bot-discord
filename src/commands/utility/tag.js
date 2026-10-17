'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { card, ICONS } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** Nom de tag : lettres (toutes langues), chiffres, « _ » et « - » ; au moins une lettre ou un chiffre. */
const TAG_NAME = /^(?=.*[\p{L}\p{N}])[\p{L}\p{N}_-]{1,32}$/u;

/** Normalise et valide un nom de tag saisi (minuscules, espaces → « - »). */
function normalizeTagName(input) {
  const name = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!TAG_NAME.test(name)) {
    throw new UserError('Nom de tag invalide : 32 caractères maximum, uniquement des lettres, des chiffres, « _ » et « - ».');
  }
  return name;
}

/**
 * Nom à rechercher : normalisé comme à la création (« Mon Tag » → « mon-tag »).
 * Un nom hors format (tag créé avant la validation) est cherché tel quel, en minuscules. Pur.
 */
function lookupTagName(input) {
  try {
    return normalizeTagName(input);
  } catch {
    return String(input ?? '').trim().toLowerCase();
  }
}

/** Substitue les variables supportées dans le contenu d'un tag. */
function renderTag(content, { user, guild }) {
  return content
    .replaceAll('{user}', user.toString())
    .replaceAll('{server}', guild.name)
    .replaceAll('{membercount}', String(guild.memberCount));
}

/** Carte d'un tag (le contenu personnalisé va dans la description). Pur. */
function tagCard(name, content) {
  return card({
    tone: 'neutral',
    section: 'utility',
    icon: ICONS.tag,
    title: name,
    description: truncate(content, 4096) || '*Ce tag est vide.*',
    footer: `Tag · /tag ${truncate(name, 50)}`,
  });
}

module.exports = {
  category: 'utility',
  renderTag,
  tagCard,
  normalizeTagName,
  lookupTagName,
  data: new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Exécute une commande personnalisée (tag).')
    .addStringOption((o) => o.setName('nom').setDescription('Nom du tag').setRequired(true).setAutocomplete(true)),

  async execute(interaction, client) {
    const name = lookupTagName(interaction.options.getString('nom'));
    const tag = client.repositories.customCommands.get(interaction.guild.id, name);
    if (!tag) throw new UserError('Tag introuvable. Voir `/custom list`.');
    const content = renderTag(tag.content, { user: interaction.user, guild: interaction.guild });
    // Le contenu est libre : aucune mention ne doit notifier (@everyone, rôles…).
    await interaction.reply({ embeds: [tagCard(name, content)], allowedMentions: { parse: [] } });
  },

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const list = client.repositories.customCommands.list(interaction.guild.id);
    await interaction.respond(list.filter((c) => c.name.includes(focused)).slice(0, 25).map((c) => ({ name: c.name, value: c.name })));
  },
};
