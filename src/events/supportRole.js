'use strict';

/**
 * Rôle soutien (services/SupportRoleService.js, /automatisations › Rôle soutien).
 *
 *  - raw GUILD_MEMBER_UPDATE : source « tag ». Le champ primary_guild de l'utilisateur est lu dans
 *    le paquet brut : quand seul l'utilisateur change (tag du serveur), discord.js n'émet pas
 *    guildMemberUpdate, et userUpdate n'est émis qu'une fois tous serveurs confondus. Sortie
 *    immédiate pour tout autre paquet.
 *  - presenceUpdate : source « statut » (PRESENCE_INTENT=on uniquement ; sinon jamais émis).
 */
module.exports = [
  {
    name: 'raw',
    execute(client, packet) {
      if (packet?.t !== 'GUILD_MEMBER_UPDATE') return;
      client.services.supportRole?.handleRawMember(packet.d);
    },
  },
  {
    name: 'presenceUpdate',
    execute(client, _oldPresence, newPresence) {
      client.services.supportRole?.handlePresence(newPresence);
    },
  },
];
