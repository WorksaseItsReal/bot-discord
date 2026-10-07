'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { button, row } = require('../../utils/components');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Affiche l\'avatar d\'un utilisateur en grand.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur (par défaut vous-même).'))
    .addBooleanOption((o) => o.setName('serveur').setDescription('Afficher l\'avatar spécifique au serveur s\'il existe')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const user = interaction.options.getUser('cible') || interaction.user;
    const wantGuild = interaction.options.getBoolean('serveur');
    const member = wantGuild && interaction.guild ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
    const source = member?.avatar ? member : user;
    const url = source.displayAvatarURL({ size: 1024 });
    const formats = ['png', 'jpg', 'webp'].map((ext) => button({ label: ext.toUpperCase(), url: source.displayAvatarURL({ size: 1024, extension: ext, forceStatic: true }) }));
    if (source.avatar?.startsWith('a_')) formats.push(button({ label: 'GIF', url: source.displayAvatarURL({ size: 1024, extension: 'gif' }) }));
    const embed = embeds
      .neutral(`🖼️ Avatar de ${user.displayName ?? user.username}${member?.avatar ? ' (serveur)' : ''}`)
      .setImage(url);
    await interaction.reply({ embeds: [embed], components: [row(...formats)] });
  },
};
