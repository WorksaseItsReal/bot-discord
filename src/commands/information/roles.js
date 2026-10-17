'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, subtext, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 20;

/**
 * Nombre de membres en cache par rôle, en UNE passe sur les membres
 * (Role#members refiltre tout le cache à chaque appel : O(rôles × membres)). Pur.
 * @returns {Map<string, number>}
 */
function countMembersByRole(guild) {
  const counts = new Map();
  for (const member of guild.members?.cache?.values?.() ?? []) {
    for (const roleId of member.roles?.cache?.keys?.() ?? []) counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
  }
  return counts;
}

/** Pages de la liste des rôles (triés du plus haut au plus bas). Pur. */
function buildPages(guild, roles, counts = countMembersByRole(guild)) {
  const managed = roles.filter((r) => r.managed).length;
  const hoisted = roles.filter((r) => r.hoist).length;
  const pages = [];
  for (let i = 0; i < roles.length; i += PER_PAGE) {
    const lines = roles.slice(i, i + PER_PAGE).map((r, j) => {
      const tags = [r.managed ? ICONS.bot : '', r.hoist ? ICONS.status : '', r.mentionable ? '🔔' : ''].filter(Boolean).join(' ');
      return `\`${String(i + j + 1).padStart(3, ' ')}\` ${r}${tags ? `  ${tags}` : ''} · ${counts.get(r.id) ?? 0}`;
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
  countMembersByRole,
  data: new SlashCommandBuilder().setName('roles').setDescription('Liste les rôles du serveur.'),
  async execute(interaction) {
    const guild = interaction.guild;
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
    if (!roles.length) return interaction.reply({ embeds: [status.note('Ce serveur n\'a aucun rôle (hors @everyone).')], ephemeral: true });
    await paginate(interaction, buildPages(guild, roles));
  },
};
