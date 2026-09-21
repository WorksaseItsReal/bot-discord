'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { parseDuration, discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'giveaways',
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Système de giveaways.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un giveaway.')
        .addStringOption((o) => o.setName('recompense').setDescription('Récompense').setRequired(true))
        .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 1h, 2d)').setRequired(true))
        .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de gagnants').setMinValue(1).setMaxValue(20))
        .addRoleOption((o) => o.setName('role_requis').setDescription('Rôle requis pour participer'))
        .addRoleOption((o) => o.setName('role_interdit').setDescription('Rôle interdit')))
    .addSubcommand((s) => s.setName('end').setDescription('Termine un giveaway immédiatement.').addIntegerOption((o) => o.setName('id').setDescription('ID du giveaway').setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Retire de nouveaux gagnants.').addIntegerOption((o) => o.setName('id').setDescription('ID du giveaway').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les giveaways en cours.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { giveaways } = client.services;

    if (sub === 'create') {
      const prize = interaction.options.getString('recompense');
      const durationMs = parseDuration(interaction.options.getString('duree'));
      if (!durationMs) throw new UserError('Durée invalide (ex: `1h`, `2d`).');
      const winners = interaction.options.getInteger('gagnants') || 1;
      const requiredRole = interaction.options.getRole('role_requis')?.id ?? null;
      const forbiddenRole = interaction.options.getRole('role_interdit')?.id ?? null;
      const { id } = await giveaways.create(interaction.channel, interaction.user, { prize, winners, durationMs, requiredRole, forbiddenRole });
      return interaction.reply(successReply(`Giveaway **#${id}** créé pour **${prize}** 🎉`, { ephemeral: true }));
    }

    if (sub === 'end') {
      const id = interaction.options.getInteger('id');
      await giveaways.end(id);
      return interaction.reply(successReply(`Giveaway #${id} terminé.`, { ephemeral: true }));
    }
    if (sub === 'reroll') {
      const id = interaction.options.getInteger('id');
      const winners = await giveaways.end(id, { reroll: true });
      return interaction.reply(successReply(winners.length ? `Nouveaux gagnants tirés.` : 'Aucun participant à retirer.', { ephemeral: true }));
    }
    if (sub === 'list') {
      const active = giveaways.listActive(interaction.guild.id);
      if (!active.length) return interaction.reply({ embeds: [embeds.info('Aucun giveaway en cours.')], ephemeral: true });
      const embed = embeds.neutral('🎉 Giveaways en cours').setDescription(
        active.map((g) => `**#${g.id}** — ${g.prize} · fin ${discordTimestamp(g.ends_at, 'R')} · ${g.winners} gagnant(s)`).join('\n'),
      );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
