'use strict';

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { status, TONES, ICONS, linkButton, buttonRows } = require('../utils/ui');
const { validateEmbedInput } = require('../commands/utility/embed');
const { parseColor } = require('../utils/projectFormat');
const { UserError } = require('../core/errors');
const access = require('../utils/access');

/**
 * Réception du modal du constructeur d'embed.
 * customId : embedbuilder:<channelId>
 */
module.exports = {
  id: 'embedbuilder',
  /** @param {import('discord.js').ModalSubmitInteraction} interaction */
  async execute(interaction) {
    if (!interaction.isModalSubmit()) return;
    // Le modal peut être soumis longtemps après /embed create : on revérifie les droits, avec les
    // niveaux de /permissions de LA commande /embed (mode strict, délégation du palier « Courant »).
    access.assertStrict(interaction.client, interaction, 'embed');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) && !access.grantFor(interaction.client, interaction, 'embed')) {
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
    validateEmbedInput({ title, description, image });
    if (title) embed.setTitle(title);
    embed.setDescription(description);
    embed.setColor(parseColor(color) ?? TONES.brand);
    if (image) embed.setImage(image);

    // Acquittement AVANT la publication : un envoi retardé (limite de débit du salon) ne doit
    // pas faire expirer le formulaire (« Cette interaction a échoué » → renvoi → doublon).
    await interaction.deferReply({ ephemeral: true });
    const sent = await channel.send({ embeds: [embed] });
    await interaction.editReply({
      embeds: [status.ok(`Votre embed a été publié dans ${channel}.`, 'Embed envoyé')],
      components: sent?.url ? buttonRows(linkButton('Voir le message', sent.url, ICONS.link)) : [],
    });
  },
};
