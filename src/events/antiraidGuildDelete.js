'use strict';

/**
 * AntiRaid : serveur quitté → son état mémoire (arrivants récents, fenêtres de vague et de
 * destruction, alertes regroupées, dernier déclenchement) est oublié tout de suite au lieu
 * de rester jusqu'au redémarrage.
 */
module.exports = {
  name: 'guildDelete',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  execute(client, guild) {
    if (guild?.available === false) return; // panne Discord passagère : pas un départ
    client.services.antiraid?.forgetGuild?.(guild?.id);
  },
};
