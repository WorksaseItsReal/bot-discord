'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../utils/embeds');

/** Permissions qu'un rôle auto-attribuable ne doit jamais conférer. */
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
];

/**
 * Gestionnaire du select menu de rôles auto-attribuables.
 * customId: `rolemenu:<id>`
 *
 * Le menu est partagé par tous les membres (aucune présélection possible) :
 * chaque rôle SÉLECTIONNÉ est basculé (ajouté s'il manque, retiré sinon).
 * Les rôles non sélectionnés ne sont jamais touchés, et seuls les rôles de CE
 * menu peuvent être modifiés.
 */
module.exports = {
  id: 'rolemenu',
  /** @param {import('discord.js').StringSelectMenuInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isStringSelectMenu()) return;
    await interaction.deferReply({ ephemeral: true });

    const record = client.repositories.roleMenus.getByMessage(interaction.message.id);
    if (!record || record.guild_id !== interaction.guildId) {
      await interaction.reply({ embeds: [embeds.warning('Ce menu de rôles n\'existe plus.')], ephemeral: true });
      return;
    }

    const menuRoles = new Set((record.data?.roles ?? []).map((r) => r.roleId));
    const me = interaction.guild.members.me;
    const added = [];
    const removed = [];
    const failed = [];

    for (const roleId of new Set(interaction.values)) {
      if (!menuRoles.has(roleId)) continue;
      const role = interaction.guild.roles.cache.get(roleId);
      // Rôle supprimé, devenu sensible ou passé au-dessus du bot depuis la création du menu.
      if (!role || role.managed || role.permissions.any(DANGEROUS_PERMISSIONS) || role.position >= me.roles.highest.position) {
        failed.push(roleId);
        continue;
      }
      const has = interaction.member.roles.cache.has(roleId);
      try {
        if (has) {
          await interaction.member.roles.remove(roleId, 'Menu de rôles');
          removed.push(roleId);
        } else {
          await interaction.member.roles.add(roleId, 'Menu de rôles');
          added.push(roleId);
        }
      } catch {
        failed.push(roleId);
      }
    }

    const parts = [];
    if (added.length) parts.push(`Ajouté(s) : ${added.map((r) => `<@&${r}>`).join(', ')}`);
    if (removed.length) parts.push(`Retiré(s) : ${removed.map((r) => `<@&${r}>`).join(', ')}`);
    if (failed.length) parts.push(`Impossible de modifier : ${failed.map((r) => `<@&${r}>`).join(', ')}`);
    await interaction.reply({ embeds: [embeds.success(parts.join('\n') || 'Aucun changement.')], ephemeral: true });
  },
};
