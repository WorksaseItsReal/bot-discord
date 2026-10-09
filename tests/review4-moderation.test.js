'use strict';

/**
 * Régressions de la revue n° 4 (signalements, invitations, niveaux, sauvegardes,
 * compteurs, lockdown) : tests unitaires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { InviteJoinRepository } = require('../src/database/repositories/InviteJoinRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { InviteTrackerService } = require('../src/services/InviteTrackerService');
const guildMemberAdd = require('../src/events/guildMemberAdd');

const GUILD = '100000000000000001';
const INVITER = '200000000000000001';
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ arrivées et invitations

/** Serveur dont la lecture des invitations prend `latency` ms (compte les lectures). */
function slowInviteGuild(latency) {
  const state = { uses: 0, fetches: 0 };
  const guild = {
    id: GUILD,
    available: true,
    vanityURLCode: null,
    memberCount: 100,
    members: { me: { permissions: { has: () => true } } },
    invites: {
      fetch: async () => {
        state.fetches += 1;
        const uses = state.uses; // instantané au début de la lecture
        await sleep(latency);
        return new Collection([['abc', { code: 'abc', uses, maxUses: 0, inviterId: INVITER, channelId: '1', expiresTimestamp: null }]]);
      },
    },
  };
  return { guild, state };
}

function joinClient({ invites, welcomed, logs }) {
  return {
    services: {
      invites,
      antiraid: { handleJoin: async () => ({ punished: false }) },
      logging: { send: async (guildId, category, embed) => logs.push(embed) },
      welcome: { handleJoin: async (m) => welcomed.push([m.id, Date.now()]) },
      moderation: { mutedRole: () => null },
    },
    repositories: { sanctions: { activeMute: () => null } },
  };
}

const memberOf = (guild, id) => ({ id, guild, user: { id, bot: false, createdTimestamp: Date.now() - 400 * DAY, toString: () => `<@${id}>` } });
const fieldsOf = (embed) => (typeof embed?.toJSON === 'function' ? embed.toJSON() : embed).fields ?? [];

test('arrivée : l\'accueil (rôles, vérification) et le mute n\'attendent jamais le suivi des invitations', async () => {
  const welcomed = [];
  const logs = [];
  // Lecture des invitations qui ne se termine jamais (file en retard, 429…).
  const invites = { logWaitMs: 60, handleJoin: () => new Promise(() => {}) };
  const client = joinClient({ invites, welcomed, logs });
  const guild = { id: GUILD, memberCount: 10 };
  const keepAlive = setInterval(() => {}, 1_000); // le délai du log est « unref »
  const start = Date.now();
  const run = guildMemberAdd.execute(client, memberOf(guild, '300000000000000001'));
  await sleep(20);
  assert.equal(welcomed.length, 1, 'accueil bloqué par la lecture des invitations');
  assert.ok(welcomed[0][1] - start < 50);
  await run;
  clearInterval(keepAlive);
  assert.equal(logs.length, 1, 'log d\'arrivée absent');
  const line = fieldsOf(logs[0]).find((f) => /Invitation/.test(f.name));
  assert.match(line?.value ?? '', /trop lente/);
});

test('rafale d\'arrivées : une lecture des invitations par lot, accueil immédiat pour chacun', async () => {
  const { guild, state } = slowInviteGuild(40);
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const joins = new InviteJoinRepository(db);
  const invites = new InviteTrackerService({ client: { guilds: { cache: new Collection([[GUILD, guild]]) } }, joins, config });
  invites.logWaitMs = 5_000;
  await invites.refresh(guild);
  const before = state.fetches;
  const welcomed = [];
  const logs = [];
  const client = joinClient({ invites, welcomed, logs });

  const arrivals = [];
  const runs = [];
  for (let i = 0; i < 20; i++) {
    state.uses += 1;
    const id = `30000000000000${String(1000 + i)}`;
    arrivals.push([id, Date.now()]);
    runs.push(guildMemberAdd.execute(client, memberOf(guild, id)));
    await sleep(5);
  }
  await Promise.all(runs);
  const fetches = state.fetches - before;
  assert.ok(fetches <= 10, `${fetches} lectures pour 20 arrivées (une par arrivée avant le correctif)`);
  const lag = Math.max(...arrivals.map(([id, at]) => welcomed.find(([w]) => w === id)[1] - at));
  assert.ok(lag < 250, `accueil retardé de ${lag} ms par le suivi des invitations`);
  assert.equal(logs.length, 20);
  // Chaque arrivée reste enregistrée (attribuée quand une seule invitation a servi).
  assert.equal(joins.stats(GUILD, INVITER).regular + db.prepare('SELECT COUNT(*) AS n FROM invite_joins WHERE inviter_id IS NULL').get().n, 20);
});

// ------------------------------------------------------------ niveaux : membres partis

const { LevelRepository } = require('../src/database/repositories/LevelRepository');
const { LevelService } = require('../src/services/LevelService');

function levelWorld() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update(GUILD, { levels: { enabled: true } });
  const repo = new LevelRepository(db);
  const svc = new LevelService({ client: { services: {} }, levels: repo, config, grantDelayMs: 20 });
  const cache = new Map();
  const guild = { id: GUILD, members: { me: null, cache }, roles: { cache: new Map() } };
  return { repo, svc, guild, cache };
}

test('niveaux : un message suivi d\'un départ ne remet pas le membre parti au classement', async () => {
  const { repo, svc, guild, cache } = levelWorld();
  const USER = '300000000000000099';
  const member = { id: USER, guild, roles: { cache: new Map() } };
  cache.set(USER, member);
  repo.add(GUILD, USER, { xp: 100 }, () => 1);
  const message = { id: '1', guild, author: { id: USER, bot: false }, member, channel: { id: '2' }, content: 'Bye tout le monde, je m\'en vais !', webhookId: null, system: false };
  assert.equal(svc.handleMessage(message), true);
  // Départ juste après le message (guildMemberRemove) : sorti du cache, marque posée.
  cache.delete(USER);
  svc.markLeft(GUILD, USER);
  await sleep(80);
  assert.notEqual(repo.get(GUILD, USER).left_at, null, 'marque de départ effacée par le gain différé');
  assert.equal(repo.rank(GUILD, USER), null);

  // Membre toujours présent mais marqué parti (marque ancienne) : un gain la retire.
  cache.set(USER, member);
  svc.cooldowns.clear();
  assert.equal(svc.handleMessage({ ...message, id: '3' }), true);
  await sleep(80);
  assert.equal(repo.get(GUILD, USER).left_at, null);
  assert.equal(repo.rank(GUILD, USER), 1);
});

// ------------------------------------------------------------ archives : arrêt du bot

const T = require('../src/utils/transcriptArchive');

test('archive : l\'arrêt du bot abandonne les téléchargements en cours et restants', async () => {
  const controller = new AbortController();
  const url = (name) => `https://cdn.discordapp.com/attachments/1/2/${name}`;
  const messages = [{ id: '1', author: { tag: 'alice' }, attachments: new Collection([['a', { name: 'a.png', url: url('a.png'), size: 10 }], ['b', { name: 'b.png', url: url('b.png'), size: 10 }]]), embeds: [] }];
  const calls = [];
  const fetchImpl = (u, { signal } = {}) => {
    calls.push(u);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abandon'), { name: 'AbortError' }))));
  };
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const { files, skipped } = await T.collectAttachments(messages, { fetchImpl, signal: controller.signal });
  assert.ok(Date.now() - started < 1_000, 'téléchargement non abandonné');
  assert.equal(files.length, 0);
  assert.equal(calls.length, 1, 'téléchargement lancé après l\'arrêt');
  assert.deepEqual(skipped.map((s) => s.reason), ['arrêt du bot', 'arrêt du bot']);
});

// ------------------------------------------------------------ lockdown automatique et verrou global

const { PermissionFlagsBits: F, ChannelType } = require('discord.js');
const { LockRepository } = require('../src/database/repositories/LockRepository');
const { LockdownService } = require('../src/services/LockdownService');
const { AntiRaidService } = require('../src/services/AntiRaidService');

/** Salon textuel factice ; chaque modification de permissions prend `latency` ms. */
function lockableChannel(id, guild, latency = 0) {
  const ow = { allow: { bitfield: 0n }, deny: { bitfield: 0n } };
  const apply = async (perms) => {
    if (latency) await sleep(latency);
    for (const [flag, v] of Object.entries(perms)) {
      const bit = F[flag];
      ow.allow.bitfield &= ~bit;
      ow.deny.bitfield &= ~bit;
      if (v === true) ow.allow.bitfield |= bit;
      if (v === false) ow.deny.bitfield |= bit;
    }
  };
  return {
    id,
    type: ChannelType.GuildText,
    manageable: true,
    guild,
    isThread: () => false,
    permissionOverwrites: {
      cache: new Map([[guild.id, ow]]),
      edit: async (_t, perms) => apply(perms),
      delete: async () => apply({ SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null }),
    },
    sendDenied: () => Boolean(ow.deny.bitfield & F.SendMessages),
  };
}

function lockWorld(latency) {
  const { db } = memoryDb();
  const svc = new LockdownService({ locks: new LockRepository(db), logging: { send: async () => {} } });
  const guild = { id: 'g1', roles: { everyone: { id: 'g1' } }, channels: { cache: new Map() } };
  const ch = lockableChannel('c1', guild, latency);
  guild.channels.cache.set(ch.id, ch);
  return { svc, guild, ch };
}

test('lockdown automatique : attend une levée en cours puis verrouille (jamais abandonné)', async () => {
  const { svc, guild, ch } = lockWorld(40);
  await svc.enable(guild, null, 'Lockdown manuel');
  assert.ok(ch.sendDenied());
  const lifting = svc.disable(guild, null); // un admin lève le lockdown…
  await assert.rejects(svc.enable(guild, null, 'Double clic'), /déjà en cours/);
  // … pendant qu'une vague arrive : l'AntiRaid attend la levée, puis reverrouille.
  const n = await svc.enable(guild, null, 'AntiRaid automatique', { log: false, wait: true });
  await lifting;
  assert.equal(n, 1);
  assert.ok(ch.sendDenied(), 'serveur laissé ouvert pendant le raid');
  assert.equal(svc.status(guild), 1);
  assert.equal(svc.isBusy(guild.id), false);
});

test('alerte de vague : lockdown non appliqué signalé, avec bouton de nouvelle tentative', async () => {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update(GUILD, { antiraid: { enabled: true, action: 'lockdown', joinThreshold: 2, joinWindowSeconds: 10 } });
  const alerts = [];
  const client = { user: { id: '999' }, services: { lockdown: { enable: async () => { throw new Error('Missing Permissions'); }, status: () => 0 } } };
  const antiraid = new AntiRaidService({ client, config, logging: { send: async () => {} } });
  antiraid.alert = async (guild, payload) => alerts.push(payload);
  const guild = { id: GUILD, ownerId: '1', members: { me: { id: '999' }, cache: new Map() } };
  for (const id of ['300000000000000001', '300000000000000002']) {
    await antiraid.handleJoin({ id, guild, user: { id, bot: false, createdTimestamp: Date.now() - 400 * DAY }, roles: { cache: new Map() } });
  }
  assert.equal(alerts.length, 1, 'alerte de vague absente');
  const lockField = alerts[0].fields.find((f) => /Lockdown/.test(f?.name ?? ''));
  assert.match(lockField.value, /non appliqué/);
  const ids = alerts[0].buttons.map((b) => (typeof b.toJSON === 'function' ? b.toJSON() : b).custom_id);
  assert.deepEqual(ids, ['cmd:lockdown:enable']);
});

// ------------------------------------------------------------ compteurs : limite de renommage

const { IntentsBitField } = require('discord.js');
const { intents } = require('../src/config/intents');
const { StatsCounterService } = require('../src/services/StatsCounterService');

test('compteurs : un renommage bloqué par la limite de Discord ne bloque pas la mise à jour', { timeout: 5_000 }, async (t) => {
  const keepAlive = setInterval(() => {}, 1_000); // minuteurs du service « unref »
  t.after(() => clearInterval(keepAlive));
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  let calls = 0;
  const channel = {
    id: '500000000000000001',
    name: '👥 Membres : 3',
    type: 2,
    permissionsFor: () => ({ has: () => true }),
    setName: () => {
      calls += 1;
      return new Promise(() => {}); // discord.js attend la fin de la fenêtre (jusqu'à 10 min)
    },
  };
  const guild = {
    id: GUILD,
    available: true,
    memberCount: 4,
    members: { cache: new Collection(), me: { id: '999' } },
    roles: { cache: new Collection([[GUILD, {}]]) },
    channels: { cache: new Collection([[channel.id, channel]]) },
  };
  channel.guild = guild;
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) }, options: { intents: new IntentsBitField(intents) } };
  const svc = new StatsCounterService({ client, config });
  svc.renameTimeoutMs = 30;
  config.update(GUILD, { statsCounters: { counters: { members: { enabled: true, channelId: channel.id } } } });

  const started = Date.now();
  const first = await svc.update(guild);
  assert.ok(Date.now() - started < 1_000, 'mise à jour bloquée par le renommage');
  assert.deepEqual(first.waiting, ['members']);
  assert.equal(svc.running.size, 0, 'mise à jour encore marquée en cours');
  // Fenêtre écoulée, renommage précédent toujours bloqué : pas de second appel empilé.
  config.update(GUILD, { statsCounters: { counters: { members: { renamedAt: 0 } } } });
  const second = await svc.update(guild);
  assert.deepEqual(second.waiting, ['members']);
  assert.equal(calls, 1);
  await svc.stop();
});

// ------------------------------------------------------------ départs manqués (bot hors ligne)

const departures = require('../src/events/departuresReconcile');
const { levelFromXp } = require('../src/services/LevelService');

function reconcileWorld({ withMembersIntent = true, complete = true } = {}) {
  const { db } = memoryDb();
  const levels = new LevelRepository(db);
  const inviteJoins = new InviteJoinRepository(db);
  const present = new Collection([['A', {}], ['B', {}], ['C', {}]]);
  let fetches = 0;
  const guild = {
    id: GUILD,
    available: true,
    memberCount: 3,
    members: {
      cache: complete ? present : new Collection([['A', {}]]),
      fetch: async () => {
        fetches += 1;
        if (complete) return;
        throw new Error('GuildMembersTimeout');
      },
    },
  };
  const intentsList = withMembersIntent ? intents : intents.filter((i) => i !== require('discord.js').GatewayIntentBits.GuildMembers);
  const client = { options: { intents: new IntentsBitField(intentsList) }, guilds: { cache: new Collection([[GUILD, guild]]) }, repositories: { levels, inviteJoins } };
  // A présent, D parti pendant que le bot était hors ligne, C revenu hors ligne (marqué parti avant).
  levels.add(GUILD, 'A', { xp: 50 }, levelFromXp);
  levels.add(GUILD, 'D', { xp: 900 }, levelFromXp);
  levels.add(GUILD, 'C', { xp: 10 }, levelFromXp);
  levels.markLeft(GUILD, 'C', 1);
  inviteJoins.recordJoin({ guildId: GUILD, userId: 'A', inviterId: INVITER, code: 'x' });
  inviteJoins.recordJoin({ guildId: GUILD, userId: 'D', inviterId: INVITER, code: 'x' });
  return { client, guild, levels, inviteJoins, fetches: () => fetches };
}

test('départs manqués : rattrapés au démarrage (niveaux et invitations) d\'après la liste complète', async () => {
  const w = reconcileWorld();
  assert.equal(w.levels.rank(GUILD, 'D'), 1, 'membre parti hors ligne encore premier du classement');
  const res = await departures.reconcileGuild(w.client, w.guild);
  assert.deepEqual(res, { levels: { left: 1, returned: 1 }, invites: 1 });
  assert.equal(w.levels.rank(GUILD, 'D'), null);
  assert.equal(w.levels.rank(GUILD, 'A'), 1);
  assert.notEqual(w.levels.rank(GUILD, 'C'), null, 'membre revenu hors ligne absent du classement');
  assert.deepEqual(w.inviteJoins.stats(GUILD, INVITER), { regular: 2, left: 1, fake: 0, net: 1 });
  assert.equal(w.fetches(), 0, 'liste déjà complète : aucune lecture');
});

test('départs manqués : liste des membres incomplète ou intent absent → personne n\'est marqué parti', async () => {
  const partial = reconcileWorld({ complete: false });
  assert.equal(await departures.reconcileGuild(partial.client, partial.guild), null);
  assert.equal(partial.fetches(), 1, 'une seule lecture des membres par serveur');
  assert.equal(partial.levels.rank(GUILD, 'D'), 1);
  const noIntent = reconcileWorld({ withMembersIntent: false });
  assert.equal(await departures.reconcileGuild(noIntent.client, noIntent.guild), null);
  assert.equal(noIntent.fetches(), 0);
  // Arrêt du bot : rien n'est fait.
  const stopping = reconcileWorld();
  stopping.client.shutdownPromise = Promise.resolve();
  assert.equal(await departures.reconcileGuild(stopping.client, stopping.guild), null);
  assert.equal(stopping.levels.rank(GUILD, 'D'), 1);
});
