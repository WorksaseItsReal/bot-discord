'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} = require('discord.js');
const { status, TONES, ICONS, linkButton, buttonRows } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { parseColor } = require('../../utils/projectFormat');

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
    .addSubcommand((s) =>
      s.setName('create').setDescription('Ouvre un formulaire pour construire un embed.'))
    .addSubcommand((s) =>
      s.setName('send').setDescription('Envoie un embed avec des options directes.')
        .addStringOption((o) => o.setName('titre').setDescription('Titre').setMaxLength(256))
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(4096))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)').setMaxLength(7))
        .addStringOption((o) => o.setName('image').setDescription('URL de l\'image').setMaxLength(1000))
        .addStringOption((o) => o.setName('thumbnail').setDescription('URL de la miniature').setMaxLength(1000))
        .addStringOption((o) => o.setName('footer').setDescription('Texte de pied de page').setMaxLength(2048))
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
      if (title && title.length > 256) throw new UserError('Le titre est trop long (256 caractères max).');
      if (image && !isHttpUrl(image)) throw new UserError('L\'URL de l\'image doit commencer par `http://` ou `https://`.');
      if (thumbnail && !isHttpUrl(thumbnail)) throw new UserError('L\'URL de la miniature doit commencer par `http://` ou `https://`.');
      if (title) embed.setTitle(title);
      if (description) embed.setDescription(description);
      embed.setColor(parseColor(color) ?? TONES.brand);
      if (image) embed.setImage(image);
      if (thumbnail) embed.setThumbnail(thumbnail);
      if (footer) embed.setFooter({ text: footer });

      const channel = interaction.options.getChannel('salon') || interaction.channel;
      // L'auteur doit lui-même pouvoir écrire dans le salon cible (pas d'envoi « par procuration »).
      const perms = channel.permissionsFor?.(interaction.member);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new UserError(`Vous n'avez pas la permission d'envoyer des embeds dans ${channel}.`);
      }
      const sent = await channel.send({ embeds: [embed] });
      return interaction.reply({
        embeds: [status.ok(`Votre embed a été publié dans ${channel}.`, 'Embed envoyé')],
        components: sent?.url ? buttonRows(linkButton('Voir le message', sent.url, ICONS.link)) : [],
        ephemeral: true,
      });
    }
  },
};

/** URL http(s) valide (les validateurs d'embed lèvent sinon). */
function isHttpUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports.parseColor = parseColor;
module.exports.isHttpUrl = isHttpUrl;
