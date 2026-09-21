'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

/** Substitue les variables supportées dans le contenu d'un tag. */
function renderTag(content, { user, guild }) {
  return content
    .replaceAll('{user}', user.toString())
    .replaceAll('{server}', guild.name)
    .replaceAll('{membercount}', String(guild.memberCount));
}

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Exécute une commande personnalisée (tag).')
    .setDMPermission(false)
    .addStringOption((o) => o.setName('nom').setDescription('Nom du tag').setRequired(true).setAutocomplete(true)),

  async execute(interaction, client) {
    const name = interaction.options.getString('nom').toLowerCase();
    const tag = client.repositories.customCommands.get(interaction.guild.id, name);
    if (!tag) throw new UserError('Tag introuvable. Voir `/custom list`.');
    const content = renderTag(tag.content, { user: interaction.user, guild: interaction.guild });
    if (tag.is_embed) return interaction.reply({ embeds: [embeds.neutral(name).setDescription(content)] });
    return interaction.reply({ content });
  },

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const list = client.repositories.customCommands.list(interaction.guild.id);
    await interaction.respond(list.filter((c) => c.name.includes(focused)).slice(0, 25).map((c) => ({ name: c.name, value: c.name })));
  },
};

module.exports.renderTag = renderTag;
