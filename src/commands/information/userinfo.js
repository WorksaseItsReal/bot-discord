'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');

module.exports = {
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('user')
    .setDescription('Affiche les informations d\'un utilisateur ou membre.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur à inspecter (par défaut vous-même).')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const user = interaction.options.getUser('cible') || interaction.user;
    const member = interaction.guild ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;

    const embed = embeds.neutral(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: user.id, inline: true },
        { name: 'Bot', value: user.bot ? 'Oui' : 'Non', inline: true },
        { name: 'Compte créé', value: discordTimestamp(user.createdTimestamp, 'D'), inline: true },
      );

    if (member) {
      const roles = member.roles.cache.filter((r) => r.id !== interaction.guild.id).map((r) => r.toString());
      embed.addFields(
        { name: 'A rejoint', value: member.joinedTimestamp ? discordTimestamp(member.joinedTimestamp, 'D') : 'Inconnu', inline: true },
        { name: 'Surnom', value: member.nickname || '—', inline: true },
        { name: `Rôles (${roles.length})`, value: roles.join(' ').slice(0, 1024) || 'Aucun' },
      );
    }
    await interaction.reply({ embeds: [embed] });
  },
};
