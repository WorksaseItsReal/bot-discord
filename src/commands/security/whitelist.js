'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, wide, ICONS, status } = require('../../utils/ui');
const { fitList } = require('../../services/LoggingService');

/** Carte de la whitelist, avec une ligne de retour optionnelle en tête. */
function whitelistCard(wl, notice) {
  const users = wl.users ?? [];
  const roles = wl.roles ?? [];
  return card({
    tone: 'info',
    section: 'security',
    icon: '🔐',
    title: 'Whitelist de sécurité',
    description: [
      notice ? `${ICONS.success} ${notice}` : null,
      'Ces membres et rôles échappent aux sanctions automatiques de l\'AntiRaid.',
    ],
    fields: [
      wide(ICONS.user, `Utilisateurs (${users.length})`, fitList(users.map((u) => `<@${u}>`)) ?? '*Aucun*'),
      wide(ICONS.role, `Rôles (${roles.length})`, fitList(roles.map((r) => `<@&${r}>`)) ?? '*Aucun*'),
    ],
  });
}

/**
 * Whitelist de sécurité : les utilisateurs/rôles whitelistés échappent aux
 * sanctions automatiques de l'AntiRaid.
 */
module.exports = {
  category: 'security',
  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Gère la whitelist de sécurité (AntiRaid).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s.setName('add').setDescription('Ajoute un utilisateur ou un rôle.')
        .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur'))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle')))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un utilisateur ou un rôle.')
        .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur'))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle')))
    .addSubcommand((s) => s.setName('list').setDescription('Affiche la whitelist.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;
    const wl = config.get(guildId).whitelist;

    if (sub === 'list') {
      return interaction.reply({ embeds: [whitelistCard(wl)], ephemeral: true });
    }

    const user = interaction.options.getUser('utilisateur');
    const role = interaction.options.getRole('role');
    if (!user && !role) return interaction.reply({ embeds: [status.warn('Indiquez un utilisateur ou un rôle.')], ephemeral: true });

    const users = new Set(wl.users);
    const roles = new Set(wl.roles);
    const add = sub === 'add';
    if (user) add ? users.add(user.id) : users.delete(user.id);
    if (role) add ? roles.add(role.id) : roles.delete(role.id);
    config.update(guildId, { whitelist: { users: [...users], roles: [...roles] } });

    const targets = [user, role].filter(Boolean).map(String).join(' et ');
    const notice = add ? `${targets} ${user && role ? 'ajoutés' : 'ajouté'} à la whitelist.` : `${targets} ${user && role ? 'retirés' : 'retiré'} de la whitelist.`;
    return interaction.reply({ embeds: [whitelistCard({ users: [...users], roles: [...roles] }, notice)], ephemeral: true });
  },
};
