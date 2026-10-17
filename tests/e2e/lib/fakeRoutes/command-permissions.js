'use strict';

/**
 * Surcharges « Intégrations » des commandes (ADM1, /permissions › Vérifications) :
 * GET /applications/:app/guilds/:guild/commands/permissions → `fake.commandPermissions`
 * (tableau de { id, application_id, guild_id, permissions: [{ id, type, permission }] }), vide
 * par défaut. Un bot ne peut que les LIRE (aucune route d'écriture simulée).
 */
module.exports = (fake, route, { error }) => {
  fake.commandPermissions = [];
  route('GET', '/applications/:app/guilds/:guild/commands/permissions', function (p, call) {
    if (p.guild !== this.guildId) throw error(call, 404, 10004, 'Unknown Guild');
    return this.commandPermissions;
  });
};
