'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { assertCanModerate } = require('../../utils/permissions');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('derank')
    .setDescription('Retire tous les rôles d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  async execute(interaction) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Membre introuvable.');
    assertCanModerate(interaction.member, member, interaction.guild.members.me, { action: 'dérank' });

    const removable = member.roles.cache.filter((r) => r.id !== interaction.guild.id && r.editable);
    await member.roles.remove(removable, reason || `Derank par ${interaction.user.tag}`);
    await interaction.reply(successReply(`${removable.size} rôle(s) retiré(s) de ${user}.`));
  },
};
