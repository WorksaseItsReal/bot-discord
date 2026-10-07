'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, subtext, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 20;

/** Pages de la liste des rôles (triés du plus haut au plus bas). Pur. */
function buildPages(guild, roles) {
  const managed = roles.filter((r) => r.managed).length;
  const hoisted = roles.filter((r) => r.hoist).length;
  const pages = [];
  for (let i = 0; i < roles.length; i += PER_PAGE) {
    const lines = roles.slice(i, i + PER_PAGE).map((r, j) => {
      const tags = [r.managed ? ICONS.bot : '', r.hoist ? ICONS.status : '', r.mentionable ? '🔔' : ''].filter(Boolean).join(' ');
      return `\`${String(i + j + 1).padStart(3, ' ')}\` ${r}${tags ? `  ${tags}` : ''} · ${r.members?.size ?? 0}`;
    });
    pages.push(
      card({
        tone: 'brand',
        section: 'information',
        icon: ICONS.role,
        title: `Rôles de ${guild.name}`,
        description: [...lines, '', subtext(`${ICONS.bot} intégration · ${ICONS.status} affiché séparément · 🔔 mentionnable · nombre de membres en cache`)],
        thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
        fields: [
          field(ICONS.count, 'Total', `**${roles.length}**`),
          field(ICONS.bot, 'Intégrations', `**${managed}**`),
          field(ICONS.status, 'Séparés', `**${hoisted}**`),
        ],
      }),
    );
  }
  return pages;
}

module.exports = {
  buildPages,
  data: new SlashCommandBuilder().setName('roles').setDescription('Liste les rôles du serveur.'),
  async execute(interaction) {
    const guild = interaction.guild;
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
    if (!roles.length) return interaction.reply({ embeds: [status.note('Ce serveur n\'a aucun rôle (hors @everyone).')], ephemeral: true });
    await paginate(interaction, buildPages(guild, roles));
  },
};
