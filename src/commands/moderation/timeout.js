'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { parseDuration, formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Applique un timeout (mute Discord) à un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à timeout').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 10m, 1h, 1d — max 28d)').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du timeout')),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const durationMs = parseDuration(interaction.options.getString('duree'));
    if (!durationMs) throw new UserError('Durée invalide. Exemples : `10m`, `1h`, `1d`.');

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    await client.services.moderation.timeout(interaction.guild, member, interaction.member, reason, durationMs);
    await interaction.reply(successReply(`${user.tag} est timeout pour **${formatDuration(durationMs)}**.`));
  },
};
