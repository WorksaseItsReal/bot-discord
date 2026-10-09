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
  assert.ok(fetches <= 4, `${fetches} lectures pour 20 arrivées (une par arrivée avant le correctif)`);
  const lag = Math.max(...arrivals.map(([id, at]) => welcomed.find(([w]) => w === id)[1] - at));
  assert.ok(lag < 30, `accueil retardé de ${lag} ms par le suivi des invitations`);
  assert.equal(logs.length, 20);
  // Chaque arrivée reste enregistrée (attribuée quand une seule invitation a servi).
  assert.equal(joins.stats(GUILD, INVITER).regular + db.prepare('SELECT COUNT(*) AS n FROM invite_joins WHERE inviter_id IS NULL').get().n, 20);
});
