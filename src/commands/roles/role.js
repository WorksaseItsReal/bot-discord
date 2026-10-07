'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

const HEX_COLOR = /^#?[0-9a-f]{6}$/i;

/**
 * Garde-fous anti-escalade : rôle géré/@everyone refusés, et l'auteur doit
 * être strictement au-dessus du rôle (sauf propriétaire du serveur).
 */
function assertManageableRole(interaction, role) {
  const guild = interaction.guild;
  if (role.id === guild.id) throw new UserError('Le rôle @everyone ne peut pas être géré ainsi.');
  if (role.managed) throw new UserError('Ce rôle est géré par une intégration (bot, boost…) et ne peut pas être modifié.');
  if (role.position >= guild.members.me.roles.highest.position) {
    throw new UserError('Ce rôle est au-dessus (ou égal) au mien : je ne peux pas le gérer.');
  }
  const member = interaction.member;
  if (interaction.user.id !== guild.ownerId && role.position >= member.roles.highest.position) {
    throw new UserError('Ce rôle est au-dessus (ou égal) à votre rôle le plus haut : vous ne pouvez pas le gérer.');
  }
}

module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Gestion des rôles.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
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
        .addStringOption((o) => o.setName('nom').setDescription('Nom du rôle').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)')))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un rôle.')
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les rôles du serveur.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'list') {
      const roles = guild.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
      const embed = embeds.neutral(`🎭 Rôles (${roles.size})`).setDescription(roles.map((r) => `${r} — ${r.members.size} membre(s)`).join('\n').slice(0, 4096) || 'Aucun');
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'create') {
      const name = interaction.options.getString('nom');
      const rawColor = interaction.options.getString('couleur')?.trim();
      if (rawColor && !HEX_COLOR.test(rawColor)) {
        throw new UserError('Couleur invalide : utilisez un code hexadécimal comme `#5865F2`.');
      }
      const color = rawColor ? `#${rawColor.replace(/^#/, '')}` : undefined;
      const role = await guild.roles.create({ name, color, reason: `Créé par ${interaction.user.tag}` });
      return interaction.reply(successReply(`Rôle ${role} créé.`));
    }

    const role = interaction.options.getRole('role');
    assertManageableRole(interaction, role);

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
