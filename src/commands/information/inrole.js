'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, bullets, code, status } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 20;

/** Pages de la liste des membres d'un rôle (une carte par tranche de PER_PAGE). Pur. */
function buildPages(role, members) {
  const bots = members.filter((m) => m.user?.bot).length;
  const pages = [];
  for (let i = 0; i < members.length; i += PER_PAGE) {
    pages.push(
      card({
        tone: role.color || 'brand',
        section: 'information',
        icon: ICONS.role,
        title: `Membres avec ${role.name}`,
        description: [
          `${role} · **${members.length}** membre${members.length > 1 ? 's' : ''}`,
          '',
          bullets(members.slice(i, i + PER_PAGE).map((m) => `${m} · ${code(m.user?.username ?? m.id)}${m.user?.bot ? ` ${ICONS.bot}` : ''}`)),
        ],
        fields: [
          field(ICONS.members, 'Humains', `**${members.length - bots}**`),
          field(ICONS.bot, 'Bots', `**${bots}**`),
          field(ICONS.color, 'Couleur', role.color ? code(role.hexColor.toUpperCase()) : 'Par défaut'),
        ],
      }),
    );
  }
  return pages;
}

module.exports = {
  cooldown: 10_000,
  buildPages,
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
      return interaction.editReply({
        embeds: [status.note(`Aucun membre n'a le rôle ${role} pour le moment.`, 'Rôle vide')],
      });
    }
    await paginate(interaction, buildPages(fullRole, members));
  },
};
