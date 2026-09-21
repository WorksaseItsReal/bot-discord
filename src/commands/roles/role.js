'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Gestion des rôles.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('add').setDescription('Ajoute un rôle à un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un rôle d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un rôle.')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du rôle').setRequired(true))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)')))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un rôle.')
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les rôles du serveur.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const me = guild.members.me;

    if (sub === 'list') {
      const roles = guild.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
      const embed = embeds.neutral(`🎭 Rôles (${roles.size})`).setDescription(roles.map((r) => `${r} — ${r.members.size} membre(s)`).join('\n').slice(0, 4096) || 'Aucun');
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'create') {
      const name = interaction.options.getString('nom');
      const color = interaction.options.getString('couleur') || undefined;
      const role = await guild.roles.create({ name, color, reason: `Créé par ${interaction.user.tag}` });
      return interaction.reply(successReply(`Rôle ${role} créé.`));
    }

    const role = interaction.options.getRole('role');
    if (role && role.position >= me.roles.highest.position) {
      throw new UserError('Ce rôle est au-dessus (ou égal) au mien : je ne peux pas le gérer.');
    }

    if (sub === 'delete') {
      await role.delete(`Supprimé par ${interaction.user.tag}`);
      return interaction.reply(successReply(`Rôle **${role.name}** supprimé.`));
    }

    const user = interaction.options.getUser('membre');
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Membre introuvable.');

    if (sub === 'add') {
      if (member.roles.cache.has(role.id)) throw new UserError('Le membre a déjà ce rôle.');
      await member.roles.add(role, `Par ${interaction.user.tag}`);
      return interaction.reply(successReply(`${role} ajouté à ${user}.`));
    }
    if (sub === 'remove') {
      if (!member.roles.cache.has(role.id)) throw new UserError('Le membre n\'a pas ce rôle.');
      await member.roles.remove(role, `Par ${interaction.user.tag}`);
      return interaction.reply(successReply(`${role} retiré de ${user}.`));
    }
  },
};
