'use strict';

const { truncate } = require('../utils/embeds');
const { discordTimestamp } = require('../utils/time');
const { field, wide, ICONS, userLine } = require('../utils/ui');
const { logCard } = require('../services/LoggingService');

module.exports = {
  name: 'messageDelete',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, message) {
    if (!message.guild) return;
    // Supprimé par l'AutoMod : la carte AutoMod contient déjà le message.
    if (client.services.logging.isSuppressed?.(message.id)) return;
    const author = message.author;
    const files = [...(message.attachments?.values?.() ?? [])].map((a) => a.name ?? 'fichier');
    const embed = logCard({
      category: 'messages',
      tone: 'danger',
      icon: ICONS.delete,
      title: 'Message supprimé',
      description: author ? `Un message de ${author} a été supprimé dans ${message.channel}.` : `Un message a été supprimé dans ${message.channel}.`,
      user: author,
      fields: [
        field(ICONS.user, 'Auteur', author ? userLine(author) : '*Inconnu (hors cache)*'),
        field(ICONS.channel, 'Salon', `${message.channel}`),
        field(ICONS.date, 'Envoyé', message.createdTimestamp ? discordTimestamp(message.createdTimestamp, 'R') : '—'),
        wide('📄', 'Contenu', message.content ? truncate(message.content, 1024) : '*Aucun contenu texte*'),
        files.length ? wide('📎', `Pièces jointes (${files.length})`, truncate(files.join(' · '), 1024)) : null,
      ],
      id: author?.id ?? message.id,
    });
    await client.services.logging.send(message.guild.id, 'messages', embed, undefined, {
      event: 'messageDelete',
      channelId: message.channelId,
      parentId: message.channel?.parentId,
      categoryId: message.channel?.parent?.parentId ?? null,
      bot: Boolean(message.author?.bot),
    });
  },
};
