'use strict';

const { embeds } = require('../utils/embeds');

/**
 * Gestionnaire du select menu de rôles auto-attribuables.
 * customId: `rolemenu:<id>`
 */
module.exports = {
  id: 'rolemenu',
  /** @param {import('discord.js').StringSelectMenuInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isStringSelectMenu()) return;
    const record = client.repositories.roleMenus.getByMessage(interaction.message.id);
    if (!record) return;

    const selected = new Set(interaction.values);
    const available = record.data.roles.map((r) => r.roleId);
    const added = [];
    const removed = [];

    for (const roleId of available) {
      const has = interaction.member.roles.cache.has(roleId);
      if (selected.has(roleId) && !has) {
        await interaction.member.roles.add(roleId).then(() => added.push(roleId)).catch(() => {});
      } else if (!selected.has(roleId) && has) {
        await interaction.member.roles.remove(roleId).then(() => removed.push(roleId)).catch(() => {});
      }
    }

    const parts = [];
    if (added.length) parts.push(`Ajouté(s) : ${added.map((r) => `<@&${r}>`).join(', ')}`);
    if (removed.length) parts.push(`Retiré(s) : ${removed.map((r) => `<@&${r}>`).join(', ')}`);
    await interaction.reply({ embeds: [embeds.success(parts.join('\n') || 'Aucun changement.')], ephemeral: true });
  },
};
