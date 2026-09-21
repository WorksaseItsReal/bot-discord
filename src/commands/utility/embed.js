'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} = require('discord.js');
const { successReply } = require('../../utils/embeds');
const { UserError } = require('../../core/errors');

/**
 * Constructeur d'embeds : via modal interactif (/embed create) ou en une
 * commande (/embed send).
 */
module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Crée et envoie des embeds personnalisés.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Ouvre un formulaire pour construire un embed.'))
    .addSubcommand((s) =>
      s.setName('send').setDescription('Envoie un embed avec des options directes.')
        .addStringOption((o) => o.setName('titre').setDescription('Titre'))
        .addStringOption((o) => o.setName('description').setDescription('Description'))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)'))
        .addStringOption((o) => o.setName('image').setDescription('URL de l\'image'))
        .addStringOption((o) => o.setName('thumbnail').setDescription('URL de la miniature'))
        .addStringOption((o) => o.setName('footer').setDescription('Texte de pied de page'))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon cible').addChannelTypes(ChannelType.GuildText))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const modal = new ModalBuilder().setCustomId(`embedbuilder:${interaction.channelId}`).setTitle('Constructeur d\'embed');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Titre').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Couleur hex (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('#5865F2')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('URL image (optionnel)').setStyle(TextInputStyle.Short).setRequired(false)),
      );
      return interaction.showModal(modal);
    }

    if (sub === 'send') {
      const embed = new EmbedBuilder();
      const title = interaction.options.getString('titre');
      const description = interaction.options.getString('description');
      const color = interaction.options.getString('couleur');
      const image = interaction.options.getString('image');
      const thumbnail = interaction.options.getString('thumbnail');
      const footer = interaction.options.getString('footer');
      if (!title && !description) throw new UserError('Fournissez au moins un titre ou une description.');
      if (title) embed.setTitle(title);
      if (description) embed.setDescription(description);
      embed.setColor(parseColor(color) ?? 0x5865f2);
      if (image) embed.setImage(image);
      if (thumbnail) embed.setThumbnail(thumbnail);
      if (footer) embed.setFooter({ text: footer });

      const channel = interaction.options.getChannel('salon') || interaction.channel;
      await channel.send({ embeds: [embed] });
      return interaction.reply(successReply(`Embed envoyé dans ${channel}.`, { ephemeral: true }));
    }
  },
};

function parseColor(hex) {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1], 16) : null;
}

module.exports.parseColor = parseColor;
