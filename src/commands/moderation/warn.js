'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { parseDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

/**
 * Avertit un membre, incrémente ses strikes et applique automatiquement
 * l'escalade configurée (mute/timeout, kick, ban) si un palier est atteint.
 */
module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Avertit un membre et met à jour ses strikes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à avertir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison de l\'avertissement')),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Ce membre n\'est pas sur le serveur.');

    const { moderation, strikes } = client.services;
    await moderation.warn(interaction.guild, member, interaction.member, reason);
    const { count, action } = strikes.add(interaction.guild.id, user.id, 1);

    let escalation = '';
    if (action && count === action.strikes) {
      escalation = await applyEscalation(client, interaction, member, action, count);
    }

    const embed = embeds.moderation('⚠️ Avertissement').addFields(
      { name: 'Membre', value: `${user}`, inline: true },
      { name: 'Strikes', value: `${count}`, inline: true },
      { name: 'Raison', value: reason || 'Aucune raison fournie' },
    );
    if (escalation) embed.addFields({ name: 'Escalade automatique', value: escalation });
    await interaction.reply({ embeds: [embed] });
  },
};

async function applyEscalation(client, interaction, member, action, count) {
  const { moderation } = client.services;
  const reason = `Escalade automatique (${count} strikes)`;
  try {
    if (action.action === 'mute' || action.action === 'timeout') {
      const ms = parseDuration(action.duration || '1h') || 3_600_000;
      await moderation.timeout(interaction.guild, member, interaction.guild.members.me, reason, ms);
      return `Timeout appliqué (${action.duration || '1h'}).`;
    }
    if (action.action === 'kick') {
      await moderation.kick(interaction.guild, member, interaction.guild.members.me, reason);
      return 'Membre expulsé.';
    }
    if (action.action === 'ban') {
      await moderation.ban(interaction.guild, member.user, interaction.guild.members.me, reason, { targetMember: member });
      return 'Membre banni.';
    }
  } catch (err) {
    return `Échec de l'escalade : ${err.message}`;
  }
  return '';
}
