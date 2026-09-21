'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');

const RECOMMENDED_PERMS = [
  ['Bannir des membres', PermissionFlagsBits.BanMembers],
  ['Expulser des membres', PermissionFlagsBits.KickMembers],
  ['Modérer des membres', PermissionFlagsBits.ModerateMembers],
  ['Gérer les messages', PermissionFlagsBits.ManageMessages],
  ['Gérer les rôles', PermissionFlagsBits.ManageRoles],
  ['Gérer les salons', PermissionFlagsBits.ManageChannels],
  ['Voir les logs d\'audit', PermissionFlagsBits.ViewAuditLog],
];

module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder()
    .setName('diagnostics')
    .setDescription('Analyse la configuration du serveur et détecte les problèmes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const { guild } = interaction;
    const me = guild.members.me;
    const cfg = client.services.config.get(guild.id);
    const checks = [];

    // Permissions du bot
    for (const [label, flag] of RECOMMENDED_PERMS) {
      checks.push(`${me.permissions.has(flag) ? '✅' : '⚠️'} Permission : ${label}`);
    }

    // Position du rôle du bot
    const botHighest = me.roles.highest.position;
    const topRole = guild.roles.highest.position;
    checks.push(
      botHighest >= topRole - 1
        ? '✅ Rôle du bot suffisamment haut'
        : '⚠️ Le rôle du bot est bas : il ne pourra pas modérer les rôles élevés',
    );

    // Salons de logs configurés et existants
    const logEntries = Object.entries(cfg.logChannels || {}).filter(([, id]) => id);
    if (!logEntries.length) {
      checks.push('ℹ️ Aucun salon de logs configuré (voir /settings)');
    } else {
      for (const [cat, id] of logEntries) {
        const ok = guild.channels.cache.has(id);
        checks.push(`${ok ? '✅' : '❌'} Salon de logs "${cat}" ${ok ? 'OK' : 'introuvable (supprimé ?)'}`);
      }
    }

    // Strikes
    checks.push(`${cfg.strikes?.enabled ? '✅' : 'ℹ️'} Système de strikes ${cfg.strikes?.enabled ? 'activé' : 'désactivé'}`);

    const problems = checks.filter((c) => c.startsWith('❌') || c.startsWith('⚠️')).length;
    const embed = (problems ? embeds.warning : embeds.success)(
      problems ? `${problems} point(s) d'attention détecté(s).` : 'Aucun problème critique détecté.',
      '🔎 Diagnostics du serveur',
    ).addFields({ name: 'Résultats', value: checks.join('\n').slice(0, 4096) });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
