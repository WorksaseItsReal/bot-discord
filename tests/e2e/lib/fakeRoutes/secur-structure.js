'use strict';

const crypto = require('node:crypto');
const { PermissionFlagsBits: P } = require('discord.js');
const { nextId } = require('../ids');

/**
 * Routes simulées des modules Secur « Structure » (SEC4) :
 *  - POST /channels/:id/followers : suit un salon d'annonces → webhook de SUIVI (type 2) dans le
 *    salon cible, entrée d'audit 50 (changes type 2) ;
 *  - autocollants : GET / POST / DELETE /guilds/:g/stickers (audits 90 et 92, GUILD_STICKERS_UPDATE),
 *    et `fake.seedStickers(list)` pour en placer au départ ;
 *  - PATCH /guilds/:g/members/:id : l'entrée d'audit 25 reçoit, comme sur Discord, les changes
 *    $add / $remove (le cœur ne les pose que pour PUT / DELETE …/roles/:role) ;
 *  - PATCH /guilds/:g : icône, bannière et image d'invitation stockées en HASH (comme Discord), et
 *    changes icon_hash / banner_hash / splash_hash dans l'entrée d'audit 1.
 * Les permissions de l'acteur (humain via fake.perform, sinon le bot) sont vérifiées sur ces routes.
 */
module.exports = (fake, route, { error, audit }) => {
  const guild = () => fake.client.guilds.cache.get(fake.guildId);
  const actorMember = () => guild()?.members.cache.get(fake.actorId ?? fake.botUser.id) ?? null;
  const requireGuildPerm = (call, flag) => {
    const me = actorMember();
    if (me && !me.permissions.has(flag)) throw error(call, 403, 50013, 'Missing Permissions');
  };
  const requireChannelPerm = (call, channelId, flag) => {
    const me = actorMember();
    const ch = fake.client.channels.cache.get(channelId);
    if (!me || !ch?.permissionsFor) return;
    const perms = ch.permissionsFor(me);
    if (!perms?.has(P.ViewChannel)) throw error(call, 403, 50001, 'Missing Access');
    if (!perms.has(flag)) throw error(call, 403, 50013, 'Missing Permissions');
  };

  /* ---------------------------------------------------------------- */
  /* Webhook de suivi                                                   */
  /* ---------------------------------------------------------------- */

  route('POST', '/channels/:channel/followers', function (p, call) {
    const source = this.channel(p.channel, call);
    const targetId = call.body?.webhook_channel_id;
    if (source.type !== 5) throw error(call, 400, 50068, 'Invalid message type (salon d\'annonces attendu)');
    const target = this.channel(targetId, call);
    requireChannelPerm(call, target.id, P.ManageWebhooks);
    const author = this.actorId ? this.users.get(this.actorId) ?? this.botUser : this.botUser;
    const hook = {
      id: nextId(),
      type: 2,
      name: String(source.name ?? 'annonces').slice(0, 80),
      avatar: null,
      channel_id: target.id,
      guild_id: this.guildId,
      application_id: null,
      user: author,
      source_guild: { id: this.guildId, name: this.guild.name, icon: null },
      source_channel: { id: source.id, name: source.name },
    };
    this.webhooks.set(hook.id, hook);
    audit(50, hook.id, call, [{ key: 'name', new_value: hook.name }, { key: 'channel_id', new_value: target.id }, { key: 'type', new_value: 2 }]);
    this.dispatch('WEBHOOKS_UPDATE', { guild_id: this.guildId, channel_id: target.id });
    return { channel_id: source.id, webhook_id: hook.id };
  });

  /* ---------------------------------------------------------------- */
  /* Autocollants                                                       */
  /* ---------------------------------------------------------------- */

  const stickers = () => (fake.guild.stickers ??= []);
  const stickersUpdated = () => fake.dispatch('GUILD_STICKERS_UPDATE', { guild_id: fake.guildId, stickers: stickers() });
  const rawSticker = ({ id = nextId(), name, tags = '⭐', description = '', format = 1, user = fake.botUser }) => ({ id, name, tags, description, type: 2, format_type: format, available: true, guild_id: fake.guildId, user });
  /** Place des autocollants au départ (événement immédiat, comme à la connexion). */
  fake.seedStickers = (list) => {
    const added = list.map((s) => rawSticker(s));
    fake.guild.stickers = [...stickers(), ...added];
    fake.dispatchNow('GUILD_STICKERS_UPDATE', { guild_id: fake.guildId, stickers: fake.guild.stickers });
    return added;
  };

  route('GET', '/guilds/:guild/stickers', () => stickers(), { prepend: true });
  route('GET', '/guilds/:guild/stickers/:sticker', (p, call) => {
    const s = stickers().find((x) => x.id === p.sticker);
    if (!s) throw error(call, 404, 10060, 'Unknown Sticker');
    return s;
  });
  route('POST', '/guilds/:guild/stickers', function (p, call) {
    requireGuildPerm(call, P.ManageGuildExpressions);
    const b = call.body ?? {};
    const problems = [];
    if (!b.name || [...b.name].length < 2 || [...b.name].length > 30) problems.push(`nom d'autocollant invalide (${b.name})`);
    if (!b.tags || [...b.tags].length > 200) problems.push('tags d\'autocollant invalides');
    if (b.description && ([...b.description].length < 2 || [...b.description].length > 100)) problems.push('description d\'autocollant invalide');
    if (call.files.length !== 1) problems.push('un fichier d\'autocollant attendu');
    else if (call.files[0].size > 512 * 1024) problems.push('autocollant > 512 Ko');
    if (problems.length) {
      this.violations.push({ method: call.method, route: call.route, problems, label: call.label });
      throw error(call, 400, 50035, `Invalid Form Body\n${problems.join('\n')}`);
    }
    const sticker = rawSticker({ name: b.name, tags: b.tags, description: b.description ?? '', format: /\.gif$/i.test(call.files[0].name ?? '') ? 4 : 1 });
    fake.guild.stickers = [...stickers(), sticker];
    audit(90, sticker.id, call, [{ key: 'name', new_value: sticker.name }, { key: 'tags', new_value: sticker.tags }, { key: 'format_type', new_value: sticker.format_type }]);
    stickersUpdated();
    return sticker;
  });
  route('DELETE', '/guilds/:guild/stickers/:sticker', function (p, call) {
    requireGuildPerm(call, P.ManageGuildExpressions);
    const s = stickers().find((x) => x.id === p.sticker);
    if (!s) throw error(call, 404, 10060, 'Unknown Sticker');
    fake.guild.stickers = stickers().filter((x) => x.id !== s.id);
    // Comme Discord : l'événement de passerelle, puis l'entrée d'audit (avec les anciennes valeurs).
    stickersUpdated();
    audit(92, s.id, call, [{ key: 'name', old_value: s.name }, { key: 'tags', old_value: s.tags }, { key: 'format_type', old_value: s.format_type }]);
  });

  /* ---------------------------------------------------------------- */
  /* PATCH membres : changes $add / $remove de l'audit 25                */
  /* ---------------------------------------------------------------- */

  const baseMemberPatch = fake.routes.find((r) => r.method === 'PATCH' && r.re.test('/guilds/1/members/2'));
  if (baseMemberPatch) {
    route('PATCH', '/guilds/:guild/members/:user', function (p, call) {
      const userId = p.user === '@me' ? this.botUser.id : p.user;
      const before = [...(this.members.get(userId)?.roles ?? [])];
      const mark = this.auditLog.length;
      // Route du cœur SYNCHRONE : l'entrée d'audit vient d'être créée et son envoi (setImmediate)
      // n'est pas encore sérialisé ; on complète ses changes comme le ferait Discord.
      const out = baseMemberPatch.handler(p, call);
      const after = this.members.get(userId)?.roles ?? [];
      const fresh = this.auditLog.slice(0, Math.max(0, this.auditLog.length - mark));
      const entry = fresh.find((e) => e.action_type === 25 && e.target_id === userId);
      if (entry && Array.isArray(entry.changes) && !entry.changes.length) {
        const named = (ids) => ids.map((id) => ({ id, name: this.roles.get(id)?.name ?? '' }));
        const added = after.filter((r) => !before.includes(r));
        const removed = before.filter((r) => !after.includes(r));
        if (added.length) entry.changes.push({ key: '$add', new_value: named(added) });
        if (removed.length) entry.changes.push({ key: '$remove', new_value: named(removed) });
      }
      return out;
    }, { prepend: true });
  }

  /* ---------------------------------------------------------------- */
  /* PATCH serveur : images stockées en hash                             */
  /* ---------------------------------------------------------------- */

  const IMAGES = [['icon', 'icon_hash'], ['banner', 'banner_hash'], ['splash', 'splash_hash'], ['discovery_splash', 'discovery_splash_hash']];
  const hashOf = (dataUri) => crypto.createHash('sha1').update(String(dataUri)).digest('hex').slice(0, 32);
  route('PATCH', '/guilds/:guild', function (p, call) {
    if (p.guild !== this.guildId) throw error(call, 404, 10004, 'Unknown Guild');
    const body = { ...(call.body ?? {}) };
    const changes = [];
    for (const [field, key] of IMAGES) {
      if (!(field in body)) continue;
      const value = body[field];
      delete body[field];
      if (value != null && !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(value))) {
        const problems = [`${field} : data URI (png, jpeg, gif, webp) attendue`];
        this.violations.push({ method: call.method, route: call.route, problems, label: call.label });
        throw error(call, 400, 50035, `Invalid Form Body\n${problems.join('\n')}`);
      }
      const hash = value == null ? null : hashOf(value);
      if ((this.guild[field] ?? null) !== hash) changes.push({ key, ...(this.guild[field] ? { old_value: this.guild[field] } : {}), ...(hash ? { new_value: hash } : {}) });
      this.guild[field] = hash;
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'reason') continue;
      const old = this.guild[key];
      if (JSON.stringify(old ?? null) !== JSON.stringify(value ?? null)) changes.push({ key, ...(old !== undefined ? { old_value: old } : {}), ...(value !== undefined ? { new_value: value } : {}) });
      this.guild[key] = value;
    }
    const out = { ...this.guild, roles: [...this.roles.values()] };
    this.dispatch('GUILD_UPDATE', out);
    if (changes.length) audit(1, this.guildId, call, changes);
    return out;
  }, { prepend: true });
};
