'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannit un utilisateur via son ID.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('user_id').setDescription('ID de l\'utilisateur à débannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const userId = interaction.options.getString('user_id').trim();
    if (!/^\d{17,20}$/.test(userId)) throw new UserError('ID utilisateur invalide.');
    const reason = interaction.options.getString('raison');
    await client.services.moderation.unban(interaction.guild, userId, interaction.member, reason);
    await interaction.reply(successReply(`L'utilisateur \`${userId}\` a été débanni.`));
  },
};
