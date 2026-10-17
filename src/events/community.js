'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('community');

/**
 * Communauté : starboard, messages épinglés automatiquement (sticky), réponses automatiques.
 * Fichier séparé de messageCreate.js (AutoMod) et levels.js (XP).
 *
 * Réactions : intent GuildMessageReactions + partials Message et Reaction (src/config/intents.js).
 * Les objets partiels ne sont jamais récupérés ici : le starboard ne garde que les
 * identifiants et recompte plus tard (anti-rebond), en récupérant le message à ce moment-là.
 */
module.exports = [
  {
    name: 'messageCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    execute(client, message) {
      if (!message.guild) return;
      // Le sticky compte toute l'activité (bots compris, sauf son propre message).
      client.services.sticky?.handleMessage(message);
      if (message.author?.bot) return;
      client.services.autoResponses?.handleMessage(message);
    },
  },
  {
    name: 'messageReactionAdd',
    execute(client, reaction, user) {
      client.services.starboard?.handleReaction(reaction, user);
    },
  },
  {
    name: 'messageReactionRemove',
    execute(client, reaction, user) {
      client.services.starboard?.handleReaction(reaction, user);
    },
  },
  {
    name: 'messageReactionRemoveAll',
    execute(client, message) {
      client.services.starboard?.handleRemoveAll(message);
    },
  },
  {
    name: 'messageReactionRemoveEmoji',
    execute(client, reaction) {
      client.services.starboard?.handleRemoveEmoji(reaction);
    },
  },
  {
    name: 'messageDelete',
    async execute(client, message) {
      client.services.autoResponses?.markDeleted(message?.id);
      client.services.sticky?.handleDelete(message);
      await client.services.starboard?.handleDelete(message).catch((err) => logger.debug('Starboard (suppression) :', err?.message));
    },
  },
  {
    name: 'messageDeleteBulk',
    async execute(client, messages) {
      for (const message of messages?.values?.() ?? []) {
        client.services.autoResponses?.markDeleted(message?.id);
        client.services.sticky?.handleDelete(message);
        await client.services.starboard?.handleDelete(message).catch((err) => logger.debug('Starboard (purge) :', err?.message));
      }
    },
  },
  {
    name: 'channelDelete',
    execute(client, channel) {
      client.services.sticky?.handleChannelDelete(channel);
    },
  },
  {
    name: 'clientReady',
    once: true,
    execute(client) {
      const n = client.services.sticky?.resume() ?? 0;
      if (n) logger.info(`${n} message(s) épinglé(s) à republier après le redémarrage.`);
    },
  },
];
