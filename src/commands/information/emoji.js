'use strict';

const { SlashCommandBuilder, SnowflakeUtil } = require('discord.js');
const { embeds } = require('../../utils/embeds');
const { button, row } = require('../../utils/components');
const { discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');

module.exports = {
  guildOnly: false,
  data: new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Affiche un emoji personnalisé en grand avec ses informations.')
    .addStringOption((o) => o.setName('emoji').setDescription('L\'emoji (ex : :pepe:)').setRequired(true).setMaxLength(100)),
  async execute(interaction) {
    const input = interaction.options.getString('emoji').trim();
    const custom = input.match(/<(a?):(\w{2,32}):(\d{17,20})>/);
    if (custom) {
      const [, animated, name, id] = custom;
      const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=512`;
      const embed = embeds
        .neutral(`😀 :${name}:`)
        .setImage(url)
        .addFields(
          { name: 'ID', value: `\`${id}\``, inline: true },
          { name: 'Animé', value: animated ? 'Oui' : 'Non', inline: true },
          { name: 'Créé', value: discordTimestamp(Number(SnowflakeUtil.timestampFrom(id)), 'D'), inline: true },
          { name: 'Code', value: `\`${custom[0]}\`` },
        );
      return interaction.reply({ embeds: [embed], components: [row(button({ label: 'Ouvrir l\'image', url, emoji: '🔗' }))] });
    }
    const chars = [...input].filter((c) => !/\s/.test(c));
    if (!chars.length || chars.length > 10 || chars.some((c) => /[\w]/.test(c))) {
      throw new UserError('Envoyez un emoji personnalisé (ex : `:pepe:`) ou un emoji standard.');
    }
    const codes = chars.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
    await interaction.reply({ embeds: [embeds.neutral(`${input}  Emoji standard`).addFields({ name: 'Unicode', value: `\`${codes}\`` })] });
  },
};
