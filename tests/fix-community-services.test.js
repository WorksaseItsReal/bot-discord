'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { SuggestionRepository } = require('../src/database/repositories/SuggestionRepository');
const { ProjectRepository } = require('../src/database/repositories/ProjectRepository');
const { ModmailRepository } = require('../src/database/repositories/ModmailRepository');
const { GiveawayService, previousWinners, EDIT_DEBOUNCE_MS } = require('../src/services/GiveawayService');
const { ModmailService } = require('../src/services/ModmailService');
const { TicketService } = require('../src/services/TicketService');
const { TempVoiceService, HUB_COOLDOWN_MS } = require('../src/services/TempVoiceService');
const { ProjectService } = require('../src/services/ProjectService');

const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- giveaways

function giveawaySetup({ messageEmbeds = [], fetchMessage } = {}) {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const edits = [];
  const sent = [];
  const message = { id: 'm1', embeds: messageEmbeds, edit: async (p) => edits.push(p) };
  const channel = {
    isTextBased: () => true,
    send: async (p) => { sent.push(p); return message; },
    messages: { fetch: fetchMessage ?? (async () => message) },
  };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async (id) => ({ id, bot: false }) } };
  const service = new GiveawayService({ client, giveaways: repo });
  const id = repo.create({ guildId: 'g1', channelId: 'c1', messageId: 'm1', prize: 'Nitro', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() + 60_000 });
  const interaction = (userId) => ({ guildId: 'g1', user: { id: userId, bot: false }, member: { id: userId, roles: { cache: new Collection() } } });
  return { repo, service, id, edits, sent, message, interaction };
}

test('giveaway : les participations sont regroupées en une seule édition différée', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, id, edits, interaction } = giveawaySetup();
  await service.toggleEntry(interaction(A), id);
  await service.toggleEntry(interaction(B), id);
  assert.equal(edits.length, 0, 'aucune édition immédiate');
  t.mock.timers.tick(EDIT_DEBOUNCE_MS);
  await service.inflightEdits.get(id);
  assert.equal(edits.length, 1, 'une seule édition groupée');
  assert.ok(JSON.stringify(edits[0].components[0].toJSON()).includes('Participer · 2'));
});

test('giveaway : end() annule l\'édition programmée et une édition tardive ne ressuscite pas la carte', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, id, edits, interaction } = giveawaySetup();
  await service.toggleEntry(interaction(A), id);
  await service.end(id, { guildId: 'g1' });
  assert.equal(service.pendingEdits.size, 0);
  t.mock.timers.tick(EDIT_DEBOUNCE_MS);
  assert.equal(edits.length, 1, 'seule la carte de fin');
  assert.ok(JSON.stringify(edits[0].components[0].toJSON()).includes('cmd:giveaway:reroll'));

  // Le giveaway se termine PENDANT la récupération du message : pas d'édition « en direct ».
  let release;
  const late = giveawaySetup({ fetchMessage: () => new Promise((r) => { release = r; }) });
  await late.service.toggleEntry(late.interaction(A), late.id);
  t.mock.timers.tick(EDIT_DEBOUNCE_MS);
  await tick();
  late.repo.markEnded(late.id);
  release(late.message);
  await late.service.inflightEdits.get(late.id);
  assert.equal(late.edits.length, 0);
});

test('giveaway : le reroll exclut les gagnants affichés sur la carte de fin', async () => {
  const { repo, service, id } = giveawaySetup({ messageEmbeds: [{ fields: [{ name: '🏆 Gagnant', value: `<@${A}>` }] }] });
  for (const u of [A, B]) repo.toggleEntry(id, u);
  repo.markEnded(id);
  for (let i = 0; i < 10; i += 1) assert.deepEqual(await service.end(id, { reroll: true, guildId: 'g1' }), [B]);
  repo.toggleEntry(id, B);
  await assert.rejects(service.end(id, { reroll: true, guildId: 'g1' }), /gagnants précédents/);
  assert.deepEqual(previousWinners({ embeds: [{ fields: [{ name: '🏆 Gagnants', value: `<@${A}>\n<@!${C}>` }] }] }), [A, C]);
  assert.deepEqual(previousWinners(null), []);
});

test('giveaway / suggestions : compteurs de liste en une requête groupée', () => {
  const { db } = memoryDb();
  const gRepo = new GiveawayRepository(db);
  const base = { guildId: 'g', channelId: 'c', messageId: null, prize: 'x', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null };
  const g1 = gRepo.create({ ...base, endsAt: 1 });
  gRepo.create({ ...base, endsAt: 2 });
  gRepo.toggleEntry(g1, A);
  gRepo.toggleEntry(g1, B);
  assert.deepEqual(gRepo.listActive('g').map((g) => g.entry_count), [2, 0]);

  const sRepo = new SuggestionRepository(db);
  const s1 = sRepo.create({ guildId: 'g', channelId: 'c', messageId: null, authorId: 'a', content: 'x' });
  const s2 = sRepo.create({ guildId: 'g', channelId: 'c', messageId: null, authorId: 'a', content: 'y' });
  sRepo.vote(s1, A, 1);
  sRepo.vote(s1, B, -1);
  sRepo.vote(s1, C, 1);
  const list = sRepo.list('g');
  assert.deepEqual(list.map((s) => [s.id, s.up, s.down]), [[s2, 0, 0], [s1, 2, 1]]);
});

// ---------------------------------------------------------------- projets

test('projets : compteurs de tâches groupés et requêtes UPDATE mises en cache', () => {
  const { db } = memoryDb();
  const repo = new ProjectRepository(db);
  const p1 = repo.create({ guildId: 'g', name: 'Un', ownerId: 'o' });
  const p2 = repo.create({ guildId: 'g', name: 'Deux', ownerId: 'o' });
  repo.addTask(p1.id, 'a');
  const t = repo.addTask(p1.id, 'b');
  repo.setTaskDone(p1.id, t, true, 'o');
  assert.deepEqual([...repo.taskCountsByProject('g')], [[p1.id, { total: 2, done: 1 }]]);

  const config = { get: () => ({ projects: {} }) };
  const service = new ProjectService({ client: {}, projects: repo, config });
  assert.deepEqual(service.list('g').map((e) => e.counts), [{ total: 2, done: 1 }, { total: 0, done: 0 }]);

  repo.update(p2.id, { name: 'A' });
  repo.update(p2.id, { name: 'B' });
  repo.update(p2.id, { status: 'en_cours' });
  assert.equal(repo.updateStmts.size, 2);
  assert.equal(repo.get(p2.id).name, 'B');
});

// ---------------------------------------------------------------- modmail

test('modmail : cache négatif des DM sans serveur commun', async () => {
  const { db } = memoryDb();
  let scans = 0;
  const guild = { id: 'g', members: { cache: new Collection(), fetch: async () => { scans += 1; return null; } } };
  const client = { guilds: { cache: new Collection([['g', guild]]) } };
  const service = new ModmailService({ client, modmail: new ModmailRepository(db), config: { get: () => ({ modmail: { enabled: true } }) } });
  const replies = [];
  const dm = () => ({ author: { id: A }, reply: async (p) => replies.push(p) });
  await service.handleUserDM(dm());
  await service.handleUserDM(dm());
  await service.handleUserDM(dm());
  assert.equal(scans, 1, 'un seul parcours des serveurs');
  assert.equal(replies.length, 1, 'un seul avertissement');
  assert.equal(service.isNoGuildCached(A), true);
  assert.equal(service.isNoGuildCached(A, Date.now() + 11 * 60_000), false);
});

test('modmail : fermeture protégée contre le double clic (un seul MP)', async () => {
  const { db } = memoryDb();
  const repo = new ModmailRepository(db);
  repo.create({ guildId: 'g', userId: A, channelId: 'chan' });
  const dms = [];
  const client = { users: { fetch: async () => ({ send: async (p) => dms.push(p) }) }, guilds: { cache: new Collection() } };
  const service = new ModmailService({ client, modmail: repo, config: { get: () => ({}) } });
  const channel = { id: 'chan', guild: { name: 'S' }, delete: async () => {} };
  const results = await Promise.all([service.close(channel), service.close(channel)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(dms.length, 1);
});

// ---------------------------------------------------------------- tickets

function historyChannel(total) {
  // Messages du plus ancien (id 1) au plus récent (id total), renvoyés par pages du plus récent au plus ancien.
  const all = Array.from({ length: total }, (_, i) => ({
    id: String(i + 1),
    createdTimestamp: 1_700_000_000_000 + i * 1000,
    author: { tag: 'u' },
    content: `msg ${i + 1}`,
  }));
  const calls = [];
  return {
    calls,
    id: 'chan',
    name: 'ticket-u',
    messages: {
      fetch: async ({ limit, before }) => {
        calls.push({ limit, before });
        const end = before ? Number(before) - 1 : total;
        const page = all.slice(Math.max(0, end - limit), end).reverse();
        return new Collection(page.map((m) => [m.id, m]));
      },
    },
  };
}

test('ticket : le transcript remonte l\'historique par pages et signale la troncature', async () => {
  const service = new TicketService({ tickets: { getByChannel: () => ({ id: 3 }) }, config: null, logging: null });
  const small = historyChannel(250);
  const text = await service.generateTranscript(small);
  const lines = text.split('\n').filter((l) => l.startsWith('['));
  assert.equal(lines.length, 250);
  assert.ok(lines[0].includes('msg 1') && lines.at(-1).includes('msg 250'), 'ordre chronologique');
  assert.ok(!text.includes('tronqué'));
  assert.deepEqual(small.calls.map((c) => c.before), [undefined, '151', '51']);

  const big = historyChannel(1500);
  const bigText = await service.generateTranscript(big);
  const bigLines = bigText.split('\n').filter((l) => l.startsWith('['));
  assert.equal(bigLines.length, 1000);
  assert.ok(bigLines[0].includes('msg 501'));
  assert.ok(bigText.includes('tronqué'));

  const exact = await service.generateTranscript(historyChannel(1000));
  assert.ok(!exact.includes('tronqué'), 'exactement 1000 messages : rien de coupé');
});

// ---------------------------------------------------------------- vocaux temporaires

test('vocaux temporaires : cooldown par membre sur le hub', async () => {
  const created = [];
  const config = { get: () => ({ tempVoice: { enabled: true, hubChannelId: 'hub' } }) };
  const service = new TempVoiceService({ tempVoice: { create: () => {}, get: () => null, delete: () => {} }, config });
  const guild = {
    id: 'g',
    channels: {
      cache: new Collection(),
      create: async (opts) => { created.push(opts); return { id: `v${created.length}` }; },
    },
  };
  const member = { id: A, displayName: 'Bob', voice: { setChannel: async () => {} } };
  const join = () => service.handleVoiceUpdate({ guild, channelId: null }, { guild, channelId: 'hub', member, id: A });
  await join();
  await join();
  assert.equal(created.length, 1);
  service.hubCooldowns.release(`g:${A}`);
  await join();
  assert.equal(created.length, 2);
  assert.ok(HUB_COOLDOWN_MS >= 5_000);
  await tick();
});
