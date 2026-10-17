'use strict';

/**
 * Routes simulées de Secur (SEC1) :
 *  - GET / PATCH / DELETE /webhooks/:id (audit 51 modification, 52 suppression) ;
 *  (l'entrée d'audit 50 de POST /channels/:id/webhooks est posée par le cœur de fakeDiscord) ;
 *  - POST /guilds/:g/prune (audit 21, options.members_removed) : expulse les membres sans rôle.
 * Les entrées d'audit sont signées par l'acteur courant (fake.perform) ou par le bot.
 */
module.exports = (fake, route, { error, audit }) => {
  const hook = (id, call) => {
    const h = fake.webhooks.get(id);
    if (!h) throw error(call, 404, 10015, 'Unknown Webhook');
    return h;
  };

  route('GET', '/webhooks/:id', (p, call) => hook(p.id, call));

  route('PATCH', '/webhooks/:id', function (p, call) {
    const h = hook(p.id, call);
    const b = call.body ?? {};
    const changes = [];
    for (const key of ['name', 'channel_id', 'avatar']) {
      if (key in b && b[key] !== h[key]) changes.push({ key, old_value: h[key] ?? undefined, new_value: b[key] ?? undefined });
    }
    const oldChannel = h.channel_id;
    Object.assign(h, Object.fromEntries(Object.entries(b).filter(([k]) => ['name', 'channel_id', 'avatar'].includes(k))));
    if (changes.length) audit(51, h.id, call, changes);
    this.dispatch('WEBHOOKS_UPDATE', { guild_id: this.guildId, channel_id: oldChannel });
    return h;
  });

  route('DELETE', '/webhooks/:id', function (p, call) {
    const h = hook(p.id, call);
    this.webhooks.delete(h.id);
    audit(52, h.id, call, [{ key: 'name', old_value: h.name }, { key: 'channel_id', old_value: h.channel_id }, { key: 'type', old_value: h.type }]);
    this.dispatch('WEBHOOKS_UPDATE', { guild_id: this.guildId, channel_id: h.channel_id });
  });

  route('POST', '/guilds/:guild/prune', function (p, call) {
    if (p.guild !== this.guildId) throw error(call, 404, 10004, 'Unknown Guild');
    const days = Number(call.body?.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw error(call, 400, 50035, `Invalid Form Body\ndays hors bornes (${days})`);
    // Membres sans rôle (ni propriétaire, ni bot) : ceux qu'un prune expulserait.
    const pruned = [...this.members.values()].filter((m) => !m.roles.length && !m.user.bot && m.user.id !== this.guild.owner_id);
    for (const m of pruned) {
      this.members.delete(m.user.id);
      this.dispatch('GUILD_MEMBER_REMOVE', { guild_id: this.guildId, user: m.user });
    }
    audit(21, null, call, [], { delete_member_days: String(days), members_removed: String(pruned.length) });
    return { pruned: call.body?.compute_prune_count === false ? null : pruned.length };
  });
};
