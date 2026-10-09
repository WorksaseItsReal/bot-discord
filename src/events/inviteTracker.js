'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('invites');

/**
 * Suivi des invitations : cache des invitations (démarrage, nouveau serveur, création /
 * suppression d'invitation) et départs. L'attribution d'une arrivée est faite dans
 * events/guildMemberAdd.js, qui l'affiche dans le log d'arrivée.
 * Intent requis : GuildInvites (src/config/intents.js) ; permission : « Gérer le serveur ».
 */
module.exports = [
  {
    name: 'clientReady',
    once: true,
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    async execute(client) {
      await client.services.invites?.refreshAll().catch((e) => logger.warn('Cache des invitations :', e?.message));
    },
  },
  {
    name: 'guildCreate',
    async execute(client, guild) {
      await client.services.invites?.refresh(guild).catch((e) => logger.debug('refresh', e?.message));
    },
  },
  {
    name: 'guildDelete',
    execute(client, guild) {
      client.services.invites?.forget(guild.id);
    },
  },
  {
    name: 'inviteCreate',
    execute(client, invite) {
      client.services.invites?.onCreate(invite);
    },
  },
  {
    name: 'inviteDelete',
    execute(client, invite) {
      client.services.invites?.onDelete(invite);
    },
  },
  {
    name: 'guildMemberRemove',
    execute(client, member) {
      if (!member.user?.bot) client.services.invites?.handleLeave(member);
    },
  },
];
