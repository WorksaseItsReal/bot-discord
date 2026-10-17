'use strict';

const { createLogger } = require('../core/logger');
const structure = require('../services/secur/structure');

const logger = createLogger('secur:structure');

/**
 * Secur — instantanés des modules « Structure » (SEC4), pris AVANT tout nettoyage.
 *
 * Écouteurs `prepend` (EventHandler) : ils passent AVANT channelEvents (débranchement des salons de
 * logs, lignes de tickets), statsCounters.forgetChannel et StickyService, qui effacent ce qu'il faut
 * pour recréer un salon. Synchrones (aucun await) : la capture est terminée avant que l'écouteur
 * suivant ne s'exécute. Rien n'est capturé si le module concerné est coupé (aucun coût), ni pendant
 * une restauration /backup (le bot reconstruit lui-même la structure).
 *
 *  - channelDelete : salon complet, surcharges, catégorie, type (ticket, ModMail, vocal temporaire,
 *    compteur…) et channelRemap.capture (configuration + base) ;
 *  - roleDelete : rôle, membres du cache, surcharges, références de configuration ;
 *  - emojiDelete / stickerDelete : nom, adresse CDN, rôles autorisés ;
 *  - channelUpdate : orphelins d'une catégorie supprimée (30 s) et surcharges retirées (30 s) ;
 *  - guildDelete : état du serveur oublié.
 */

/** Le module couvre ce serveur (chargé et actif) et aucune restauration /backup n'est en cours. */
function watching(client, guildId, key) {
  const secur = client.services?.secur;
  if (!guildId || typeof secur?.covers !== 'function' || !secur.covers(guildId, key)) return false;
  return !client.services?.backup?.isRestoring?.(guildId);
}

function safely(label, fn) {
  try {
    fn();
  } catch (e) {
    logger.warn(`Instantané Secur (${label}) non pris :`, e?.message ?? e);
  }
}

module.exports = [
  {
    name: 'channelDelete',
    prepend: true,
    execute(client, channel) {
      const guild = channel?.guild;
      if (!guild || channel.isThread?.() || !watching(client, guild.id, 'channelDelete')) return;
      safely('salon', () => structure.storeFor(client).put(guild.id, 'channel', channel.id, structure.captureChannel(client, channel)));
    },
  },
  {
    name: 'channelUpdate',
    prepend: true,
    execute(client, oldC, newC) {
      const guild = newC?.guild;
      if (!guild || newC.isThread?.()) return;
      const orphans = oldC?.parentId && !newC.parentId && watching(client, guild.id, 'channelDelete');
      const roles = watching(client, guild.id, 'roleDelete');
      if (!orphans && !roles) return;
      safely('salon modifié', () => {
        const store = structure.storeFor(client);
        if (orphans) store.noteOrphan(guild.id, newC.id, oldC.parentId);
        if (!roles) return;
        const after = newC.permissionOverwrites?.cache;
        for (const [id, ow] of oldC?.permissionOverwrites?.cache ?? []) {
          if (Number(ow.type) !== 0 || after?.has?.(id)) continue;
          store.noteRemovedOverwrite(guild.id, newC.id, { id, type: 0, allow: structure.toBig(ow.allow).toString(), deny: structure.toBig(ow.deny).toString() });
        }
      });
    },
  },
  {
    name: 'roleDelete',
    prepend: true,
    execute(client, role) {
      const guild = role?.guild;
      if (!guild || !watching(client, guild.id, 'roleDelete')) return;
      safely('rôle', () => {
        const store = structure.storeFor(client);
        store.put(guild.id, 'role', role.id, structure.captureRole(client, role, store));
      });
    },
  },
  {
    name: 'emojiDelete',
    prepend: true,
    execute(client, emoji) {
      const guild = emoji?.guild;
      if (!guild || !watching(client, guild.id, 'expressions')) return;
      safely('emoji', () => structure.storeFor(client).put(guild.id, 'emoji', emoji.id, structure.captureEmoji(emoji)));
    },
  },
  {
    name: 'stickerDelete',
    prepend: true,
    execute(client, sticker) {
      const guildId = sticker?.guildId ?? sticker?.guild?.id;
      if (!guildId || !watching(client, guildId, 'expressions')) return;
      safely('autocollant', () => structure.storeFor(client).put(guildId, 'sticker', sticker.id, structure.captureSticker(sticker)));
    },
  },
  {
    name: 'guildDelete',
    execute(client, guild) {
      if (!guild?.id || guild.available === false) return; // panne passagère : pas un départ
      structure.storeFor(client).forgetGuild(guild.id);
    },
  },
];
