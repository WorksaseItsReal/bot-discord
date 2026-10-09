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
 *  - GuildInvites ............... suivi des invitations (INVITE_CREATE / INVITE_DELETE tiennent le
 *                                 cache des invitations à jour). Non privilégié ; la LECTURE des
 *                                 invitations exige en plus la permission « Gérer le serveur ».
 *
 * GuildPresences (privilégié) n'est PAS activé : le compteur « En ligne » de /compteurs
 * n'est donc pas proposé. L'ajouter ici (et dans le Developer Portal) suffit à l'activer.
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
  GatewayIntentBits.GuildInvites,
];

const partials = [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User];

module.exports = { intents, partials };
