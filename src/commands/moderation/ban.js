'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds, successReply } = require('../../utils/embeds');
const { confirm } = require('../../utils/confirmation');
const { parseDuration, formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannit un membre (définitivement ou temporairement).')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à bannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du bannissement'))
    .addStringOption((o) => o.setName('duree').setDescription('Durée (ex: 7d, 12h). Vide = permanent'))
    .addIntegerOption((o) =>
      o.setName('purge_jours').setDescription('Supprimer les messages des X derniers jours (0-7)').setMinValue(0).setMaxValue(7),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const durationStr = interaction.options.getString('duree');
    const purgeDays = interaction.options.getInteger('purge_jours') ?? 0;

    const durationMs = durationStr ? parseDuration(durationStr) : null;
    if (durationStr && !durationMs) throw new UserError('Durée invalide. Exemples valides : `7d`, `12h`, `1h30m`.');

    const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
    const cfg = client.services.config.get(interaction.guild.id);

    if (cfg.moderation.confirmDangerous) {
      const ok = await confirm(interaction, {
        description: `Bannir ${user} ${durationMs ? `pour **${formatDuration(durationMs)}**` : '**définitivement**'} ?`,
        confirmLabel: 'Bannir',
      });
      if (!ok) return;
    }

    await client.services.moderation.ban(interaction.guild, user, interaction.member, reason, {
      durationMs,
      deleteMessageSeconds: purgeDays * 86400,
      targetMember,
    });

    const suffix = durationMs ? `pour **${formatDuration(durationMs)}**` : 'définitivement';
    const payload = successReply(`${user.tag} a été banni ${suffix}.`);
    if (cfg.moderation.confirmDangerous) await interaction.followUp({ ...payload, ephemeral: true });
    else await interaction.reply(payload);
  },
};
