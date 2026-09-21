'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { parseDuration, formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('tempban')
    .setDescription('Bannit temporairement un membre (débannissement automatique).')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 7d, 12h)').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const durationMs = parseDuration(interaction.options.getString('duree'));
    if (!durationMs) throw new UserError('Durée invalide (ex: `7d`, `12h`).');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    await client.services.moderation.ban(interaction.guild, user, interaction.member, reason, { durationMs, targetMember: member });
    await interaction.reply(successReply(`${user.tag} est banni pour **${formatDuration(durationMs)}**.`));
  },
};
