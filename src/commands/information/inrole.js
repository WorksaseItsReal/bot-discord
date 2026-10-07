'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, bullets, code, status, subtext } = require('../../utils/ui');
const { paginate } = require('../../utils/pagination');

const PER_PAGE = 20;
/** Délai minimal entre deux téléchargements complets de la liste des membres d'un serveur. */
const FETCH_COOLDOWN_MS = 30_000;
const PARTIAL_NOTE = 'Liste peut-être incomplète : tous les membres n\'ont pas pu être chargés. Réessayez dans 30 secondes.';

/**
 * Charge tous les membres du serveur, sauf si le cache est déjà complet.
 * Un téléchargement au plus toutes les 30 s par serveur (opcode 8 coûteux) :
 * pendant ce délai, on travaille sur le cache.
 * @returns {Promise<{ partial: boolean }>} partial : le cache peut être incomplet
 */
async function ensureMembers(guild, client, time = 20_000) {
  if (guild.members.cache.size >= guild.memberCount) return { partial: false };
  if (client?.cooldowns?.hit(`fetchmembers:${guild.id}`, FETCH_COOLDOWN_MS)) return { partial: true };
  const ok = await guild.members.fetch({ time }).then(() => true, () => false);
  return { partial: !ok };
}

/** Pages de la liste des membres d'un rôle (une carte par tranche de PER_PAGE). Pur. */
function buildPages(role, members, { partial = false } = {}) {
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
          partial ? subtext(PARTIAL_NOTE) : null,
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
  ensureMembers,
  PARTIAL_NOTE,
  data: new SlashCommandBuilder()
    .setName('inrole')
    .setDescription('Liste les membres possédant un rôle.')
    .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)),
  async execute(interaction, client) {
    const role = interaction.options.getRole('role');
    await interaction.deferReply();
    // Liste complète des membres (peut prendre quelques secondes sur un gros serveur).
    const { partial } = await ensureMembers(interaction.guild, client);
    const fullRole = interaction.guild.roles.cache.get(role.id) || role;
    const members = [...(fullRole.members?.values?.() ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
    if (!members.length) {
      return interaction.editReply({
        embeds: [status.note(`Aucun membre n'a le rôle ${role} pour le moment.${partial ? `\n${subtext(PARTIAL_NOTE)}` : ''}`, 'Rôle vide')],
      });
    }
    await paginate(interaction, buildPages(fullRole, members, { partial }));
  },
};
