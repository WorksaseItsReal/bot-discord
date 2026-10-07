'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  botPermissions: [PermissionFlagsBits.ManageNicknames],
  data: new SlashCommandBuilder()
    .setName('pseudo')
    .setDescription('Change ou réinitialise le pseudo d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption((o) => o.setName('pseudo').setDescription('Nouveau pseudo (vide = réinitialiser)').setMaxLength(32)),
  async execute(interaction) {
    const user = interaction.options.getUser('membre');
    const nickname = interaction.options.getString('pseudo')?.trim() || null;
    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError('Ce membre n\'est pas sur le serveur.');
    if (target.id === interaction.guild.ownerId) throw new UserError('Impossible de modifier le pseudo du propriétaire du serveur.');
    const actor = interaction.member;
    if (target.id !== actor.id && actor.id !== interaction.guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
      throw new UserError('Ce membre a un rôle supérieur ou égal au vôtre.');
    }
    if (!target.manageable) throw new UserError('Mon rôle est trop bas pour modifier le pseudo de ce membre.');
    const before = target.nickname;
    await target.setNickname(nickname, `Pseudo modifié par ${interaction.user.tag}`);
    await interaction.reply({
      embeds: [
        embeds
          .success(nickname ? `Pseudo de ${target} modifié.` : `Pseudo de ${target} réinitialisé.`, '✏️ Pseudo')
          .addFields({ name: 'Avant', value: before || '*aucun*', inline: true }, { name: 'Après', value: nickname || '*aucun*', inline: true }),
      ],
      ephemeral: true,
    });
  },
};
