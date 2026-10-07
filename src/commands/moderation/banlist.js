'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, truncate } = require('../../utils/embeds');
const { paginate } = require('../../utils/pagination');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('banlist')
    .setDescription('Affiche la liste des membres bannis.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const bans = await interaction.guild.bans.fetch();
    if (!bans.size) return interaction.editReply({ embeds: [embeds.info('Aucun membre banni.')] });

    const list = [...bans.values()];
    const perPage = 10;
    const pages = [];
    for (let i = 0; i < list.length; i += perPage) {
      const chunk = list.slice(i, i + perPage);
      pages.push(
        embeds.moderation(`Bannissements (${bans.size})`).setDescription(
          truncate(
            chunk
              .map((b) => `• **${b.user.tag}** (\`${b.user.id}\`)\n> ${truncate((b.reason || 'Aucune raison').replace(/\s+/g, ' '), 200)}`)
              .join('\n'),
            4096,
          ),
        ),
      );
    }
    await paginate(interaction, pages, { ephemeral: true });
  },
};
