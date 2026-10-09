'use strict';

const { GatewayIntentBits, Partials } = require('discord.js');

/**
 * Intents Discord activés — uniquement ceux réellement nécessaires.
 *
 *  - Guilds ...................... cycle de vie des serveurs, salons, rôles (base indispensable).
 *  - GuildMembers ................ arrivées/départs, hiérarchie (antiraid, modération). [Privilégié]
 *  - GuildModeration ............ événements de bans (logs, antiraid).
 *  - GuildMessages .............. réception des messages (automod, logs messages).
 *  - MessageContent ............. contenu des messages (automod: liens, mots interdits). [Privilégié]
 *  - GuildVoiceStates ........... gestion vocale (déplacement, logs vocaux, vocaux temporaires).
 *  - DirectMessages ............. ModMail (DM -> staff).
 *  - GuildExpressions ........... logs des emojis ajoutés / supprimés.
 *  - GuildMessageReactions ...... starboard (réactions ⭐ ajoutées / retirées).
 *
 * Les intents "Privilégiés" (GuildMembers, MessageContent) doivent être
 * activés dans le Developer Portal (Bot > Privileged Gateway Intents).
 */
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildMessageReactions,
];

/**
 * Partials : événements reçus pour des objets absents du cache.
 *  - Message / Reaction : réactions sur des messages anciens (starboard), suppressions hors cache.
 *  - Channel : messages privés (ModMail). GuildMember / User : départs et réactions hors cache.
 */
const partials = [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember, Partials.User];

module.exports = { intents, partials };
