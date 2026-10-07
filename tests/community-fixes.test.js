'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, OverwriteType, PermissionsBitField, ChannelType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { selectMenu } = require('../src/utils/components');
const { isHttpUrl } = require('../src/commands/utility/embed');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { ModmailRepository } = require('../src/database/repositories/ModmailRepository');
const { BackupRepository } = require('../src/database/repositories/BackupRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SuggestionRepository } = require('../src/database/repositories/SuggestionRepository');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { GiveawayService } = require('../src/services/GiveawayService');
const { BackupService } = require('../src/services/BackupService');
const { SuggestionService } = require('../src/services/SuggestionService');
const { TicketService } = require('../src/services/TicketService');

test('selectMenu accepte des options sans description ni emoji et borne le label', () => {
  const menu = selectMenu({
    id: 'rolemenu:1',
    placeholder: 'x',
    min: 0,
    max: 2,
    options: [
      { label: 'a'.repeat(150), value: '1' },
      { label: 'b', value: '2', description: 'd'.repeat(150), emoji: '🎉' },
    ],
  });
  const json = menu.toJSON();
  assert.equal(json.options.length, 2);
  assert.equal(json.options[0].label.length, 100);
  assert.equal(json.options[0].description, undefined);
  assert.equal(json.options[1].description.length, 100);
});

test('isHttpUrl ne garde que http(s)', () => {
  assert.equal(isHttpUrl('https://exemple.fr/a.png'), true);
  assert.equal(isHttpUrl('http://exemple.fr'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('pas une url'), false);
});

function giveawaySetup() {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const sent = [];
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); return { id: `m${sent.length}` }; }, messages: { fetch: async () => null } };
  const users = { bot1: { bot: true }, u1: { bot: false }, u2: { bot: false } };
  const client = {
    channels: { fetch: async () => channel },
    users: { fetch: async (id) => users[id] ?? null },
  };
  const service = new GiveawayService({ client, giveaways: repo });
  const id = repo.create({ guildId: 'g1', channelId: 'c1', messageId: null, prize: 'Nitro', winners: 2, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() });
  return { repo, service, id, sent };
}

test('GiveawayRepository.markEnded est atomique', () => {
  const { repo, id } = giveawaySetup();
  assert.equal(repo.markEnded(id), true);
  assert.equal(repo.markEnded(id), false);
});

test('GiveawayService.end : garde inter-serveurs, double fin, reroll, bots exclus', async () => {
  const { repo, service, id } = giveawaySetup();
  await assert.rejects(service.end(id, { guildId: 'autre' }), /introuvable/);
  await assert.rejects(service.end(id, { reroll: true, guildId: 'g1' }), /encore en cours/);
  repo.toggleEntry(id, 'bot1');
  repo.toggleEntry(id, 'u1');
  const winners = await service.end(id, { guildId: 'g1' });
  assert.deepEqual(winners, ['u1']);
  await assert.rejects(service.end(id, { guildId: 'g1' }), /déjà terminé/);
  // Le gagnant mémorisé est exclu de la relance : sans autre participant, pas de tirage.
  await assert.rejects(service.end(id, { reroll: true, guildId: 'g1' }), /gagnants précédents/);
  repo.toggleEntry(id, 'u2');
  assert.deepEqual(await service.end(id, { reroll: true, guildId: 'g1' }), ['u2']);
});

test('GiveawayService.end : reroll sans participant éligible', async () => {
  const { repo, service, id } = giveawaySetup();
  repo.toggleEntry(id, 'bot1');
  assert.deepEqual(await service.end(id), []);
  await assert.rejects(service.end(id, { reroll: true }), /Aucun participant/);
});

test('ModmailRepository : conversation ouverte la plus récente et fermeture idempotente', () => {
  const { db } = memoryDb();
  const repo = new ModmailRepository(db);
  repo.create({ guildId: 'g', userId: 'u', channelId: 'c1' });
  repo.create({ guildId: 'g', userId: 'u', channelId: 'c2' });
  assert.equal(repo.getOpenByUser('u').channel_id, 'c2');
  assert.equal(repo.close('c2'), true);
  assert.equal(repo.close('c2'), false);
  assert.equal(repo.getOpenByUser('u').channel_id, 'c1');
});

test('BackupRepository.prune ne garde que les 15 plus récentes', () => {
  const { db } = memoryDb();
  const repo = new BackupRepository(db);
  for (let i = 0; i < 20; i += 1) repo.create({ id: `b${i}`, guildId: 'g', name: `n${i}`, data: {}, createdBy: null });
  repo.create({ id: 'other', guildId: 'g2', name: 'x', data: {}, createdBy: null });
  repo.prune('g', 15);
  assert.equal(repo.count('g'), 15);
  assert.equal(repo.count('g2'), 1);
});

test('BackupService : les permissions des salons sont sauvegardées et re-mappées', async () => {
  const everyone = { id: 'g', name: '@everyone', managed: false, position: 0, color: 0, hoist: false, mentionable: false, permissions: new PermissionsBitField(0n) };
  const staff = { id: 'r1', name: 'Staff', managed: false, position: 1, color: 0, hoist: false, mentionable: false, permissions: new PermissionsBitField(0n) };
  const ow = (id, type, allow, deny) => ({ id, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
  const view = PermissionsBitField.Flags.ViewChannel;
  const priv = {
    id: 'c1', name: 'prive', type: ChannelType.GuildText, rawPosition: 0, parent: null,
    permissionOverwrites: { cache: new Collection([['g', ow('g', OverwriteType.Role, 0n, view)], ['r1', ow('r1', OverwriteType.Role, view, 0n)]]) },
  };
  const source = {
    id: 'g', name: 'S', iconURL: () => null,
    roles: { cache: new Collection([['g', everyone], ['r1', staff]]) },
    channels: { cache: new Collection([['c1', priv]]) },
  };
  const service = new BackupService({ backups: null });
  const data = service.serialize(source);
  assert.deepEqual(data.channels[0].overwrites.map((o) => o.everyone || o.role), [true, 'Staff']);

  // Restauration sur un serveur où « Staff » a un nouvel ID
  const created = [];
  const target = {
    id: 'g2',
    roles: { everyone: { id: 'g2' }, cache: new Collection([['r9', { id: 'r9', name: 'Staff', managed: false }]]), create: async () => ({}) },
    members: { cache: new Collection() },
    channels: { cache: new Collection(), create: async (opts) => { created.push(opts); return {}; } },
  };
  service.get = () => ({ data });
  await service.restore(target, 'x');
  const overwrites = created[0].permissionOverwrites;
  assert.deepEqual(overwrites.map((o) => o.id), ['g2', 'r9']);
  assert.equal(overwrites[0].deny, view);
});

test('GuildConfigRepository.get renvoie null sur JSON corrompu', () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  db.prepare('INSERT INTO guild_config (guild_id, data, updated_at) VALUES (?, ?, ?)').run('g', '{oops', Date.now());
  assert.equal(repo.get('g'), null);
});

test('SuggestionService.vote refuse les votes clos et inter-serveurs', async () => {
  const { db } = memoryDb();
  const repo = new SuggestionRepository(db);
  const service = new SuggestionService({ client: {}, suggestions: repo, config: {} });
  const id = repo.create({ guildId: 'g', channelId: 'c', messageId: null, authorId: 'a', content: 'idée' });
  const interaction = (guildId) => ({ guildId, user: { id: 'u' }, update: async () => {} });
  await assert.rejects(service.vote(interaction('autre'), id, 1), /introuvable/);
  repo.setStatus(id, 'approved');
  await assert.rejects(service.vote(interaction('g'), id, 1), /clos/);
  await assert.rejects(service.setStatus({ id: 'autre' }, id, 'denied'), /introuvable/);
});

test('TicketService : verrou de création, garde de fermeture et rôle support', async () => {
  const { db } = memoryDb();
  const repo = new TicketRepository(db);
  const cfg = { tickets: { maxPerUser: 1, supportRoleId: 'sup', categoryId: 'deleted-cat' } };
  const service = new TicketService({ tickets: repo, config: { get: () => cfg }, logging: { send: async () => {} } });

  let release;
  const createdOpts = [];
  const guild = {
    id: 'g',
    roles: { everyone: { id: 'g' }, cache: new Collection() },
    members: { me: { id: 'bot' } },
    channels: {
      cache: new Collection(),
      create: (opts) => new Promise((resolve) => { createdOpts.push(opts); release = () => resolve({ id: 'chan', send: async () => {}, toString: () => '#chan' }); }),
    },
  };
  const user = { id: 'u', username: 'u', tag: 'u#0', toString: () => '<@u>' };
  const first = service.create(guild, user);
  await assert.rejects(service.create(guild, user), /déjà en cours/);
  release();
  await first;
  // Catégorie et rôle support supprimés : ignorés
  assert.equal(createdOpts[0].parent, null);
  assert.equal(createdOpts[0].permissionOverwrites.some((o) => o.id === 'sup'), false);

  const member = (perms, roles = []) => ({
    guild: { id: 'g' },
    permissions: { has: (f) => perms.includes(f) },
    roles: { cache: new Collection(roles.map((r) => [r, {}])) },
  });
  assert.equal(service.isStaff(member([], ['sup'])), true);
  assert.equal(service.isStaff(member([])), false);
  await assert.rejects(service.claim({ id: 'chan' }, member([])), /support/);

  const channel = { id: 'chan', guild: { id: 'g', channels: { fetch: async () => null } }, messages: { fetch: async () => null }, delete: async () => {} };
  const closing = service.close(channel, user, { delayMs: 20 });
  await assert.rejects(service.close(channel, user), /déjà en cours de fermeture/);
  await closing;
  assert.equal(repo.getByChannel('chan'), undefined);
});
