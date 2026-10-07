'use strict';

const { embeds, truncate } = require('../utils/embeds');

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
    const embed = embeds.info('', '✏️ Message édité').addFields(
      { name: 'Auteur', value: `${newMessage.author} (${newMessage.author.id})`, inline: true },
      { name: 'Salon', value: `${newMessage.channel} • [aller au message](${newMessage.url})`, inline: true },
      { name: 'Avant', value: truncate(oldMessage.content || '*vide*', 1024) },
      { name: 'Après', value: truncate(newMessage.content || '*vide*', 1024) },
    );
    await client.services.logging.send(newMessage.guild.id, 'messages', embed);
  },
};
