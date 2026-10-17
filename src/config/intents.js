'use strict';

const { GatewayIntentBits, Partials } = require('discord.js');
const { config } = require('./index');

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
 *  - GuildMessageReactions ...... starboard (réactions ⭐ ajoutées / retirées).
 *  - GuildPresences ............. UNIQUEMENT si PRESENCE_INTENT=on (config.presenceIntent) : rôle
 *                                 soutien par statut personnalisé. [Privilégié, désactivé par défaut]
 *                                 Le cache des présences reste vide (GadgetClient) : le compteur
 *                                 « En ligne » de /compteurs n'est toujours pas proposé.
 *
 * Les intents "Privilégiés" (GuildMembers, MessageContent, GuildPresences) doivent être
 * activés dans le Developer Portal (Bot > Privileged Gateway Intents).
 */
const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildMessageReactions,
];

/**
 * Intents pour une configuration donnée (lue à la construction du client).
 * @param {{ presenceIntent?: boolean }} [cfg]
 */
function buildIntents(cfg = {}) {
  return cfg.presenceIntent ? [...BASE_INTENTS, GatewayIntentBits.GuildPresences] : [...BASE_INTENTS];
}

const intents = buildIntents(config);

/**
 * Partials : événements reçus pour des objets absents du cache.
 *  - Message / Reaction : réactions sur des messages anciens (starboard), suppressions hors cache.
 *  - Channel : messages privés (ModMail). GuildMember / User : départs et réactions hors cache.
 */
const partials = [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember, Partials.User];

module.exports = { intents, partials, buildIntents };
