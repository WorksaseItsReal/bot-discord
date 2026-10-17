'use strict';

const { ChannelType } = require('discord.js');
const { createLogger } = require('../core/logger');

const logger = createLogger('automod');
const modmailLogger = createLogger('modmail');

module.exports = {
  name: 'messageCreate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, message) {
    if (message.author?.bot) {
      // Sauf le message publié par un membre via une application installée sur son compte :
      // l'AutoMod l'analyse comme le sien (il ignore tous les autres messages de bots).
      if (message.guild && message.interactionMetadata) await client.services.automod.handleMessage(message).catch((err) => logger.warn(`Analyse impossible (${message.guild.id}) :`, err?.message));
      return;
    }

    // DM -> ModMail
    if (!message.guild || message.channel?.type === ChannelType.DM) {
      // Le membre est déjà prévenu par le service ; l'erreur reste visible dans les logs.
      await client.services.modmail.handleUserDM(message).catch((err) => modmailLogger.warn(`Relais ModMail impossible (utilisateur ${message.author?.id}) :`, err?.message ?? err));
      return;
    }

    // Serveur -> AutoMod
    await client.services.automod.handleMessage(message).catch((err) => logger.warn(`Analyse impossible (${message.guild.id}) :`, err?.message));
  },
};
