'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { confirm } = require('../../utils/confirmation');

/**
 * Sauvegardes serveur (structure). NOTE : Discord ne permet pas de restaurer
 * les messages ni les membres ; seuls rôles et salons sont recréés.
 */
module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Sauvegarde/restauration de la structure du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Crée une sauvegarde.').addStringOption((o) => o.setName('nom').setDescription('Nom')))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les sauvegardes.'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails d\'une sauvegarde.').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Supprime une sauvegarde.').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) => s.setName('restore').setDescription('Restaure (recrée rôles/salons manquants).').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('auto').setDescription('Active/désactive les sauvegardes automatiques.')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addIntegerOption((o) => o.setName('intervalle_h').setDescription('Intervalle en heures').setMinValue(1))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { backup, config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'create') {
      await interaction.deferReply({ ephemeral: true });
      const { id, data } = backup.create(interaction.guild, interaction.user, interaction.options.getString('nom'));
      return interaction.editReply({ embeds: [embeds.success(`Sauvegarde créée : \`${id}\` (${data.counts.roles} rôles, ${data.counts.channels} salons).`)] });
    }
    if (sub === 'list') {
      const list = backup.list(guildId);
      if (!list.length) return interaction.reply({ embeds: [embeds.info('Aucune sauvegarde.')], ephemeral: true });
      return interaction.reply({
        embeds: [embeds.neutral('💾 Sauvegardes').setDescription(list.map((b) => `\`${b.id}\` — ${b.name} · ${discordTimestamp(b.created_at, 'R')}`).join('\n'))],
        ephemeral: true,
      });
    }
    if (sub === 'info') {
      const b = backup.get(guildId, interaction.options.getString('id'));
      return interaction.reply({
        embeds: [embeds.neutral(`💾 ${b.name}`).addFields(
          { name: 'ID', value: `\`${b.id}\``, inline: true },
          { name: 'Rôles', value: `${b.data.counts.roles}`, inline: true },
          { name: 'Salons', value: `${b.data.counts.channels}`, inline: true },
          { name: 'Créée', value: discordTimestamp(b.created_at), inline: true },
        )],
        ephemeral: true,
      });
    }
    if (sub === 'delete') {
      backup.delete(guildId, interaction.options.getString('id'));
      return interaction.reply(successReply('Sauvegarde supprimée.', { ephemeral: true }));
    }
    if (sub === 'restore') {
      const id = interaction.options.getString('id');
      const ok = await confirm(interaction, {
        description: '⚠️ La restauration recrée les rôles/salons **manquants**. Elle ne supprime rien et ne restaure ni messages ni membres (limite Discord). Continuer ?',
        confirmLabel: 'Restaurer',
      });
      if (!ok) return;
      const res = await backup.restore(interaction.guild, id);
      return interaction.followUp({ embeds: [embeds.success(`Restauration terminée : ${res.roles} rôle(s) et ${res.channels} salon(s) recréés.`)], ephemeral: true });
    }
    if (sub === 'auto') {
      const enabled = interaction.options.getBoolean('actif');
      const interval = interaction.options.getInteger('intervalle_h');
      const patch = { enabled };
      if (interval) patch.intervalHours = interval;
      config.update(guildId, { autobackup: patch });
      return interaction.reply(successReply(`Sauvegardes automatiques **${enabled ? 'activées' : 'désactivées'}**${interval ? ` (toutes les ${interval}h)` : ''}.`, { ephemeral: true }));
    }
  },
};
