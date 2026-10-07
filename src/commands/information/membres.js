'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, progressBar } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder().setName('membres').setDescription('Compteur de membres du serveur.'),
  async execute(interaction, client) {
    const guild = interaction.guild;
    // withCounts donne les compteurs approximatifs sans télécharger toute la liste des membres.
    const fresh = await client.guilds.fetch({ guild: guild.id, withCounts: true, force: true }).catch(() => guild);
    const total = fresh.approximateMemberCount ?? guild.memberCount;
    const online = fresh.approximatePresenceCount ?? null;
    const cacheComplete = guild.members.cache.size >= guild.memberCount;
    const bots = cacheComplete ? guild.members.cache.filter((m) => m.user.bot).size : null;

    const embed = embeds
      .neutral(`👥 Membres de ${guild.name}`)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields({ name: 'Total', value: `**${total.toLocaleString('fr-FR')}**`, inline: true });
    if (online != null) {
      embed.addFields({ name: '🟢 En ligne', value: `**${online.toLocaleString('fr-FR')}**\n\`${progressBar(online / Math.max(1, total), 10)}\``, inline: true });
    }
    if (bots != null) {
      embed.addFields(
        { name: '🧑 Humains', value: `**${(total - bots).toLocaleString('fr-FR')}**`, inline: true },
        { name: '🤖 Bots', value: `**${bots.toLocaleString('fr-FR')}**`, inline: true },
      );
    }
    await interaction.reply({ embeds: [embed] });
  },
};
