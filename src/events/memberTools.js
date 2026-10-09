'use strict';

/**
 * Outils des membres : absences (/afk), alertes de mots-clés (/alertes), snipe (/snipe).
 * Fichier séparé de messageCreate.js (AutoMod), messageDelete.js et messageUpdate.js (logs).
 *
 * ORDRE : les fichiers d'événements sont chargés par ordre alphabétique et « memberTools.js »
 * passe avant « messageDelete.js ». Le snipe lit la marque `suppressed` de l'AutoMod SANS la
 * consommer (comme levels.js) : elle est donc encore présente quand messageDelete.js la
 * consomme ensuite pour ne pas journaliser deux fois (vérifié par tests/member-tools.test.js).
 */
module.exports = [
  {
    name: 'messageCreate',
    /** @param {import('../core/GadgetClient').GadgetClient} client */
    execute(client, message) {
      if (!message.guild) return;
      client.services.afk?.handleMessage(message);
      client.services.highlights?.handleMessage(message);
    },
  },
  {
    name: 'messageDelete',
    execute(client, message) {
      client.services.snipe?.recordDelete(message);
      client.services.afk?.markDeleted(message?.id);
      client.services.highlights?.markDeleted(message?.id);
    },
  },
  {
    // Purges : jamais retenues par le snipe ; alertes et réponses d'absence abandonnées.
    name: 'messageDeleteBulk',
    execute(client, messages) {
      for (const id of messages?.keys?.() ?? []) {
        client.services.afk?.markDeleted(id);
        client.services.highlights?.markDeleted(id);
      }
    },
  },
  {
    name: 'messageUpdate',
    execute(client, oldMessage, newMessage) {
      client.services.snipe?.recordEdit(oldMessage, newMessage);
    },
  },
  {
    // Départ : absence et alertes du membre effacées.
    name: 'guildMemberRemove',
    execute(client, member) {
      if (!member?.guild || member.user?.bot) return;
      client.services.afk?.forget(member.guild.id, member.id);
      client.services.highlights?.forget(member.guild.id, member.id);
    },
  },
  {
    name: 'channelDelete',
    execute(client, channel) {
      client.services.snipe?.clearChannel(channel?.id);
    },
  },
];
