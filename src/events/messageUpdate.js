'use strict';

const { embeds } = require('../utils/embeds');

module.exports = {
  name: 'messageUpdate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;
    const embed = embeds.info('', '✏️ Message édité').addFields(
      { name: 'Auteur', value: `${newMessage.author} (${newMessage.author.id})`, inline: true },
      { name: 'Salon', value: `${newMessage.channel} • [aller au message](${newMessage.url})`, inline: true },
      { name: 'Avant', value: (oldMessage.content || '*inconnu*').slice(0, 1024) },
      { name: 'Après', value: (newMessage.content || '*vide*').slice(0, 1024) },
    );
    await client.services.logging.send(newMessage.guild.id, 'messages', embed);
  },
};
