'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { formatDuration } = require('../../utils/time');

module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder().setName('health').setDescription('État de santé technique du bot (latence, DB, services).'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    let dbOk = false;
    try {
      client.database.raw.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const mem = process.memoryUsage();
    const embed = embeds.neutral('🩺 État de santé')
      .addFields(
        { name: 'Latence WS', value: `${Math.max(0, Math.round(client.ws.ping))}ms`, inline: true },
        { name: 'Uptime', value: formatDuration(client.uptime), inline: true },
        { name: 'Base de données', value: dbOk ? '✅ OK' : '❌ Erreur', inline: true },
        { name: 'Scheduler', value: client.services.scheduler.timer ? '✅ Actif' : '⚠️ Arrêté', inline: true },
        { name: 'Serveurs', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Mémoire (RSS)', value: `${(mem.rss / 1024 / 1024).toFixed(1)} Mo`, inline: true },
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
