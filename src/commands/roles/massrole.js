'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

/**
 * Ajoute/retire un rôle à TOUS les membres (ou aux humains/bots), par lots pour
 * respecter les rate limits Discord.
 */
module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('massrole')
    .setDescription('Ajoute ou retire un rôle en masse.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle cible').setRequired(true))
    .addStringOption((o) => o.setName('cible').setDescription('Qui ?').addChoices({ name: 'tous', value: 'all' }, { name: 'humains', value: 'humans' }, { name: 'bots', value: 'bots' })),

  async execute(interaction) {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    const target = interaction.options.getString('cible') || 'all';
    if (role.position >= interaction.guild.members.me.roles.highest.position) {
      throw new UserError('Ce rôle est trop haut pour que je puisse le gérer.');
    }

    await interaction.deferReply();
    const members = await interaction.guild.members.fetch();
    const filtered = members.filter((m) => {
      if (target === 'humans' && m.user.bot) return false;
      if (target === 'bots' && !m.user.bot) return false;
      return action === 'add' ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id);
    });

    let done = 0;
    let failed = 0;
    const list = [...filtered.values()];
    // Traitement par lots pour éviter les rate limits
    for (let i = 0; i < list.length; i += 5) {
      const batch = list.slice(i, i + 5);
      await Promise.all(
        batch.map((m) =>
          (action === 'add' ? m.roles.add(role) : m.roles.remove(role))
            .then(() => (done += 1))
            .catch(() => (failed += 1)),
        ),
      );
      if (i + 5 < list.length) await new Promise((r) => setTimeout(r, 1000));
    }
    await interaction.editReply({ embeds: [embeds.success(`Terminé : ${done} membre(s) mis à jour${failed ? `, ${failed} échec(s)` : ''}.`)] });
  },
};
