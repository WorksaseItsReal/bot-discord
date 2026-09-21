'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { row, selectMenu } = require('../../utils/components');
const { CATEGORIES, categoryMeta } = require('../../utils/categories');

/**
 * /help interactif : un menu déroulant liste les catégories ; la sélection
 * affiche les commandes de la catégorie avec description et permissions.
 */
module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Affiche le menu d\'aide interactif du bot.')
    .addStringOption((o) => o.setName('commande').setDescription('Détail d\'une commande précise').setAutocomplete(true)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const specific = interaction.options.getString('commande');
    if (specific) {
      const cmd = client.commands.get(specific);
      if (!cmd) return interaction.reply({ embeds: [embeds.error('Commande inconnue.')], ephemeral: true });
      return interaction.reply({ embeds: [commandDetailEmbed(cmd)], ephemeral: true });
    }

    const grouped = groupByCategory(client.commands);
    const menu = selectMenu({
      id: `help:${interaction.id}`,
      placeholder: 'Choisissez une catégorie…',
      options: [...grouped.keys()].map((key) => ({
        label: categoryMeta(key).label,
        value: key,
        description: categoryMeta(key).description,
        emoji: categoryMeta(key).emoji,
      })),
    });

    const home = embeds.neutral('🕵️ Inspecteur Gadget — Aide')
      .setDescription(
        'Une boîte à outils complète pour administrer votre serveur.\n' +
          'Sélectionnez une catégorie ci-dessous pour voir ses commandes.',
      )
      .addFields(
        [...grouped.entries()].map(([key, cmds]) => ({
          name: `${categoryMeta(key).emoji} ${categoryMeta(key).label}`,
          value: `${cmds.length} commande(s)`,
          inline: true,
        })),
      );

    const message = await interaction.reply({ embeds: [home], components: [row(menu)], fetchReply: true, ephemeral: true });

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId === `help:${interaction.id}`,
      time: 120_000,
    });
    collector.on('collect', async (i) => {
      const key = i.values[0];
      const cmds = grouped.get(key) || [];
      const embed = embeds.neutral(`${categoryMeta(key).emoji} ${categoryMeta(key).label}`)
        .setDescription(
          cmds
            .map((c) => `**/${c.data.name}** — ${c.data.description}`)
            .join('\n') || 'Aucune commande.',
        );
      await i.update({ embeds: [embed], components: [row(menu)] });
    });
    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  /** @param {import('discord.js').AutocompleteInteraction} interaction */
  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = [...client.commands.values()]
      .filter((c) => c.data.name.includes(focused))
      .slice(0, 25)
      .map((c) => ({ name: `/${c.data.name}`, value: c.data.name }));
    await interaction.respond(choices);
  },
};

function groupByCategory(commands) {
  const map = new Map();
  const order = Object.keys(CATEGORIES);
  for (const key of order) {
    const cmds = [...commands.values()].filter((c) => c.category === key);
    if (cmds.length) map.set(key, cmds);
  }
  // Catégories hors liste connue
  for (const cmd of commands.values()) {
    if (!map.has(cmd.category)) map.set(cmd.category, [...commands.values()].filter((c) => c.category === cmd.category));
  }
  return map;
}

function commandDetailEmbed(cmd) {
  const data = cmd.data.toJSON();
  const options = (data.options || [])
    .map((o) => `\`${o.name}\`${o.required ? '' : ' *(optionnel)*'} — ${o.description}`)
    .join('\n');
  return embeds.neutral(`/${data.name}`)
    .setDescription(data.description)
    .addFields(
      { name: 'Catégorie', value: categoryMeta(cmd.category).label, inline: true },
      { name: 'Options', value: options || 'Aucune' },
    );
}
