'use strict';

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { status, TONES, ICONS, linkButton, buttonRows } = require('../utils/ui');
const { isHttpUrl } = require('../commands/utility/embed');
const { parseColor } = require('../utils/projectFormat');
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
    // Le modal peut être soumis longtemps après /embed create : on revérifie les droits.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      throw new UserError('Vous avez besoin de la permission « Gérer les messages ».');
    }
    const channel = interaction.channel;
    const perms = channel?.permissionsFor?.(interaction.member);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new UserError(`Vous n'avez pas la permission d'envoyer des embeds dans ${channel ?? 'ce salon'}.`);
    }
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

    const sent = await channel.send({ embeds: [embed] });
    await interaction.reply({
      embeds: [status.ok(`Votre embed a été publié dans ${channel}.`, 'Embed envoyé')],
      components: sent?.url ? buttonRows(linkButton('Voir le message', sent.url, ICONS.link)) : [],
      ephemeral: true,
    });
  },
};
