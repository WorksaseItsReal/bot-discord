'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');

module.exports = {
  category: 'security',
  data: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Configuration de l\'AntiRaid.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('enable').setDescription('Active l\'AntiRaid.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactive l\'AntiRaid.'))
    .addSubcommand((s) => s.setName('status').setDescription('Affiche la configuration AntiRaid.'))
    .addSubcommand((s) =>
      s.setName('set').setDescription('Règle les paramètres AntiRaid.')
        .addIntegerOption((o) => o.setName('join_seuil').setDescription('Nb d\'arrivées déclenchant une alerte').setMinValue(2))
        .addIntegerOption((o) => o.setName('join_fenetre').setDescription('Fenêtre en secondes').setMinValue(1))
        .addIntegerOption((o) => o.setName('age_min_jours').setDescription('Âge de compte minimal (jours)').setMinValue(0))
        .addBooleanOption((o) => o.setName('anti_bot').setDescription('Sanctionner les bots ajoutés'))
        .addStringOption((o) => o.setName('action').setDescription('Action sur détection').addChoices({ name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }, { name: 'lockdown', value: 'lockdown' }))
        .addChannelOption((o) => o.setName('alertes').setDescription('Salon d\'alertes').addChannelTypes(ChannelType.GuildText))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'enable' || sub === 'disable') {
      config.update(guildId, { antiraid: { enabled: sub === 'enable' } });
      return interaction.reply(successReply(`AntiRaid **${sub === 'enable' ? 'activé' : 'désactivé'}**.`, { ephemeral: true }));
    }
    if (sub === 'status') {
      const c = config.get(guildId).antiraid;
      return interaction.reply({
        embeds: [embeds.security('🛡️ AntiRaid').setDescription(
          [
            `État : **${c.enabled ? 'activé' : 'désactivé'}**`,
            `Arrivées : **${c.joinThreshold}** / **${c.joinWindowSeconds}s**`,
            `Âge min. compte : **${c.minAccountAgeDays}j**`,
            `Anti-bot : **${c.antiBot ? 'oui' : 'non'}**`,
            `Action : **${c.action}**`,
            `Salon alertes : ${c.alertChannel ? `<#${c.alertChannel}>` : '—'}`,
            `Seuils destructifs : ${c.channelDeleteThreshold} salons / ${c.roleDeleteThreshold} rôles / ${c.banThreshold} bans en ${c.destructiveWindowSeconds}s`,
          ].join('\n'),
        )],
        ephemeral: true,
      });
    }
    if (sub === 'set') {
      const patch = {};
      const map = {
        join_seuil: 'joinThreshold', join_fenetre: 'joinWindowSeconds', age_min_jours: 'minAccountAgeDays',
      };
      for (const [opt, key] of Object.entries(map)) {
        const v = interaction.options.getInteger(opt);
        if (v !== null) patch[key] = v;
      }
      const antiBot = interaction.options.getBoolean('anti_bot');
      if (antiBot !== null) patch.antiBot = antiBot;
      const action = interaction.options.getString('action');
      if (action) patch.action = action;
      const alerts = interaction.options.getChannel('alertes');
      if (alerts) patch.alertChannel = alerts.id;
      config.update(guildId, { antiraid: patch });
      return interaction.reply(successReply('Paramètres AntiRaid mis à jour.', { ephemeral: true }));
    }
  },
};
