'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');

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
    .setDMPermission(false)
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
      return interaction.reply({
        embeds: [embeds.security('🔐 Whitelist').addFields(
          { name: 'Utilisateurs', value: wl.users.map((u) => `<@${u}>`).join(' ') || '—' },
          { name: 'Rôles', value: wl.roles.map((r) => `<@&${r}>`).join(' ') || '—' },
        )],
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser('utilisateur');
    const role = interaction.options.getRole('role');
    if (!user && !role) return interaction.reply({ embeds: [embeds.warning('Fournissez un utilisateur ou un rôle.')], ephemeral: true });

    const users = new Set(wl.users);
    const roles = new Set(wl.roles);
    if (user) sub === 'add' ? users.add(user.id) : users.delete(user.id);
    if (role) sub === 'add' ? roles.add(role.id) : roles.delete(role.id);
    config.update(guildId, { whitelist: { users: [...users], roles: [...roles] } });
    return interaction.reply(successReply(`Whitelist mise à jour.`, { ephemeral: true }));
  },
};
