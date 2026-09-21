'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

/**
 * Commandes personnalisées (tags) gérées par les admins et invoquées via /tag.
 * Le contenu supporte des variables : {user}, {server}, {membercount}.
 */
module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder()
    .setName('custom')
    .setDescription('Gère les commandes personnalisées (tags).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée/modifie un tag.')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du tag').setRequired(true))
        .addStringOption((o) => o.setName('contenu').setDescription('Contenu (variables: {user} {server} {membercount})').setRequired(true))
        .addBooleanOption((o) => o.setName('embed').setDescription('Afficher en embed ?')))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un tag.').addStringOption((o) => o.setName('nom').setDescription('Nom').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les tags.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.customCommands;
    const guildId = interaction.guild.id;

    if (sub === 'create') {
      const name = interaction.options.getString('nom').toLowerCase().replace(/\s+/g, '-').slice(0, 32);
      const content = interaction.options.getString('contenu');
      const isEmbed = interaction.options.getBoolean('embed') ? 1 : 0;
      repo.set({ guildId, name, content, isEmbed, createdBy: interaction.user.id });
      return interaction.reply(successReply(`Tag \`${name}\` enregistré. Utilisez \`/tag ${name}\`.`, { ephemeral: true }));
    }
    if (sub === 'delete') {
      const name = interaction.options.getString('nom').toLowerCase();
      if (!repo.delete(guildId, name)) throw new UserError('Tag introuvable.');
      return interaction.reply(successReply(`Tag \`${name}\` supprimé.`, { ephemeral: true }));
    }
    if (sub === 'list') {
      const list = repo.list(guildId);
      if (!list.length) return interaction.reply({ embeds: [embeds.info('Aucun tag.')], ephemeral: true });
      return interaction.reply({ embeds: [embeds.neutral('🧩 Tags').setDescription(list.map((c) => `\`${c.name}\``).join(', '))], ephemeral: true });
    }
  },

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const list = client.repositories.customCommands.list(interaction.guild.id);
    await interaction.respond(list.filter((c) => c.name.includes(focused)).slice(0, 25).map((c) => ({ name: c.name, value: c.name })));
  },
};
