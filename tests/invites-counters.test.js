'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, GatewayIntentBits, IntentsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { intents } = require('../src/config/intents');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { InviteJoinRepository } = require('../src/database/repositories/InviteJoinRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { InviteTrackerService, describeJoin } = require('../src/services/InviteTrackerService');
const C = require('../src/services/StatsCounterService');
const compteurs = require('../src/commands/configuration/compteurs');
const invitations = require('../src/commands/information/invitations');

const GUILD = '100000000000000001';
const BOT = '999999999999999999';
const ADMIN = '200000000000000001';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const DAY = 86_400_000;
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

function setup() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const joins = new InviteJoinRepository(db);
  return { db, config, joins };
}

// ------------------------------------------------------------ migration, intents

test('migration 14 : invite_joins et index (guild_id, inviter_id), en fin de tableau', () => {
  const m = migrations.find((x) => x.id === 14);
  assert.ok(m, 'migration 14 absente');
  assert.equal(migrations.indexOf(m), migrations.length - 1);
  const { db } = setup();
  const cols = db.prepare('PRAGMA table_info(invite_joins)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'guild_id', 'user_id', 'inviter_id', 'code', 'joined_at', 'left_at', 'fake']);
  const idx = db.prepare('PRAGMA index_list(invite_joins)').all().map((i) => i.name);
  assert.ok(idx.includes('idx_invite_joins_inviter'));
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_invite_joins_inviter)').all().map((c) => c.name), ['guild_id', 'inviter_id']);
});

test('intents : GuildInvites activé, GuildPresences non (pas de compteur « En ligne »)', () => {
  assert.ok(intents.includes(GatewayIntentBits.GuildInvites));
  assert.ok(!intents.includes(GatewayIntentBits.GuildPresences));
  const client = { options: { intents: new IntentsBitField(intents) } };
  assert.equal(C.hasPresenceIntent(client), false);
  assert.ok(!C.availableTypes(client).includes('online'));
  const withPresence = { options: { intents: new IntentsBitField([...intents, GatewayIntentBits.GuildPresences]) } };
  assert.ok(C.availableTypes(withPresence).includes('online'));
});

// ------------------------------------------------------------ dépôt

test('InviteJoinRepository : réelles, départs, fausses, net, classement, remise à zéro', () => {
  const { joins } = setup();
  joins.recordJoin({ guildId: GUILD, userId: '1', inviterId: ADMIN, code: 'a' });
  joins.recordJoin({ guildId: GUILD, userId: '2', inviterId: ADMIN, code: 'a' });
  joins.recordJoin({ guildId: GUILD, userId: '3', inviterId: ADMIN, code: 'a', fake: true });
  joins.recordJoin({ guildId: GUILD, userId: '4', inviterId: ALICE, code: 'b' });
  joins.recordJoin({ guildId: GUILD, userId: '5', inviterId: null, code: null });
  assert.equal(joins.markLeft(GUILD, '2'), true);
  assert.equal(joins.markLeft(GUILD, '2'), false, 'déjà parti');
  assert.deepEqual(joins.stats(GUILD, ADMIN), { regular: 2, left: 1, fake: 1, net: 1 });
  assert.deepEqual(joins.stats(GUILD, BOB), { regular: 0, left: 0, fake: 0, net: 0 });
  // Retour du membre : nouvelle arrivée, l'ancienne garde son départ.
  joins.recordJoin({ guildId: GUILD, userId: '2', inviterId: ADMIN, code: 'a' });
  assert.deepEqual(joins.stats(GUILD, ADMIN), { regular: 3, left: 1, fake: 1, net: 2 });
  const board = joins.leaderboard(GUILD, 10, 0);
  assert.deepEqual(board.map((r) => [r.inviterId, r.net]), [[ADMIN, 2], [ALICE, 1]]);
  assert.equal(joins.inviterCount(GUILD), 2);
  assert.equal(joins.reset(GUILD, ALICE), 1);
  assert.equal(joins.inviterCount(GUILD), 1);
  assert.ok(joins.reset(GUILD) >= 4);
  assert.equal(joins.inviterCount(GUILD), 0);
});

// ------------------------------------------------------------ service des invitations

function inviteGuild({ perms = true, vanity = null } = {}) {
  const state = { list: [], vanityUses: 0, fetches: 0 };
  const guild = {
    id: GUILD,
    available: true,
    vanityURLCode: vanity,
    members: { me: { permissions: { has: () => perms } } },
    invites: {
      fetch: async () => {
        state.fetches += 1;
        await new Promise((r) => setImmediate(r));
        return new Collection(state.list.map((i) => [i.code, { ...i }]));
      },
    },
    fetchVanityData: async () => ({ code: vanity, uses: state.vanityUses }),
  };
  const add = (code, inviterId, extra = {}) => {
    const inv = { code, uses: 0, maxUses: 0, inviterId, channelId: '1', expiresTimestamp: null, ...extra };
    state.list.push(inv);
    return inv;
  };
  return { guild, state, add };
}

function memberOf(guild, id, { ageDays = 400, bot = false } = {}) {
  return { id, guild, user: { id, bot, createdTimestamp: Date.now() - ageDays * DAY } };
}

function tracker(guild) {
  const { config, joins } = setup();
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  return { svc: new InviteTrackerService({ client, joins, config }), joins, config };
}

test('InviteTrackerService : invitation utilisée, compte récent, inconnue, plusieurs candidates', async () => {
  const { guild, add } = inviteGuild();
  const { svc, joins } = tracker(guild);
  const a = add('alpha', ADMIN);
  const b = add('beta', ALICE, { uses: 4 });
  await svc.refreshAll();
  assert.equal(svc.state(guild), 'ok');

  a.uses = 1;
  let r = await svc.handleJoin(memberOf(guild, '11'));
  assert.deepEqual([r.kind, r.code, r.inviterId, r.count, r.fake], ['invite', 'alpha', ADMIN, 1, false]);
  assert.match(describeJoin(r), /Invité par <@200000000000000001> via `alpha` \(\*\*1 invitation\*\*\)/);

  a.uses = 2;
  r = await svc.handleJoin(memberOf(guild, '12', { ageDays: 2 }));
  assert.equal(r.fake, true);
  assert.match(describeJoin(r), /fausse/);
  assert.deepEqual(joins.stats(GUILD, ADMIN), { regular: 1, left: 0, fake: 1, net: 1 });

  a.uses = 3;
  b.uses = 5;
  r = await svc.handleJoin(memberOf(guild, '13'));
  assert.deepEqual([r.kind, r.reason], ['unknown', 'multiple']);
  assert.match(describeJoin(r), /plusieurs/);

  r = await svc.handleJoin(memberOf(guild, '14'));
  assert.deepEqual([r.kind, r.reason], ['unknown', 'none']);
  assert.equal(describeJoin(r), 'Invitation inconnue');

  // Départ : la dernière arrivée de 11 est close.
  assert.equal(svc.handleLeave(memberOf(guild, '11')), true);
  assert.deepEqual(joins.stats(GUILD, ADMIN), { regular: 1, left: 1, fake: 1, net: 0 });
});

test('InviteTrackerService : usage unique supprimé, INVITE_CREATE/DELETE, lien personnalisé, OAuth, arrivées simultanées', async () => {
  const { guild, state, add } = inviteGuild({ vanity: 'cool' });
  const { svc } = tracker(guild);
  const once = add('once', ALICE, { maxUses: 1 });
  await svc.refresh(guild);

  // Discord supprime l'invitation à usage unique : absente du nouvel instantané.
  state.list.splice(state.list.indexOf(once), 1);
  let r = await svc.handleJoin(memberOf(guild, '21'));
  assert.deepEqual([r.kind, r.code, r.inviterId], ['invite', 'once', ALICE]);

  // INVITE_DELETE reçu AVANT l'arrivée.
  const once2 = add('once2', BOB, { maxUses: 2, uses: 1 });
  svc.onCreate({ ...once2, guild: { id: GUILD } });
  state.list.splice(state.list.indexOf(once2), 1);
  svc.onDelete({ code: 'once2', guild: { id: GUILD } });
  r = await svc.handleJoin(memberOf(guild, '22'));
  assert.deepEqual([r.kind, r.code], ['invite', 'once2']);

  // Lien personnalisé.
  state.vanityUses += 1;
  r = await svc.handleJoin(memberOf(guild, '23'));
  assert.deepEqual([r.kind, r.code], ['vanity', 'cool']);
  assert.match(describeJoin(r), /discord\.gg\/cool/);

  // Bot ajouté par OAuth2 : aucune lecture, aucune ligne.
  const before = state.fetches;
  r = await svc.handleJoin(memberOf(guild, '24', { bot: true }));
  assert.equal(r.kind, 'oauth');
  assert.equal(state.fetches, before);
  assert.match(describeJoin(r), /OAuth2/);

  // Deux arrivées simultanées sur la même invitation : traitées l'une après l'autre.
  const x = add('x', ADMIN);
  svc.onCreate({ ...x, guild: { id: GUILD } });
  x.uses = 2; // les deux utilisations sont déjà visibles au premier fetch
  const [r1, r2] = await Promise.all([svc.handleJoin(memberOf(guild, '25')), svc.handleJoin(memberOf(guild, '26'))]);
  assert.equal(r1.kind, 'invite');
  assert.equal(r1.code, 'x');
  assert.equal(r2.kind, 'unknown', 'la seconde ne doit pas compter deux fois la même utilisation');
  assert.deepEqual(svc.invitesOf(GUILD, ADMIN).map((e) => e.code), ['x']);
});

test('InviteTrackerService : sans « Gérer le serveur », aucune lecture et arrivée « inconnue »', async () => {
  const { guild, state, add } = inviteGuild({ perms: false });
  const { svc, joins } = tracker(guild);
  add('alpha', ADMIN, { uses: 3 });
  await svc.refreshAll();
  assert.equal(state.fetches, 0);
  assert.equal(svc.state(guild), 'noperm');
  const r = await svc.handleJoin(memberOf(guild, '31'));
  assert.deepEqual([r.kind, r.reason], ['unknown', 'noperm']);
  assert.match(describeJoin(r), /Gérer le serveur/);
  assert.equal(state.fetches, 0);
  assert.ok(joins.lastJoin(GUILD, '31'), 'arrivée tout de même enregistrée');
});

test('InviteTrackerService : seuil des fausses invitations réglable (0 = jamais)', async () => {
  const { guild, add } = inviteGuild();
  const { svc, config } = tracker(guild);
  const a = add('alpha', ADMIN);
  await svc.refresh(guild);
  config.update(GUILD, { invites: { fakeAccountDays: 0 } });
  a.uses = 1;
  const r = await svc.handleJoin(memberOf(guild, '41', { ageDays: 0 }));
  assert.equal(r.fake, false);
  config.update(GUILD, { invites: { fakeAccountDays: 30 } });
  a.uses = 2;
  assert.equal((await svc.handleJoin(memberOf(guild, '42', { ageDays: 20 }))).fake, true);
});

// ------------------------------------------------------------ compteurs : fonctions pures

test('compteurs : modèle, rendu du nom (≤ 100 caractères), valeurs', () => {
  assert.equal(C.renderName('👥 Membres : {n}', 12345), '👥 Membres : 12 345');
  assert.equal([...C.renderName(`${'x'.repeat(98)} {n}`, 1000)].length, 100);
  assert.equal(C.validateTemplate('  🎭  Rôles : {n} '), '🎭 Rôles : {n}');
  assert.throws(() => C.validateTemplate('Sans variable'), /\{n\}/);
  assert.throws(() => C.validateTemplate(''), /vide/);
  assert.throws(() => C.validateTemplate(`${'x'.repeat(100)}{n}`), /100/);
  const members = new Collection([
    ['1', { user: { bot: false } }],
    ['2', { user: { bot: true } }],
    ['3', { user: { bot: false }, presence: { status: 'online' } }],
  ]);
  const channels = new Collection([
    ['a', { type: ChannelType.GuildCategory }],
    ['b', { type: ChannelType.GuildText, isThread: () => false }],
    ['c', { type: ChannelType.GuildVoice, isThread: () => false }],
    ['d', { type: ChannelType.PublicThread, isThread: () => true }],
  ]);
  const v = C.computeValues({ memberCount: 10, members: { cache: members }, channels: { cache: channels }, premiumSubscriptionCount: 4, roles: { cache: new Collection([['r0', {}], ['r1', {}], ['r2', {}]]) } });
  assert.deepEqual(v, { members: 10, humans: 9, bots: 1, online: 1, boosts: 4, channels: 2, roles: 2 });
});

// ------------------------------------------------------------ compteurs : service

function counterGuild() {
  const channels = new Collection();
  const guild = {
    id: GUILD,
    available: true,
    memberCount: 3,
    premiumSubscriptionCount: 0,
    members: { cache: new Collection([['1', { user: { bot: false } }], ['2', { user: { bot: false } }], ['3', { user: { bot: true } }]]), me: { id: BOT, permissions: { has: () => true } }, fetch: async () => {} },
    roles: { cache: new Collection([[GUILD, {}]]) },
    channels: {
      cache: channels,
      create: async (opts) => {
        const id = String(500000000000000000n + BigInt(channels.size));
        const ch = voice(guild, id, opts.name, { type: opts.type, parentId: opts.parent ?? null, overwrites: opts.permissionOverwrites });
        channels.set(id, ch);
        return ch;
      },
    },
  };
  return guild;
}

function voice(guild, id, name, extra = {}) {
  const ch = {
    id,
    name,
    guild,
    type: ChannelType.GuildVoice,
    renames: 0,
    manageable: true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => ch.manageable }),
    setName: async (n) => {
      ch.renames += 1;
      ch.name = n;
    },
    delete: async () => {
      if (!ch.manageable) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      guild.channels.cache.delete(id);
    },
    ...extra,
  };
  return ch;
}

function counters() {
  const guild = counterGuild();
  const { config } = setup();
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) }, options: { intents: new IntentsBitField(intents) } };
  const svc = new C.StatsCounterService({ client, config });
  return { guild, config, svc, client };
}

test('StatsCounterService : création verrouillée, renommage seulement si la valeur change, 1 / 10 min', async () => {
  const { guild, svc, config } = counters();
  const { category, created } = await svc.create(guild, ['members', 'humans', 'online']);
  assert.deepEqual(created, ['members', 'humans'], '« En ligne » ignoré sans l\'intent des présences');
  assert.equal(category.type, ChannelType.GuildCategory);
  const members = guild.channels.cache.get(svc.counter(GUILD, 'members').channelId);
  assert.equal(members.name, '👥 Membres : 3');
  assert.equal(members.parentId, category.id);
  assert.deepEqual(members.overwrites[0], { id: GUILD, deny: [require('discord.js').PermissionFlagsBits.Connect] });

  // Valeur inchangée : aucun renommage.
  let s = await svc.update(guild);
  assert.deepEqual(s.unchanged.sort(), ['humans', 'members']);
  assert.equal(members.renames, 0);

  // Valeur changée : un renommage, puis attente de la fenêtre de 10 minutes.
  guild.memberCount = 4;
  s = await svc.update(guild);
  assert.deepEqual(s.renamed.sort(), ['humans', 'members']);
  assert.equal(members.name, '👥 Membres : 4');
  guild.memberCount = 5;
  s = await svc.update(guild);
  assert.deepEqual(s.waiting.sort(), ['humans', 'members']);
  assert.equal(members.renames, 1);
  assert.ok(svc.nextRenameAt(GUILD, 'members') > Date.now());
  assert.ok(svc.timers.has(GUILD), 'nouvel essai programmé à l\'ouverture de la fenêtre');

  // Fenêtre écoulée (renamedAt persisté) : renommé.
  config.update(GUILD, { statsCounters: { counters: { members: { renamedAt: Date.now() - C.RENAME_WINDOW_MS - 1 } } } });
  s = await svc.update(guild);
  assert.ok(s.renamed.includes('members'));
  assert.equal(members.name, '👥 Membres : 5');
  await svc.stop();
  assert.equal(svc.timers.size, 0, 'minuteurs arrêtés');
});

test('StatsCounterService : salon supprimé à la main, permissions manquantes, anti-rebond', async () => {
  const { guild, svc } = counters();
  await svc.create(guild, ['members', 'bots', 'roles']);
  const rolesId = svc.counter(GUILD, 'roles').channelId;
  guild.channels.cache.delete(rolesId);
  guild.memberCount = 9;
  const bots = guild.channels.cache.get(svc.counter(GUILD, 'bots').channelId);
  bots.manageable = false;
  svc.setTemplate(GUILD, 'bots', '🤖 {n} robots');
  const s = await svc.update(guild);
  assert.deepEqual(s.removed, ['roles']);
  assert.deepEqual(svc.counter(GUILD, 'roles'), { enabled: false, channelId: null, template: null, renamedAt: 0 });
  assert.deepEqual(s.noperm, ['bots']);
  assert.ok(s.renamed.includes('members'));

  // forgetChannel (CHANNEL_DELETE) sur la catégorie.
  const catId = svc.cfg(GUILD).categoryId;
  assert.equal(svc.forgetChannel(GUILD, catId), true);
  assert.equal(svc.cfg(GUILD).categoryId, null);
  assert.equal(svc.forgetChannel(GUILD, '123'), false);

  // Anti-rebond : un seul minuteur par serveur.
  svc.debounceMs = 60_000;
  assert.equal(svc.schedule(GUILD), true);
  assert.equal(svc.schedule(GUILD), false);
  await svc.stop();
  assert.equal(svc.schedule(GUILD), false, 'aucune planification après l\'arrêt');

  // Suppression totale : le salon sans permission reste configuré.
  svc.stopping = false;
  const { removed, failed } = await svc.removeAll(guild);
  assert.equal(removed, 1);
  assert.deepEqual(failed, ['bots']);
  assert.equal(svc.counter(GUILD, 'bots').channelId, bots.id);
  assert.equal(svc.counter(GUILD, 'members').channelId, null);
});

// ------------------------------------------------------------ rendus des commandes

function checkPayload(payload) {
  assert.ok(payload.components.length <= 5, 'plus de 5 rangées');
  const ids = [];
  for (const row of payload.components.map(json)) {
    for (const c of row.components) {
      if (c.custom_id) {
        assert.ok(c.custom_id.length <= 100);
        ids.push(c.custom_id);
      }
      if (c.options) assert.ok(c.options.length <= 25);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'customId en double');
  const size = JSON.stringify(payload.embeds.map(json)).length;
  assert.ok(size < 6000);
}

test('/compteurs : rendus (accueil, compteur, confirmation) dans les limites', async () => {
  const { guild, svc, client } = counters();
  client.services = { counters: svc };
  checkPayload(compteurs.render(client, guild, 'home'));
  await svc.create(guild, C.availableTypes(client));
  const home = compteurs.render(client, guild, 'home');
  checkPayload(home);
  assert.ok(json(home.components[0]).components[0].options.every((o) => o.value !== 'online'));
  for (const t of C.availableTypes(client)) checkPayload(compteurs.render(client, guild, `counter:${t}`));
  checkPayload(compteurs.render(client, guild, 'confirmRemove'));
  assert.throws(() => compteurs.render(client, guild, 'counter:online'), /disponible/);
  assert.match(compteurs.updateNotice({ renamed: ['a'], unchanged: [], waiting: ['b'], noperm: [], removed: [] }), /1\*\* salon\(s\) renommé.*en attente/);
});

test('/invitations : carte d\'un membre et classement dans les limites', () => {
  const { joins, config } = setup();
  for (let i = 0; i < 25; i += 1) joins.recordJoin({ guildId: GUILD, userId: String(1000 + i), inviterId: String(300000000000000000n + BigInt(i % 13)), code: `c${i}` });
  const invites = { invitesOf: () => Array.from({ length: 12 }, (_, i) => ({ code: `code${i}`, uses: i, maxUses: i % 2 ? 10 : 0, channelId: '1', expiresAt: i % 3 ? Date.now() + DAY : null })), fakeDays: () => 7, state: () => 'ok' };
  const client = { repositories: { inviteJoins: joins }, services: { invites, config } };
  const guild = { id: GUILD, name: 'Test' };
  const user = { id: ADMIN, username: 'admin', toString: () => `<@${ADMIN}>`, displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' };
  const card = invitations.memberView(client, guild, user, ADMIN);
  checkPayload(card);
  assert.match(json(card.embeds[0]).fields.find((f) => f.name.includes('Invitations actives')).value, /autre/);
  const board = invitations.boardView(client, guild, 0, ADMIN);
  checkPayload(board);
  assert.match(json(board.embeds[0]).footer.text, /Page 1\/2/);
  const last = invitations.boardView(client, guild, 99, ADMIN);
  assert.match(json(last.embeds[0]).footer.text, /Page 2\/2/);
  invites.state = () => 'noperm';
  assert.match(json(invitations.memberView(client, guild, user, ADMIN).embeds[0]).description, /Gérer le serveur/);
});
