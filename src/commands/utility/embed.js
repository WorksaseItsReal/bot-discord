'use strict';

const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} = require('discord.js');
const { status, TONES, ICONS, linkButton, buttonRows } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { parseColor } = require('../../utils/projectFormat');
const { LIMITS } = require('../../utils/embeds');

/** Longueur maximale d'une URL d'image ou de miniature dans un embed. */
const MAX_URL_LENGTH = 2048;

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
        .addStringOption((o) => o.setName('image').setDescription('URL de l\'image').setMaxLength(MAX_URL_LENGTH))
        .addStringOption((o) => o.setName('thumbnail').setDescription('URL de la miniature').setMaxLength(MAX_URL_LENGTH))
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
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('URL image (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(MAX_URL_LENGTH)),
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
      validateEmbedInput({ title, description, footer, image, thumbnail });
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

/**
 * Vérifie un embed libre AVANT l'envoi (channel.send n'est pas tronqué par la couche
 * d'interaction) : longueurs Discord, total de 6000 caractères, URL http(s) ≤ 2048.
 * Lève une UserError précise. Pur.
 */
function validateEmbedInput({ title, description, footer, image, thumbnail } = {}) {
  if (title && title.length > LIMITS.title) throw new UserError(`Le titre est trop long (${title.length}/${LIMITS.title} caractères).`);
  if (description && description.length > LIMITS.description) throw new UserError(`La description est trop longue (${description.length}/${LIMITS.description} caractères).`);
  if (footer && footer.length > LIMITS.footer) throw new UserError(`Le pied de page est trop long (${footer.length}/${LIMITS.footer} caractères).`);
  const total = (title?.length || 0) + (description?.length || 0) + (footer?.length || 0);
  if (total > LIMITS.total) {
    throw new UserError(`L'embed dépasse la limite Discord de ${LIMITS.total} caractères au total (titre + description + pied de page) : **${total}**/${LIMITS.total}. Retirez au moins **${total - LIMITS.total}** caractères.`);
  }
  for (const [value, label] of [[image, 'de l\'image'], [thumbnail, 'de la miniature']]) {
    if (!value) continue;
    if (value.length > MAX_URL_LENGTH) throw new UserError(`L'URL ${label} est trop longue (${value.length}/${MAX_URL_LENGTH} caractères).`);
    if (!isHttpUrl(value)) throw new UserError(`L'URL ${label} doit commencer par \`http://\` ou \`https://\`.`);
  }
}

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
module.exports.validateEmbedInput = validateEmbedInput;
module.exports.MAX_URL_LENGTH = MAX_URL_LENGTH;
