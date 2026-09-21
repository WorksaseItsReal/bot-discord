'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { parseDuration, formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Rend muet un membre via le rôle Muted (permanent ou temporaire).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à mute').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 1h, 30m). Vide = permanent'))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const durationStr = interaction.options.getString('duree');
    const reason = interaction.options.getString('raison');
    const durationMs = durationStr ? parseDuration(durationStr) : null;
    if (durationStr && !durationMs) throw new UserError('Durée invalide (ex: `1h`, `30m`).');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    await interaction.deferReply();
    await client.services.moderation.mute(interaction.guild, member, interaction.member, reason, durationMs);
    await interaction.editReply(successReply(`${user.tag} est mute ${durationMs ? `pour **${formatDuration(durationMs)}**` : '**définitivement**'}.`));
  },
};
