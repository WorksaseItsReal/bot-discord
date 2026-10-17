'use strict';

const { field, wide, ICONS, userLine, linkButton, buttonRows } = require('../utils/ui');
const { logCard, truncateContent, PRIVATE_CONTENT } = require('../services/LoggingService');

module.exports = {
  name: 'messageUpdate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.partial || !newMessage.author || newMessage.webhookId) return;
    // Mises à jour sans changement de texte (aperçus de liens, épinglage, embeds…)
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;

    // AutoMod sur le contenu édité (filtres de contenu uniquement)
    await client.services.automod?.handleMessage(newMessage, { edited: true }).catch((err) => client.logger?.warn?.('AutoMod (édition) :', err?.message));

    // Ancien message hors cache : contenu « avant » inconnu, rien d'utile à journaliser.
    if (oldMessage.partial) return;
    const logging = client.services.logging;
    const ctx = {
      event: 'messageEdit',
      channelId: newMessage.channelId,
      parentId: newMessage.channel?.parentId,
      categoryId: newMessage.channel?.parent?.parentId ?? null,
      bot: Boolean(newMessage.author?.bot),
    };
    if (logging.wouldLog?.(newMessage.guild.id, 'messages', ctx) === false) return;
    // Salon (ou fil) privé que certains lecteurs des logs ne voient pas : contenu masqué.
    const hidden = logging.hidesContent?.(newMessage.guild.id, 'messages', newMessage.channel) ?? false;
    const author = newMessage.author;
    const embed = logCard({
      category: 'messages',
      tone: 'info',
      icon: '✏️',
      title: 'Message modifié',
      description: `${author} a modifié un message dans ${newMessage.channel}.`,
      user: author,
      fields: [
        field(ICONS.user, 'Auteur', userLine(author)),
        field(ICONS.channel, 'Salon', `${newMessage.channel}`),
        ...(hidden
          ? [wide('📄', 'Contenu', PRIVATE_CONTENT)]
          : [
            wide('⬅️', 'Avant', oldMessage.content ? truncateContent(oldMessage.content, 1024) : '*Vide*'),
            wide('➡️', 'Après', newMessage.content ? truncateContent(newMessage.content, 1024) : '*Vide*'),
          ]),
      ],
    });
    await logging.send(newMessage.guild.id, 'messages', embed, buttonRows(linkButton('Aller au message', newMessage.url, ICONS.link)), ctx);
  },
};
