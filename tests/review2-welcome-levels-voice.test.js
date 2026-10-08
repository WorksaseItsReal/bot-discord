'use strict';

/**
 * Revue 2 — accueil, niveaux, vocaux temporaires : tests de non-régression.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  GatewayIntentBits,
  Collection,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits: P,
  PermissionsBitField,
  PermissionOverwrites,
} = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { TempVoiceRepository } = require('../src/database/repositories/TempVoiceRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { WelcomeService } = require('../src/services/WelcomeService');
const { LevelService } = require('../src/services/LevelService');
const { TempVoiceService, HUB_COOLDOWN_MS } = require('../src/services/TempVoiceService');
const { applyRoles } = require('../src/utils/memberRoles');
const tv = require('../src/utils/tempVoice');
const bienvenue = require('../src/commands/configuration/bienvenue');
const tempvoice = require('../src/commands/voice/tempvoice');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const perm = (bits) => new PermissionsBitField(bits);
const tick = () => new Promise((r) => setImmediate(r));
const DAY = 86_400_000;

// ================================================================ 1. rôles : routes par rôle

/** Vrai GuildMember discord.js, REST simulé : on voit exactement les requêtes envoyées. */
function realGuild() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const G = '100000000000000001';
  const R = { muted: '400000000000000001', unv: '400000000000000002', human: '400000000000000003', r5: '400000000000000004', r10: '400000000000000005', bot: '400000000000000009' };
  const role = (id, position, name) => ({ id, name, position, permissions: '0', color: 0, hoist: false, managed: false, mentionable: false, flags: 0 });
  const guild = client.guilds._add({
    id: G,
    name: 'g',
    owner_id: '999999999999999999',
    roles: [role(G, 0, '@everyone'), role(R.muted, 1, 'Muted'), role(R.unv, 2, 'unv'), role(R.human, 3, 'human'), role(R.r5, 4, 'r5'), role(R.r10, 5, 'r10'), role(R.bot, 10, 'bot')],
    members: [],
    channels: [],
  });
  client.user = { id: '200000000000000001' };
  guild.members._add({ user: { id: '200000000000000001', username: 'bot', bot: true }, roles: [R.bot], joined_at: new Date().toISOString() });
  Object.defineProperty(guild.members.me, 'permissions', { get: () => perm(PermissionsBitField.All) });
  const calls = [];
  client.rest.put = async (route) => calls.push(['PUT', route]);
  client.rest.delete = async (route) => calls.push(['DELETE', route]);
  client.rest.patch = async (route, { body }) => {
    calls.push(['PATCH', route, body.roles]);
    return {};
  };
  const member = (roles) => guild.members._add({ user: { id: '300000000000000001', username: 'u' }, roles, joined_at: new Date().toISOString() });
  return { client, guild, R, calls, member };
}

const verbs = (calls) => calls.map(([verb, route]) => `${verb} ${route.split('/').pop()}`);

test('rôles : vérification (mode retrait) en routes par rôle, jamais de PATCH de liste', async () => {
  const { client, R, calls, member } = realGuild();
  const cfg = { welcome: { verification: { enabled: true, roleId: R.unv, mode: 'remove' }, autoRoles: { humans: [R.human], bots: [] }, join: {}, leave: {} } };
  const ws = new WelcomeService({ client, config: { get: () => cfg } });
  const res = await ws.verify(member([R.unv]));
  assert.deepEqual(res, { added: [R.human], removed: [R.unv] });
  assert.deepEqual(verbs(calls), [`DELETE ${R.unv}`, `PUT ${R.human}`], 'rôle de vérification d\'abord, puis rôles automatiques, un par un');
});

test('rôles : les rôles automatiques n\'effacent plus le rôle Muted remis juste avant', async () => {
  const { client, R, calls, member } = realGuild();
  const cfg = { welcome: { verification: { enabled: false }, autoRoles: { humans: [R.human], bots: [] }, join: {}, leave: {} } };
  const ws = new WelcomeService({ client, config: { get: () => cfg } });
  const m = member([]);
  await m.roles.add(R.muted, 'reapplyMute');
  const res = await ws.welcome(m);
  assert.deepEqual(res.roles, [R.human]);
  assert.ok(calls.every(([verb]) => verb !== 'PATCH'), 'aucun PATCH (il recalculerait la liste sans Muted)');
  assert.deepEqual(verbs(calls), [`PUT ${R.muted}`, `PUT ${R.human}`]);
});

test('rôles : récompense non cumulative ajoutée puis palier inférieur retiré, sans s\'annuler', async () => {
  const { R, calls, member } = realGuild();
  const ls = new LevelService({ levels: {}, config: { get: () => ({}) } });
  const res = await ls.syncRewards(member([R.r5]), 10, { rewards: [{ level: 5, roleId: R.r5 }, { level: 10, roleId: R.r10 }], stackRewards: false });
  assert.deepEqual(res, { added: [R.r10], removed: [R.r5] });
  assert.deepEqual(verbs(calls), [`PUT ${R.r10}`, `DELETE ${R.r5}`]);
});

test('applyRoles : une erreur sur un rôle n\'empêche pas les autres', async () => {
  const done = [];
  const member = {
    roles: {
      add: async (id) => {
        if (id === 'b') throw new Error('Missing Permissions');
        done.push(`+${id}`);
      },
      remove: async (id) => done.push(`-${id}`),
    },
  };
  const errors = [];
  const out = await applyRoles(member, { add: ['a', 'b', 'c', 'a'], remove: ['x'] }, 'test', (id, e, action) => errors.push([id, action]));
  assert.deepEqual(out, { added: ['a', 'c'], removed: ['x'], failed: ['b'] });
  assert.deepEqual(done, ['-x', '+a', '+c'], 'retraits d\'abord, doublons ignorés');
  assert.deepEqual(errors, [['b', 'add']]);
});

test('vérification : échec du rôle de vérification → erreur claire, rôles automatiques non touchés', async () => {
  const touched = [];
  const guild = {
    id: 'g',
    roles: { cache: new Collection([['v', { id: 'v', position: 1, permissions: perm(0n) }], ['h', { id: 'h', position: 1, permissions: perm(0n) }]]) },
    members: { me: { roles: { highest: { position: 10 } } } },
  };
  const cfg = { welcome: { verification: { enabled: true, roleId: 'v', mode: 'add' }, autoRoles: { humans: ['h'] } } };
  const ws = new WelcomeService({ config: { get: () => cfg } });
  const member = {
    id: 'u',
    guild,
    user: { id: 'u' },
    roles: { cache: new Collection(), add: async (id) => (id === 'v' ? Promise.reject(new Error('50013')) : touched.push(id)), remove: async () => {} },
  };
  await assert.rejects(ws.verify(member), { name: 'UserError' });
  assert.deepEqual(touched, []);
});

// ================================================================ 2. /bienvenue : élévation de privilèges

const GUILD = '100000000000000001';
const ROLE = { low: '300000000000000001', mod: '300000000000000002', equal: '300000000000000003', admin: '300000000000000004', events: '300000000000000005' };
const CH = { panel: '400000000000000002' };
const UID = '500000000000000001';
const OWNER_ID = '500000000000000099';

function welcomeWorld() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const role = (id, position, perms = 0n) => ({ id, position, managed: false, permissions: perm(perms), toString: () => `<@&${id}>` });
  const panel = {
    id: CH.panel,
    type: ChannelType.GuildText,
    sent: [],
    deleted: [],
    messages: { delete: async (mid) => panel.deleted.push(mid) },
    permissionsFor: () => perm(PermissionsBitField.All),
    send: async (p) => {
      panel.sent.push(p);
      if (panel.hold) await panel.hold;
      return { id: `60000000000000000${panel.sent.length}` };
    },
    toString: () => `<#${CH.panel}>`,
  };
  const guild = {
    id: GUILD,
    name: 'Le Repaire',
    ownerId: OWNER_ID,
    roles: {
      cache: new Collection([
        [GUILD, role(GUILD, 0)],
        [ROLE.low, role(ROLE.low, 2)],
        [ROLE.mod, role(ROLE.mod, 2, P.ManageMessages)],
        [ROLE.equal, role(ROLE.equal, 5)],
        [ROLE.admin, role(ROLE.admin, 2, P.Administrator)],
        [ROLE.events, role(ROLE.events, 2, P.ManageEvents)],
      ]),
    },
    channels: { cache: new Collection([[CH.panel, panel]]) },
    members: { me: { id: '999999999999999999', roles: { highest: { position: 10 } } } },
  };
  const client = { services: { config } };
  client.services.welcome = new WelcomeService({ client, config });
  return { client, config, guild, panel };
}

const adminI = (guild, extra = {}) => {
  const i = {
    guildId: guild.id,
    guild,
    user: { id: UID },
    member: { roles: { highest: { position: 5 } } },
    memberPermissions: perm(PermissionsBitField.All),
    values: [],
    update: async (p) => (i.payload = p),
    deferUpdate: async () => {},
    editReply: async (p) => (i.payload = p),
    ...extra,
  };
  return i;
};

test('/bienvenue rôles automatiques : permissions sensibles et rôles au niveau de l\'auteur refusés', async () => {
  const { client, config, guild } = welcomeWorld();
  const i = adminI(guild, { values: [ROLE.low, ROLE.mod, ROLE.equal, ROLE.events] });
  await bienvenue.buttons.roles(i, client, ['humans']);
  assert.deepEqual(config.get(GUILD).welcome.autoRoles.humans, [ROLE.low, ROLE.events]);
  const desc = json(i.payload.embeds[0]).description;
  assert.match(desc, /modération ou d'administration/);
  assert.match(desc, /votre rôle le plus haut/);
  assert.match(desc, /Attention/, 'permission sensible mineure (événements) : simple avertissement');

  // Rôles des bots : mêmes contrôles.
  await bienvenue.buttons.roles(adminI(guild, { values: [ROLE.mod, ROLE.low] }), client, ['bots']);
  assert.deepEqual(config.get(GUILD).welcome.autoRoles.bots, [ROLE.low]);

  // Le propriétaire n'est pas limité par sa hiérarchie (mais toujours par les permissions sensibles).
  await bienvenue.buttons.roles(adminI(guild, { user: { id: OWNER_ID }, member: { roles: { highest: { position: 0 } } }, values: [ROLE.equal, ROLE.mod] }), client, ['humans']);
  assert.deepEqual(config.get(GUILD).welcome.autoRoles.humans, [ROLE.equal]);
});

test('/bienvenue rôle de vérification : refus des permissions sensibles et de la hiérarchie, dans les deux modes', async () => {
  const { client, config, guild } = welcomeWorld();
  await assert.rejects(bienvenue.buttons.vrole(adminI(guild, { values: [ROLE.mod] }), client), /modération ou d'administration/);
  await assert.rejects(bienvenue.buttons.vrole(adminI(guild, { values: [ROLE.equal] }), client), /votre rôle le plus haut/);
  config.update(GUILD, { welcome: { verification: { mode: 'remove' } } });
  await assert.rejects(bienvenue.buttons.vrole(adminI(guild, { values: [ROLE.equal] }), client), /votre rôle le plus haut/, 'mode retrait : même contrôle de hiérarchie');
  await bienvenue.buttons.vrole(adminI(guild, { values: [ROLE.low] }), client);
  assert.equal(config.get(GUILD).welcome.verification.roleId, ROLE.low);
});

test('/bienvenue panneau : salon supprimé → « non publié » ; message inconnu → champs vidés', async () => {
  const { client, config, guild, panel } = welcomeWorld();
  config.update(GUILD, { welcome: { verification: { enabled: true, roleId: ROLE.low, channelId: CH.panel, panelChannelId: '400000000000000009', panelMessageId: '600000000000000001' } } });
  const view = bienvenue.render(client, guild, 'verify');
  assert.match(JSON.stringify(json(view.embeds[0])), /Non publié/, 'salon du panneau absent du cache');

  // Message supprimé : la relecture (Unknown Message) vide les champs à l'ouverture de la vue.
  config.update(GUILD, { welcome: { verification: { panelChannelId: CH.panel } } });
  panel.messages.fetch = async () => Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 }));
  const i = adminI(guild);
  await bienvenue.buttons.go(i, client, ['verify']);
  assert.equal(config.get(GUILD).welcome.verification.panelMessageId, null);
  assert.match(JSON.stringify(json(i.payload.embeds[0])), /Non publié/);

  // Permission manquante (autre erreur) : rien n'est vidé.
  config.update(GUILD, { welcome: { verification: { panelChannelId: CH.panel, panelMessageId: '600000000000000002' } } });
  panel.messages.fetch = async () => Promise.reject(Object.assign(new Error('Missing Access'), { code: 50001 }));
  await bienvenue.buttons.go(adminI(guild), client, ['home']);
  assert.equal(config.get(GUILD).welcome.verification.panelMessageId, '600000000000000002');
});

test('/bienvenue « Publier le panneau » : double clic → une seule publication', async () => {
  const { client, config, guild, panel } = welcomeWorld();
  config.update(GUILD, { welcome: { verification: { enabled: true, roleId: ROLE.low, channelId: CH.panel } } });
  let release;
  panel.hold = new Promise((r) => (release = r));
  const first = bienvenue.buttons.publish(adminI(guild), client);
  await tick();
  await assert.rejects(bienvenue.buttons.publish(adminI(guild), client), /déjà en cours/);
  release();
  await first;
  panel.hold = null;
  assert.equal(panel.sent.length, 1);
  // Le verrou est libéré : une republication remplace l'ancien panneau.
  await bienvenue.buttons.publish(adminI(guild), client);
  assert.equal(panel.sent.length, 2);
  assert.deepEqual(panel.deleted, ['600000000000000001']);
});

// ================================================================ 3-4. départs tus, accueil manqué

function leaveWorld({ now = () => 1_000_000_000 } = {}) {
  const sent = [];
  const channel = { id: 'c', send: async (p) => sent.push(p), permissionsFor: () => ({ has: () => true }) };
  const roles = new Collection([['unv', { id: 'unv', position: 1, permissions: perm(0n) }], ['human', { id: 'human', position: 1, permissions: perm(0n) }]]);
  const guild = { id: 'g', name: 'G', memberCount: 10, roles: { cache: roles }, channels: { cache: new Map([['c', channel]]) }, members: { me: { roles: { highest: { position: 10 } } } } };
  const cfg = { welcome: { leave: { enabled: true, channelId: 'c', title: 'Au revoir', description: 'x' }, join: {}, autoRoles: { humans: [], bots: [] }, verification: {} } };
  const ws = new WelcomeService({ client: { services: { antiraid: { joinAlertAt: new Map() } } }, config: { get: () => cfg }, now });
  const member = (id, { joinedAgo = 0, roles: owned = [] } = {}) => {
    const cache = new Collection(owned.map((r) => [r, roles.get(r)]));
    return {
      id,
      guild,
      user: { id, username: id },
      displayName: id,
      joinedTimestamp: now() - joinedAgo,
      pending: false,
      roles: { cache, add: async (r) => cache.set(r, roles.get(r)), remove: async (r) => cache.delete(r) },
    };
  };
  return { ws, sent, cfg, member };
}

test('départs : silence() posé avant la sanction tait le départ (même s\'il arrive avant handleJoin)', async () => {
  const { ws, sent, member } = leaveWorld();
  ws.silence('g', 'raider');
  assert.deepEqual(await ws.handleLeave(member('raider')), { sent: false });
  assert.deepEqual(await ws.handleJoin(member('raider'), { raid: { punished: true } }), { skipped: 'antiraid' });
  assert.equal(sent.length, 0);
  assert.deepEqual(await ws.handleLeave(member('alice')), { sent: true }, 'les autres départs restent annoncés');
});

test('départs : silenceWave() tait les arrivants récents d\'une vague, pas les anciens membres', async () => {
  let t = 1_000_000_000;
  const { ws, sent, member } = leaveWorld({ now: () => t });
  ws.silenceWave('g');
  assert.deepEqual(await ws.handleLeave(member('r1', { joinedAgo: 1_000 })), { sent: false });
  assert.deepEqual(await ws.handleLeave(member('old', { joinedAgo: 30 * DAY })), { sent: true });
  t += 3 * 60_000; // vague terminée
  assert.deepEqual(await ws.handleLeave(member('r2', { joinedAgo: 1_000 })), { sent: true });
  assert.equal(sent.length, 2);
});

test('écran d\'adhésion : ancien membre partiel (redémarrage) accueilli s\'il n\'a aucun rôle d\'arrivée', async () => {
  const { ws, cfg, member } = leaveWorld();
  const partial = { partial: true, pending: false };
  cfg.welcome.verification = { enabled: true, roleId: 'unv', mode: 'remove' };
  const fresh = member('new', { joinedAgo: 3_600_000 });
  const res = await ws.handleScreeningPassed(partial, fresh);
  assert.deepEqual(res?.roles, ['unv'], 'mode retrait : le rôle « non vérifié » est bien donné');
  assert.equal(await ws.handleScreeningPassed(partial, member('done', { joinedAgo: 3_600_000, roles: ['unv'] })), null, 'déjà accueilli');
  assert.equal(await ws.handleScreeningPassed(partial, member('old', { joinedAgo: 2 * DAY })), null, 'arrivé il y a plus de 24 h');
  assert.equal(await ws.handleScreeningPassed({ partial: false, pending: false }, fresh), null, 'ancien membre connu, non en attente : rien');
  cfg.welcome.verification = {};
  assert.equal(await ws.handleScreeningPassed(partial, member('x', { joinedAgo: 1_000 })), null, 'aucun rôle d\'arrivée : pas de message en double');
});

test('défis anti-robot : purge des entrées expirées sans attendre 500 entrées', () => {
  let t = 1_000_000;
  const ws = new WelcomeService({ config: { get: () => ({ welcome: {} }) }, now: () => t, randomInt: (min) => min });
  ws.createChallenge('g', 'a');
  t += 61 * 60_000;
  ws.createChallenge('g', 'b');
  assert.deepEqual([...ws.challenges.keys()], ['g:b']);
  ws.silence('g', 'x');
  t += 11 * 60_000;
  ws.silence('g', 'y');
  assert.deepEqual([...ws.silenced.keys()], ['g:y']);
});

// ================================================================ 5-6 + basses. vocaux temporaires

const TV = { guild: '100000000000000001', cat: '300000000000000001', hub: '500000000000000001', owner: '200000000000000001', bob: '200000000000000002', carol: '200000000000000003', music: '200000000000000005', me: '999999999999999999', memberRole: '400000000000000002' };

function tvWorld({ editFails = false, createFails = false, slowEdits = false } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new TempVoiceRepository(db);
  const service = new TempVoiceService({ tempVoice: repo, config, renameTimeoutMs: 30 });
  const created = [];
  const guild = {
    id: TV.guild,
    ownerId: '200000000000000099',
    roles: { cache: new Collection([[TV.guild, { id: TV.guild, permissions: perm(P.ViewChannel | P.Connect) }], [TV.memberRole, { id: TV.memberRole, permissions: perm(0n) }]]) },
    channels: { cache: new Collection() },
    members: { me: { id: TV.me }, cache: new Collection() },
  };
  let seq = 10;
  const voice = (data) => {
    const cache = new Collection((data.permissionOverwrites ?? []).map((o) => [o.id, { id: o.id, type: o.type, allow: perm(o.allow), deny: perm(o.deny) }]));
    const ch = {
      id: data.id ?? `6000000000000000${seq++}`,
      name: data.name,
      type: data.type ?? ChannelType.GuildVoice,
      parentId: data.parent ?? null,
      guild,
      members: new Collection(),
      sent: [],
      deleteError: null,
      permissionOverwrites: {
        cache,
        edit: async (id, options, { type } = {}) => {
          if (editFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
          const existing = ch.permissionOverwrites.cache.get(id);
          const next = PermissionOverwrites.resolveOverwriteOptions(options, existing ?? {});
          if (slowEdits) await tick(); // l'événement de Discord n'est pas encore arrivé
          ch.permissionOverwrites.cache.set(id, { id, type: type ?? existing?.type, ...next });
        },
        delete: async (id) => ch.permissionOverwrites.cache.delete(id),
      },
      send: async (p) => {
        ch.sent.push(p);
        return { id: `70000000000000${String(ch.sent.length).padStart(4, '0')}`, edit: async () => {} };
      },
      messages: { fetch: async () => null },
      delete: async () => {
        if (ch.deleteError) throw ch.deleteError;
        guild.channels.cache.delete(ch.id);
      },
      toString: () => `<#${ch.id}>`,
    };
    guild.channels.cache.set(ch.id, ch);
    return ch;
  };
  guild.channels.create = async (data) => {
    created.push(data);
    if (createFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const parent = data.parent ? guild.channels.cache.get(data.parent) : null;
    return voice({ ...data, permissionOverwrites: data.permissionOverwrites ?? tv.snapshot(parent) });
  };
  voice({
    id: TV.cat,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: TV.guild, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel },
      { id: TV.memberRole, type: OverwriteType.Role, allow: P.ViewChannel | P.Connect, deny: 0n },
    ],
  });
  const hub = voice({ id: TV.hub, parent: TV.cat });
  const member = (id, { bot = false } = {}) => {
    const m = {
      id,
      user: { id, username: `u${id.slice(-1)}`, bot },
      displayName: `P${id.slice(-1)}`,
      permissions: perm(0n),
      dms: [],
      send: async (p) => m.dms.push(p),
      voice: {
        setChannel: async (ch) => {
          for (const c of guild.channels.cache.values()) c.members.delete(id);
          ch.members.set(id, m);
        },
        disconnect: async () => {
          if (m.disconnectError) throw m.disconnectError;
          for (const c of guild.channels.cache.values()) c.members.delete(id);
        },
      },
      toString: () => `<@${id}>`,
    };
    guild.members.cache.set(id, m);
    return m;
  };
  for (const id of [TV.owner, TV.bob, TV.carol]) member(id);
  member(TV.music, { bot: true });
  config.update(TV.guild, { tempVoice: { enabled: true, hubChannelId: TV.hub } });
  const join = async (id = TV.owner) => {
    const m = guild.members.cache.get(id);
    hub.members.set(id, m);
    await service.handleVoiceUpdate({ guild, channelId: null, id }, { guild, channelId: TV.hub, member: m, id, channel: hub });
    const row = repo.all().find((r) => r.owner_id === id);
    return row ? guild.channels.cache.get(row.channel_id) : null;
  };
  const leave = (ch, id) => service.handleVoiceUpdate({ guild, channelId: ch.id, id, member: guild.members.cache.get(id) }, { guild, channelId: null, id });
  return { config, repo, service, guild, hub, created, join, leave, client: { services: { config, tempVoice: service } } };
}

test('vocal : créé sans overwrites explicites (héritage de la catégorie), puis overwrite ciblé du propriétaire', async () => {
  const w = tvWorld();
  const ch = await w.join();
  assert.equal(w.created[0].permissionOverwrites, undefined);
  assert.equal(w.created[0].parent, TV.cat);
  assert.ok(ch.permissionOverwrites.cache.get(TV.guild).deny.has(P.ViewChannel), 'catégorie privée héritée');
  const owner = ch.permissionOverwrites.cache.get(TV.owner);
  assert.equal(owner.type, OverwriteType.Member);
  assert.ok(owner.allow.has(P.ViewChannel | P.Connect));
  assert.ok(!owner.allow.has(P.MoveMembers), 'le propriétaire n\'a plus « Déplacer des membres »');
  assert.equal(tv.OWNER_PERMISSIONS & P.MoveMembers, 0n);
});

test('vocal : droits du propriétaire impossibles → salon gardé, avertissement en MP', async () => {
  const w = tvWorld({ editFails: true });
  const ch = await w.join();
  assert.ok(ch, 'le salon est créé et le membre y est déplacé');
  assert.ok(ch.members.has(TV.owner));
  const dms = w.guild.members.cache.get(TV.owner).dms;
  assert.equal(dms.length, 1);
  assert.match(json(dms[0].embeds[0]).description, /droits de propriétaire/);
});

test('vocal : échec de création et cooldown → le membre est prévenu (une seule fois par fenêtre)', async () => {
  const w = tvWorld({ createFails: true });
  const owner = w.guild.members.cache.get(TV.owner);
  await w.join();
  assert.match(json(owner.dms[0].embeds[0]).description, /pas pu créer/);
  await w.join();
  await w.join();
  assert.equal(owner.dms.length, 2, 'un seul avertissement de cooldown');
  assert.match(json(owner.dms[1].embeds[0]).description, /patientez/);
  assert.ok(HUB_COOLDOWN_MS >= 5_000);

  // MP fermés : message (avec mention) dans le chat du hub.
  const bob = w.guild.members.cache.get(TV.bob);
  bob.send = async () => Promise.reject(new Error('Cannot send messages to this user'));
  await w.join(TV.bob);
  assert.equal(w.hub.sent.at(-1).content, `<@${TV.bob}>`);
  assert.deepEqual(w.hub.sent.at(-1).allowedMentions, { users: [TV.bob] });
});

test('panneau : actions simultanées sur un même salon → aucune mise à jour perdue, file purgée', async () => {
  const w = tvWorld({ slowEdits: true });
  const ch = await w.join();
  for (const id of [TV.bob, TV.carol]) ch.members.set(id, w.guild.members.cache.get(id));
  await Promise.all([
    w.service.setAccess(ch, 'lock', true, TV.owner),
    w.service.setAccess(ch, 'hide', true, TV.owner),
    w.service.ban(ch, [TV.carol], { actorId: TV.owner, staff: false }),
    w.service.permit(ch, ['200000000000000007']),
  ]);
  const get = (id) => ch.permissionOverwrites.cache.get(id);
  assert.ok(get(TV.guild).deny.has(P.Connect), 'verrou conservé');
  assert.ok(get(TV.guild).deny.has(P.ViewChannel), 'masquage conservé');
  assert.ok(get(TV.memberRole).deny.has(P.Connect | P.ViewChannel));
  assert.ok(get(TV.carol).deny.has(P.Connect), 'bannissement conservé');
  assert.ok(get('200000000000000007').allow.has(P.Connect), 'autorisation conservée');
  assert.ok(get(TV.owner).allow.has(P.Connect));
  const row = w.repo.get(ch.id);
  assert.deepEqual([row.locked, row.hidden], [1, 1]);
  await tick();
  assert.equal(w.service.locks.size, 0, 'file d\'attente retirée une fois vide');
});

test('panneau : deux réclamations simultanées → une seule réussit', async () => {
  const w = tvWorld();
  const ch = await w.join();
  for (const id of [TV.bob, TV.carol]) ch.members.set(id, w.guild.members.cache.get(id));
  ch.members.delete(TV.owner);
  const results = await Promise.allSettled([w.service.claim(ch, TV.bob), w.service.claim(ch, TV.carol)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(w.repo.get(ch.id).owner_id, TV.bob);
});

test('suppression : bots ignorés, ligne gardée si la suppression échoue, oubliée si déjà supprimé (10003)', async () => {
  const w = tvWorld();
  const ch = await w.join();
  ch.members.set(TV.music, w.guild.members.cache.get(TV.music));
  ch.deleteError = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  ch.members.delete(TV.owner);
  await w.leave(ch, TV.owner);
  assert.ok(w.repo.get(ch.id), 'échec de suppression : le vocal reste suivi (pas d\'orphelin)');
  ch.deleteError = null;
  await w.leave(ch, TV.owner);
  assert.equal(w.repo.get(ch.id), undefined, 'un bot seul ne garde pas le salon en vie');
  assert.ok(!w.guild.channels.cache.has(ch.id));

  w.service.hubCooldowns.release(`${TV.guild}:${TV.bob}`);
  const ch2 = await w.join(TV.bob);
  ch2.deleteError = Object.assign(new Error('Unknown Channel'), { code: 10003 });
  ch2.members.delete(TV.bob);
  await w.leave(ch2, TV.bob);
  assert.equal(w.repo.get(ch2.id), undefined);
});

test('nettoyage au démarrage : bots ignorés, échec de suppression → ligne gardée', async () => {
  const w = tvWorld();
  const a = await w.join();
  const b = await w.join(TV.bob);
  a.members.clear();
  a.members.set(TV.music, w.guild.members.cache.get(TV.music));
  b.members.clear();
  b.deleteError = new Error('Missing Permissions');
  w.guild.channels.fetch = async (id) => w.guild.channels.cache.get(id) ?? null;
  const res = await w.service.cleanup({ guilds: { cache: new Map([[TV.guild, w.guild]]) } });
  assert.deepEqual(res, { deleted: 1, dropped: 0 });
  assert.equal(w.repo.get(a.id), undefined);
  assert.ok(w.repo.get(b.id));
});

test('expulsion : un échec n\'interrompt pas les autres, seuls les expulsés sont annoncés', async () => {
  const w = tvWorld();
  const ch = await w.join();
  const [bob, carol] = [TV.bob, TV.carol].map((id) => w.guild.members.cache.get(id));
  ch.members.set(TV.bob, bob).set(TV.carol, carol);
  bob.disconnectError = new Error('Unknown Member');
  const res = await w.service.kick(ch, [TV.bob, TV.carol], { actorId: TV.owner, staff: false });
  assert.deepEqual(res.done, [TV.carol]);
});

test('/tempvoice : panel() null (salon disparu) → pas d\'editReply(null) ; setup refuse un vocal temporaire comme hub', async () => {
  const w = tvWorld();
  const ch = await w.join();
  const calls = [];
  const i = {
    guild: w.guild,
    guildId: TV.guild,
    channelId: ch.id,
    user: { id: TV.owner, toString: () => `<@${TV.owner}>` },
    member: { permissions: perm(0n), guild: w.guild },
    memberPermissions: perm(PermissionsBitField.All),
    fields: { getTextInputValue: () => '4' },
    deferUpdate: async () => calls.push(['deferUpdate']),
    editReply: async (p) => calls.push(['editReply', p]),
    followUp: async (p) => calls.push(['followUp', p]),
  };
  w.service.setLimit = async () => w.repo.delete(ch.id); // le salon disparaît pendant l'action
  await tempvoice.buttons.limitsubmit(i, w.client);
  assert.ok(!calls.some(([k, p]) => k === 'editReply' && p == null));
  assert.equal(calls.at(-1)[0], 'followUp');
  assert.equal(calls.at(-1)[1].ephemeral, true);

  const ch2 = await w.join(TV.bob);
  const setup = {
    guild: w.guild,
    memberPermissions: perm(PermissionsBitField.All),
    options: { getSubcommand: () => 'setup', getChannel: (name) => (name === 'hub' ? ch2 : null) },
    reply: async () => assert.fail('ne doit pas répondre'),
  };
  await assert.rejects(tempvoice.execute(setup, w.client), /ne peut pas servir de salon créateur/);
  assert.equal(w.config.get(TV.guild).tempVoice.hubChannelId, TV.hub);
});
