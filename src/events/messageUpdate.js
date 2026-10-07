'use strict';

const { truncate } = require('../utils/embeds');
const { field, wide, ICONS, userLine, linkButton, buttonRows } = require('../utils/ui');
const { logCard } = require('../services/LoggingService');

module.exports = {
  name: 'messageUpdate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot || newMessage.partial || !newMessage.author) return;
    // Mises à jour sans changement de texte (aperçus de liens, épinglage, embeds…)
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;

    // AutoMod sur le contenu édité (filtres de contenu uniquement)
    await client.services.automod?.handleMessage(newMessage, { edited: true }).catch(() => {});

    // Ancien message hors cache : contenu « avant » inconnu, rien d'utile à journaliser.
    if (oldMessage.partial) return;
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
        wide('⬅️', 'Avant', oldMessage.content ? truncate(oldMessage.content, 1024) : '*Vide*'),
        wide('➡️', 'Après', newMessage.content ? truncate(newMessage.content, 1024) : '*Vide*'),
      ],
    });
    await client.services.logging.send(newMessage.guild.id, 'messages', embed, buttonRows(linkButton('Aller au message', newMessage.url, ICONS.link)));
  },
};
