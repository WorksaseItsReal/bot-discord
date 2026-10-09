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
