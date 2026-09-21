'use strict';

const { embeds } = require('../utils/embeds');

module.exports = {
  name: 'messageDelete',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, message) {
    if (!message.guild || message.author?.bot) return;
    const embed = embeds.warning('', '🗑️ Message supprimé').addFields(
      { name: 'Auteur', value: message.author ? `${message.author} (${message.author.id})` : 'Inconnu', inline: true },
      { name: 'Salon', value: `${message.channel}`, inline: true },
      { name: 'Contenu', value: (message.content || '*aucun contenu texte*').slice(0, 1024) },
    );
    await client.services.logging.send(message.guild.id, 'messages', embed);
  },
};
