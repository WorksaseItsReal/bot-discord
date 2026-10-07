'use strict';

const { EmbedBuilder } = require('discord.js');
const { status, TONES, ICONS, linkButton, buttonRows } = require('../utils/ui');
const { parseColor, isHttpUrl } = require('../commands/utility/embed');
const { UserError } = require('../core/errors');

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
    const image = interaction.fields.getTextInputValue('image')?.trim();
    if (image && !isHttpUrl(image)) throw new UserError('L\'URL de l\'image doit commencer par `http://` ou `https://`.');
    if (title) embed.setTitle(title);
    embed.setDescription(description);
    embed.setColor(parseColor(color) ?? TONES.brand);
    if (image) embed.setImage(image);

    const sent = await interaction.channel.send({ embeds: [embed] });
    await interaction.reply({
      embeds: [status.ok(`Votre embed a été publié dans ${interaction.channel}.`, 'Embed envoyé')],
      components: sent?.url ? buttonRows(linkButton('Voir le message', sent.url, ICONS.link)) : [],
      ephemeral: true,
    });
  },
};
