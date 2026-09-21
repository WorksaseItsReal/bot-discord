'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { row, selectMenu } = require('../../utils/components');
const { UserError } = require('../../core/errors');

/**
 * Crée un menu de rôles auto-attribuables (select menu persistant).
 */
module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('rolemenu')
    .setDescription('Crée un menu de rôles auto-attribuables.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('titre').setDescription('Titre du menu').setRequired(true))
    .addRoleOption((o) => o.setName('role1').setDescription('Rôle 1').setRequired(true))
    .addRoleOption((o) => o.setName('role2').setDescription('Rôle 2'))
    .addRoleOption((o) => o.setName('role3').setDescription('Rôle 3'))
    .addRoleOption((o) => o.setName('role4').setDescription('Rôle 4'))
    .addRoleOption((o) => o.setName('role5').setDescription('Rôle 5')),

  async execute(interaction, client) {
    const title = interaction.options.getString('titre');
    const me = interaction.guild.members.me;
    const roles = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = interaction.options.getRole(`role${i}`);
      if (!r) continue;
      if (r.position >= me.roles.highest.position) throw new UserError(`Le rôle ${r.name} est trop haut pour que je puisse l'attribuer.`);
      roles.push({ roleId: r.id, label: r.name });
    }

    const id = client.repositories.roleMenus.create({
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      data: { title, roles },
    });

    const menu = selectMenu({
      id: `rolemenu:${id}`,
      placeholder: 'Choisissez vos rôles…',
      min: 0,
      max: roles.length,
      options: roles.map((r) => ({ label: r.label, value: r.roleId })),
    });
    const embed = embeds.neutral(`🎭 ${title}`).setDescription('Sélectionnez les rôles à obtenir/retirer.');
    const message = await interaction.channel.send({ embeds: [embed], components: [row(menu)] });
    client.repositories.roleMenus.setMessage(id, message.id);
    await interaction.reply(successReply('Menu de rôles créé.', { ephemeral: true }));
  },
};
