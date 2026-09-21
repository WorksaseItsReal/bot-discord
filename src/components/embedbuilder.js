'use strict';

const { EmbedBuilder } = require('discord.js');
const { successReply } = require('../utils/embeds');
const { parseColor } = require('../commands/utility/embed');

/**
 * Réception du modal du constructeur d'embed.
 * customId : embedbuilder:<channelId>
 */
module.exports = {
  id: 'embedbuilder',
  /** @param {import('discord.js').ModalSubmitInteraction} interaction */
  async execute(interaction) {
    if (!interaction.isModalSubmit()) return;
    const embed = new EmbedBuilder();
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    const color = interaction.fields.getTextInputValue('color');
    const image = interaction.fields.getTextInputValue('image');
    if (title) embed.setTitle(title);
    embed.setDescription(description);
    embed.setColor(parseColor(color) ?? 0x5865f2);
    if (image) embed.setImage(image);

    await interaction.channel.send({ embeds: [embed] });
    await interaction.reply(successReply('Embed publié.', { ephemeral: true }));
  },
};
