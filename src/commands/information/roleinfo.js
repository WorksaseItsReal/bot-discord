'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Affiche les informations d\'un rôle.')
    .setDMPermission(false)
    .addRoleOption((o) => o.setName('role').setDescription('Le rôle à inspecter').setRequired(true)),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const role = interaction.options.getRole('role');
    const embed = embeds.neutral(`🎭 ${role.name}`)
      .setColor(role.color || undefined)
      .addFields(
        { name: 'ID', value: role.id, inline: true },
        { name: 'Couleur', value: role.hexColor, inline: true },
        { name: 'Membres', value: `${role.members.size}`, inline: true },
        { name: 'Position', value: `${role.position}`, inline: true },
        { name: 'Mentionnable', value: role.mentionable ? 'Oui' : 'Non', inline: true },
        { name: 'Affiché séparément', value: role.hoist ? 'Oui' : 'Non', inline: true },
        { name: 'Créé le', value: discordTimestamp(role.createdTimestamp, 'D'), inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};
