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
 *  - DirectMessages ............. base pour un futur ModMail (DM -> staff).
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
];

const partials = [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User];

module.exports = { intents, partials };
