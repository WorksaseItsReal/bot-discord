'use strict';

const { ChannelType } = require('discord.js');

module.exports = {
  name: 'messageCreate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, message) {
    if (message.author?.bot) return;

    // DM -> ModMail
    if (!message.guild || message.channel?.type === ChannelType.DM) {
      await client.services.modmail.handleUserDM(message).catch(() => {});
      return;
    }

    // Serveur -> AutoMod
    await client.services.automod.handleMessage(message).catch(() => {});
  },
};
