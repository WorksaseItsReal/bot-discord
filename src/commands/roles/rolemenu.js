'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { row, selectMenu } = require('../../utils/components');
const { UserError } = require('../../core/errors');

/** Permissions qu'un rôle auto-attribuable ne doit jamais conférer. */
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
];

/**
 * Crée un menu de rôles auto-attribuables (select menu persistant).
 */
module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('rolemenu')
    .setDescription('Crée un menu de rôles auto-attribuables.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((o) => o.setName('titre').setDescription('Titre du menu').setRequired(true).setMaxLength(200))
    .addRoleOption((o) => o.setName('role1').setDescription('Rôle 1').setRequired(true))
    .addRoleOption((o) => o.setName('role2').setDescription('Rôle 2'))
    .addRoleOption((o) => o.setName('role3').setDescription('Rôle 3'))
    .addRoleOption((o) => o.setName('role4').setDescription('Rôle 4'))
    .addRoleOption((o) => o.setName('role5').setDescription('Rôle 5')),

  async execute(interaction, client) {
    const title = interaction.options.getString('titre');
    const guild = interaction.guild;
    const me = guild.members.me;
    const isOwner = interaction.user.id === guild.ownerId;
    const roles = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = interaction.options.getRole(`role${i}`);
      if (!r || roles.some((x) => x.roleId === r.id)) continue;
      if (r.id === guild.id) throw new UserError('Le rôle @everyone ne peut pas faire partie d\'un menu de rôles.');
      if (r.managed) throw new UserError(`Le rôle ${r.name} est géré par une intégration et ne peut pas être auto-attribué.`);
      if (r.permissions.any(DANGEROUS_PERMISSIONS)) {
        throw new UserError(`Le rôle ${r.name} possède des permissions sensibles (Administrateur, Gérer le serveur ou Gérer les rôles) : il ne peut pas être auto-attribuable.`);
      }
      if (r.position >= me.roles.highest.position) throw new UserError(`Le rôle ${r.name} est trop haut pour que je puisse l'attribuer.`);
      if (!isOwner && r.position >= interaction.member.roles.highest.position) {
        throw new UserError(`Le rôle ${r.name} est au-dessus (ou égal) à votre rôle le plus haut.`);
      }
      roles.push({ roleId: r.id, label: r.name });
    }

    // Construction (et donc validation) du menu AVANT d'écrire en base, pour
    // ne jamais laisser de ligne orpheline si un validateur lève.
    const menu = selectMenu({
      id: 'rolemenu:pending',
      placeholder: 'Choisissez vos rôles…',
      min: 0,
      max: roles.length,
      options: roles.map((r) => ({ label: r.label, value: r.roleId })),
    });
    const embed = embeds.neutral(`🎭 ${title}`).setDescription('Sélectionnez un rôle pour l\'obtenir, ou resélectionnez-le pour le retirer.');

    const id = client.repositories.roleMenus.create({
      guildId: guild.id,
      channelId: interaction.channel.id,
      data: { title, roles },
    });
    menu.setCustomId(`rolemenu:${id}`);

    let message;
    try {
      message = await interaction.channel.send({ embeds: [embed], components: [row(menu)] });
    } catch (err) {
      client.repositories.roleMenus.delete(id);
      throw err;
    }
    client.repositories.roleMenus.setMessage(id, message.id);
    await interaction.reply(successReply('Menu de rôles créé.', { ephemeral: true }));
  },
};
