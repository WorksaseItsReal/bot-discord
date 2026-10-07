'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 20;

module.exports = {
  data: new SlashCommandBuilder().setName('roles').setDescription('Liste les rôles du serveur.'),
  async execute(interaction) {
    const guild = interaction.guild;
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
    if (!roles.length) return interaction.reply({ embeds: [embeds.info('Ce serveur n\'a aucun rôle (hors @everyone).')], ephemeral: true });
    const pages = [];
    for (let i = 0; i < roles.length; i += PER_PAGE) {
      const lines = roles.slice(i, i + PER_PAGE).map((r, j) => {
        const tags = [r.managed ? '🤖' : '', r.hoist ? '📌' : '', r.mentionable ? '🔔' : ''].filter(Boolean).join('');
        return `\`${String(i + j + 1).padStart(3, ' ')}\` ${r} ${tags}`;
      });
      pages.push(
        embeds
          .neutral(`🎭 Rôles de ${guild.name} (${roles.length})`)
          .setDescription(`${lines.join('\n')}\n\n-# 🤖 géré par une intégration · 📌 affiché séparément · 🔔 mentionnable`),
      );
    }
    await paginate(interaction, pages);
  },
};
