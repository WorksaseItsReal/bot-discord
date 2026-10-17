'use strict';

const { PermissionFlagsBits: P } = require('discord.js');

const DAY = 86_400_000;

/**
 * Mesures d'incident de Discord (SEC3, /lockdown suspendre|reprendre, riposte de vague) :
 *  - PUT /guilds/:g/incident-actions : « Gérer le serveur » exigé (bot ou acteur humain) ; chaque
 *    échéance est null ou un horodatage ISO dans le futur, 24 h au plus (sinon violation 50035) ;
 *    une clé absente garde sa valeur. Réponse : incidents_data.
 *  - incidents_data est porté par l'objet serveur du faux Discord : GET /guilds/:g (route de base,
 *    `...this.guild`) le renvoie donc tel quel, comme Discord.
 */
module.exports = (fake, route, { error }) => {
  fake.guild.incidents_data ??= null;

  route('PUT', '/guilds/:guild/incident-actions', function (p, call) {
    if (p.guild !== this.guildId) throw error(call, 404, 10004, 'Unknown Guild');
    if (this.enforcePermissions) {
      const guild = this.client.guilds.cache.get(this.guildId);
      const actor = this.actorId ? guild?.members.cache.get(this.actorId) : guild?.members.me;
      if (!actor?.permissions?.has(P.ManageGuild)) throw error(call, 403, 50013, 'Missing Permissions');
    }
    const body = call.body ?? {};
    const now = Date.now();
    const current = this.guild.incidents_data ?? {};
    const problems = [];
    const next = (key) => {
      if (!(key in body)) return current[key] ?? null;
      const value = body[key];
      if (value === null) return null;
      const t = Date.parse(value);
      if (Number.isNaN(t)) problems.push(`${key} : horodatage invalide (${value})`);
      else if (t <= now) problems.push(`${key} : échéance passée`);
      else if (t > now + DAY) problems.push(`${key} : plus de 24 h (${Math.round((t - now) / 60_000)} min)`);
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    };
    const data = {
      invites_disabled_until: next('invites_disabled_until'),
      dms_disabled_until: next('dms_disabled_until'),
      dm_spam_detected_at: current.dm_spam_detected_at ?? null,
      raid_detected_at: current.raid_detected_at ?? null,
    };
    if (problems.length) {
      this.violations.push({ method: call.method, route: call.route, problems, label: call.label });
      throw error(call, 400, 50035, `Invalid Form Body\n${problems.join('\n')}`);
    }
    this.guild.incidents_data = data;
    return data;
  });
};
