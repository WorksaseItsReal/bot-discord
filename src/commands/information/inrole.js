'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 25;

module.exports = {
  cooldown: 10_000,
  data: new SlashCommandBuilder()
    .setName('inrole')
    .setDescription('Liste les membres possédant un rôle.')
    .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)),
  async execute(interaction) {
    const role = interaction.options.getRole('role');
    await interaction.deferReply();
    // Récupère la liste complète des membres (peut prendre quelques secondes sur un gros serveur).
    await interaction.guild.members.fetch({ time: 20_000 }).catch(() => null);
    const fullRole = interaction.guild.roles.cache.get(role.id) || role;
    const members = [...(fullRole.members?.values?.() ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
    if (!members.length) {
      return interaction.editReply({ embeds: [embeds.info(`Aucun membre n'a le rôle ${role}.`)] });
    }
    const pages = [];
    for (let i = 0; i < members.length; i += PER_PAGE) {
      pages.push(
        embeds
          .custom(fullRole.color || 0x5865f2, `🎭 ${role.name} — ${members.length} membre${members.length > 1 ? 's' : ''}`)
          .setDescription(members.slice(i, i + PER_PAGE).map((m) => `${m} · \`${m.user.username}\``).join('\n')),
      );
    }
    await paginate(interaction, pages);
  },
};
