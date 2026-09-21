'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { discordTimestamp, formatDuration } = require('../../utils/time');
const { UserError } = require('../../core/errors');

const ICONS = { warn: '⚠️', mute: '🔇', timeout: '⏳', kick: '👢', ban: '🔨', tempban: '⏲️' };

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('sanctions')
    .setDescription('Gère l\'historique des sanctions d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('list').setDescription('Affiche l\'historique d\'un membre.').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Supprime une sanction par son ID.').addIntegerOption((o) => o.setName('id').setDescription('ID de la sanction').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('clear').setDescription('Efface tout l\'historique d\'un membre.').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.sanctions;
    const guildId = interaction.guild.id;

    if (sub === 'list') {
      const user = interaction.options.getUser('membre');
      const list = repo.listByUser(guildId, user.id, 25);
      if (!list.length) return interaction.reply({ embeds: [embeds.info(`Aucune sanction pour ${user}.`)], ephemeral: true });
      const strikes = client.services.strikes.getCount(guildId, user.id);
      const lines = list.map(
        (s) => `\`#${s.id}\` ${ICONS[s.type] || '•'} **${s.type}** — ${discordTimestamp(s.created_at)}${s.duration_ms ? ` (${formatDuration(s.duration_ms)})` : ''}\n> ${s.reason || 'Aucune raison'}`,
      );
      const embed = embeds.moderation(`Sanctions de ${user.tag}`)
        .setDescription(lines.join('\n').slice(0, 4096))
        .setFooter({ text: `Total : ${list.length} · Strikes actuels : ${strikes}` });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const ok = repo.delete(guildId, id);
      if (!ok) throw new UserError(`Aucune sanction \`#${id}\` trouvée sur ce serveur.`);
      return interaction.reply({ embeds: [embeds.success(`Sanction \`#${id}\` supprimée.`)], ephemeral: true });
    }

    if (sub === 'clear') {
      const user = interaction.options.getUser('membre');
      const n = repo.clearUser(guildId, user.id);
      client.services.strikes.reset(guildId, user.id);
      return interaction.reply({ embeds: [embeds.success(`${n} sanction(s) effacée(s) pour ${user}. Strikes réinitialisés.`)], ephemeral: true });
    }
  },
};
