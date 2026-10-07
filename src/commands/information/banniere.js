'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { button, row } = require('../../utils/components');
const { formatColor } = require('../../utils/projectFormat');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('banniere')
    .setDescription('Affiche la bannière de profil d\'un utilisateur.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur (par défaut vous-même)')),
  async execute(interaction, client) {
    const target = interaction.options.getUser('cible') || interaction.user;
    const user = await client.users.fetch(target.id, { force: true });
    const url = user.bannerURL({ size: 1024 });
    if (!url) {
      const embed = embeds
        .custom(user.accentColor ?? 0x5865f2, `🖼️ Bannière de ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setDescription(user.accentColor != null ? `Pas d'image de bannière, mais une couleur de profil : \`${formatColor(user.accentColor)}\`.` : 'Cet utilisateur n\'a pas de bannière.');
      return interaction.reply({ embeds: [embed] });
    }
    await interaction.reply({
      embeds: [embeds.neutral(`🖼️ Bannière de ${user.username}`).setImage(url)],
      components: [row(button({ label: 'Ouvrir en grand', url, emoji: '🔗' }))],
    });
  },
};
