'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');

module.exports = {
  category: 'security',
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Verrouillage d\'urgence de tout le serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('enable').setDescription('Active le lockdown (verrouille tous les salons).'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive le lockdown (restaure les salons).'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche l\'état du lockdown.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { lockdown } = client.services;

    if (sub === 'status') {
      const n = lockdown.status(interaction.guild);
      return interaction.reply({ embeds: [embeds.security('🚨 Lockdown').setDescription(n ? `**${n}** salon(s) actuellement verrouillé(s).` : 'Aucun salon verrouillé.')], ephemeral: true });
    }

    if (sub === 'enable') {
      const ok = await confirm(interaction, { description: 'Verrouiller **tous** les salons du serveur ?', confirmLabel: 'Lockdown' });
      if (!ok) return;
      const n = await lockdown.enable(interaction.guild, interaction.member, `Lockdown par ${interaction.user.tag}`);
      return interaction.followUp({ embeds: [embeds.success(`🚨 Lockdown activé — ${n} salon(s) verrouillé(s).`)], ephemeral: true });
    }

    if (sub === 'disable') {
      await interaction.deferReply({ ephemeral: true });
      const n = await lockdown.disable(interaction.guild, interaction.member);
      return interaction.editReply({ embeds: [embeds.success(`🔓 Lockdown levé — ${n} salon(s) déverrouillé(s).`)] });
    }
  },
};
