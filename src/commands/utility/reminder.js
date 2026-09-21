'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { parseDuration, discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');

/**
 * Rappels persistants. La livraison est assurée par le SchedulerService,
 * donc les rappels survivent au redémarrage.
 */
module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('reminder')
    .setDescription('Gère vos rappels.')
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un rappel.')
        .addStringOption((o) => o.setName('duree').setDescription('Dans combien de temps ? (ex: 10m, 2h, 1d)').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Message du rappel').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste vos rappels.'))
    .addSubcommand((s) => s.setName('delete').setDescription('Supprime un rappel.').addIntegerOption((o) => o.setName('id').setDescription('ID du rappel').setRequired(true))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.reminders;

    if (sub === 'create') {
      const ms = parseDuration(interaction.options.getString('duree'));
      if (!ms) throw new UserError('Durée invalide (ex: `10m`, `2h`, `1d`).');
      const message = interaction.options.getString('message');
      const remindAt = Date.now() + ms;
      const id = repo.create({ guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, message, remindAt });
      return interaction.reply(successReply(`Rappel **#${id}** créé pour ${discordTimestamp(remindAt)}.`, { ephemeral: true }));
    }
    if (sub === 'list') {
      const list = repo.listByUser(interaction.user.id);
      if (!list.length) return interaction.reply({ embeds: [embeds.info('Vous n\'avez aucun rappel.')], ephemeral: true });
      const embed = embeds.neutral('⏰ Vos rappels').setDescription(
        list.map((r) => `**#${r.id}** — ${discordTimestamp(r.remind_at, 'R')} : ${r.message.slice(0, 100)}`).join('\n'),
      );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (sub === 'delete') {
      const id = interaction.options.getInteger('id');
      if (!repo.delete(id, interaction.user.id)) throw new UserError('Rappel introuvable (ou pas le vôtre).');
      return interaction.reply(successReply(`Rappel #${id} supprimé.`, { ephemeral: true }));
    }
  },
};
