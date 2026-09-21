'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { embeds } = require('../../utils/embeds');

const LOG_CATEGORIES = ['moderation', 'messages', 'members', 'roles', 'channels', 'voice', 'security', 'automod'];

module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure le bot pour ce serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('view').setDescription('Affiche la configuration actuelle.'))
    .addSubcommand((s) =>
      s
        .setName('logs')
        .setDescription('Définit le salon de logs d\'une catégorie.')
        .addStringOption((o) =>
          o.setName('categorie').setDescription('Catégorie de logs').setRequired(true).addChoices(
            ...LOG_CATEGORIES.map((c) => ({ name: c, value: c })),
          ),
        )
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Salon cible (laisser vide pour désactiver).').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('moderation')
        .setDescription('Règle les options de modération.')
        .addBooleanOption((o) => o.setName('dm_sanction').setDescription('Envoyer un DM au membre sanctionné.'))
        .addBooleanOption((o) => o.setName('confirmation').setDescription('Demander confirmation pour les actions dangereuses.')),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'view') {
      const cfg = config.get(guildId);
      const logs = Object.entries(cfg.logChannels)
        .map(([k, v]) => `• **${k}** : ${v ? `<#${v}>` : '—'}`)
        .join('\n');
      const embed = embeds.neutral('⚙️ Configuration du serveur').addFields(
        { name: 'Salons de logs', value: logs },
        { name: 'Modération', value: `DM au sanctionné : **${cfg.moderation.dmOnSanction ? 'oui' : 'non'}**\nConfirmation actions dangereuses : **${cfg.moderation.confirmDangerous ? 'oui' : 'non'}**` },
        { name: 'Strikes', value: cfg.strikes.enabled ? cfg.strikes.thresholds.map((t) => `${t.strikes} → ${t.action}${t.duration ? ` (${t.duration})` : ''}`).join('\n') : 'Désactivé' },
      );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'logs') {
      const category = interaction.options.getString('categorie');
      const channel = interaction.options.getChannel('salon');
      config.update(guildId, { logChannels: { [category]: channel?.id ?? null } });
      return interaction.reply(
        { embeds: [embeds.success(channel ? `Logs **${category}** → ${channel}` : `Logs **${category}** désactivés.`)], ephemeral: true },
      );
    }

    if (sub === 'moderation') {
      const patch = {};
      const dm = interaction.options.getBoolean('dm_sanction');
      const confirm = interaction.options.getBoolean('confirmation');
      if (dm !== null) patch.dmOnSanction = dm;
      if (confirm !== null) patch.confirmDangerous = confirm;
      if (!Object.keys(patch).length) return interaction.reply({ embeds: [embeds.warning('Aucune option fournie.')], ephemeral: true });
      config.update(guildId, { moderation: patch });
      return interaction.reply({ embeds: [embeds.success('Options de modération mises à jour.')], ephemeral: true });
    }
  },
};
