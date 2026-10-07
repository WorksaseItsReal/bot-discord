'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { inheritedOverwrites, OWNER_PERMISSIONS, TempVoiceService } = require('../src/services/TempVoiceService');
const { BackupRepository, isAutoBackup } = require('../src/database/repositories/BackupRepository');
const { BackupService, MAX_AUTO_BACKUPS, MAX_MANUAL_BACKUPS } = require('../src/services/BackupService');
const { ModmailRepository } = require('../src/database/repositories/ModmailRepository');
const { ModmailService, buildTranscript } = require('../src/services/ModmailService');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { TicketService, channelGone } = require('../src/services/TicketService');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { GiveawayService, isEligible } = require('../src/services/GiveawayService');
const { ProjectService } = require('../src/services/ProjectService');
const modmail = require('../src/commands/tickets/modmail');
const giveaway = require('../src/commands/giveaways/giveaway');
const ticketReconcile = require('../src/events/ticketReconcile');

const perm = (bits) => new PermissionsBitField(bits);
const ow = (id, type, allow, deny) => ({ id, type, allow: perm(allow), deny: perm(deny) });

// ---------------------------------------------------------------- vocaux temporaires

test('TempVoice : overwrites de la catégorie hérités + overwrite du propriétaire fusionné', () => {
  const view = PermissionFlagsBits.ViewChannel;
  const parent = {
    permissionOverwrites: {
      cache: new Collection([
        ['g', ow('g', OverwriteType.Role, 0n, view)],
        ['staff', ow('staff', OverwriteType.Role, view, 0n)],
        ['owner', ow('owner', OverwriteType.Member, view, PermissionFlagsBits.Connect)],
      ]),
    },
  };
  const out = inheritedOverwrites(parent, 'owner');
  assert.deepEqual(out.map((o) => o.id), ['g', 'staff', 'owner']);
  assert.equal(out[0].deny, view);
  const owner = out.at(-1);
  assert.equal(owner.type, OverwriteType.Member);
  assert.equal(owner.allow & OWNER_PERMISSIONS, OWNER_PERMISSIONS);
  assert.equal(owner.allow & view, view, 'droits existants conservés');
  assert.equal(owner.deny & PermissionFlagsBits.Connect, 0n, 'Connect n\'est plus refusé');
  // Sans catégorie : seul le propriétaire.
  assert.deepEqual(inheritedOverwrites(null, 'owner').map((o) => o.id), ['owner']);
});

test('TempVoice : le salon créé reçoit les overwrites de la catégorie du hub', async () => {
  const created = [];
  const category = { id: 'cat', type: ChannelType.GuildCategory, permissionOverwrites: { cache: new Collection([['g', ow('g', OverwriteType.Role, 0n, PermissionFlagsBits.ViewChannel)]]) } };
  const channel = { id: 'new', members: new Collection(), send: async () => {} };
  const guild = {
    id: 'g',
    channels: { cache: new Collection([['cat', category]]), create: async (opts) => { created.push(opts); return channel; } },
  };
  const member = { id: 'u', displayName: 'Bob', voice: { setChannel: async () => {} }, toString: () => '<@u>' };
  const config = { get: () => ({ tempVoice: { enabled: true, hubChannelId: 'hub' } }) };
  const service = new TempVoiceService({ tempVoice: { create: () => {}, get: () => null, delete: () => {} }, config });
  await service.handleVoiceUpdate({ channelId: null, guild }, { channelId: 'hub', guild, member, id: 'u', channel: { parentId: 'cat' } });
  assert.equal(created.length, 1);
  assert.equal(created[0].parent, 'cat');
  assert.deepEqual(created[0].permissionOverwrites.map((o) => o.id), ['g', 'u']);
});

// ---------------------------------------------------------------- sauvegardes

test('Backups : quotas automatiques et manuels séparés', () => {
  const { db } = memoryDb();
  const repo = new BackupRepository(db);
  const service = new BackupService({ backups: repo });
  const guild = { id: 'g', name: 'S', iconURL: () => null, roles: { cache: new Collection() }, channels: { cache: new Collection() } };
  const human = { id: 'u1', bot: false };
  const bot = { id: 'bot', bot: true };
  for (let i = 0; i < MAX_MANUAL_BACKUPS + 3; i += 1) service.create(guild, human, `m${i}`);
  for (let i = 0; i < MAX_AUTO_BACKUPS + 4; i += 1) service.create(guild, bot, 'Auto-backup');
  const rows = service.list('g');
  assert.equal(rows.filter(isAutoBackup).length, MAX_AUTO_BACKUPS);
  assert.equal(rows.filter((r) => !isAutoBackup(r)).length, MAX_MANUAL_BACKUPS);
  assert.ok(rows.filter(isAutoBackup).every((r) => r.created_by === null), 'auto : sans auteur');
  // Une rafale d'auto-backups n'évince aucune sauvegarde manuelle.
  for (let i = 0; i < 5; i += 1) service.create(guild, null, null);
  assert.equal(service.list('g').filter((r) => !isAutoBackup(r)).length, MAX_MANUAL_BACKUPS);
  // Ancienne sauvegarde auto (auteur = bot) reconnue à son nom.
  assert.equal(isAutoBackup({ created_by: 'bot', name: 'Auto-backup' }), true);
  assert.equal(isAutoBackup({ created_by: 'u1', name: 'Ma sauvegarde' }), false);
});

test('Backups : caches non réordonnés, fils exclus, rôles restaurés du plus haut au plus bas avec colors', async () => {
  const role = (id, name, position, color) => ({ id, name, position, managed: false, colors: { primaryColor: color }, hoist: false, mentionable: false, permissions: perm(0n) });
  const roles = new Collection([['g', role('g', '@everyone', 0, 0)], ['low', role('low', 'Bas', 1, 1)], ['high', role('high', 'Haut', 3, 3)], ['mid', role('mid', 'Milieu', 2, 2)]]);
  const text = { id: 'c1', name: 'general', type: ChannelType.GuildText, rawPosition: 1, parent: null, isThread: () => false };
  const thread = { id: 't1', name: 'fil', type: ChannelType.PublicThread, rawPosition: 0, parent: text, isThread: () => true };
  const channels = new Collection([['t1', thread], ['c1', text]]);
  const source = { id: 'g', name: 'S', iconURL: () => null, roles: { cache: roles }, channels: { cache: channels } };
  const service = new BackupService({ backups: null });
  const before = [...roles.keys()];
  const data = service.serialize(source);
  assert.deepEqual([...roles.keys()], before, 'cache des rôles intact');
  assert.deepEqual([...channels.keys()], ['t1', 'c1'], 'cache des salons intact');
  assert.deepEqual(data.roles.map((r) => r.name), ['Haut', 'Milieu', 'Bas']);
  assert.deepEqual(data.channels.map((c) => c.name), ['general']);

  const createdRoles = [];
  const target = {
    id: 'g2',
    roles: { everyone: { id: 'g2' }, cache: new Collection(), create: async (opts) => { createdRoles.push(opts); return {}; } },
    members: { cache: new Collection() },
    channels: { cache: new Collection(), create: async () => ({}) },
  };
  // Une ancienne sauvegarde contenant un fil : ignoré à la restauration.
  service.get = () => ({ data: { ...data, channels: [...data.channels, { name: 'fil', type: ChannelType.PublicThread, overwrites: [] }] } });
  const res = await service.restore(target, 'x');
  assert.deepEqual(createdRoles.map((r) => r.name), ['Haut', 'Milieu', 'Bas']);
  assert.deepEqual(createdRoles[0].colors, { primaryColor: 3 });
  assert.equal('color' in createdRoles[0], false);
  assert.equal(res.channels, 1);
});

// ---------------------------------------------------------------- ModMail

test('ModMail : le transcript est publié dans modmail.logChannel à la fermeture', async () => {
  const { db } = memoryDb();
  const repo = new ModmailRepository(db);
  repo.create({ guildId: 'g', userId: 'u', channelId: 'chan' });
  const logged = [];
  const logCh = { isTextBased: () => true, send: async (p) => logged.push(p) };
  const msgs = new Collection([
    ['2', { id: '2', createdTimestamp: 2, author: { tag: 'staff' }, content: '', embeds: [{ author: { name: 'Réponse de staff' }, description: 'Bonjour' }], attachments: new Collection() }],
    ['1', { id: '1', createdTimestamp: 1, author: { tag: 'bot' }, content: '', embeds: [{ author: { name: 'u a écrit' }, description: 'Aide svp' }], attachments: new Collection() }],
  ]);
  let deleted = false;
  const guild = { id: 'g', name: 'S', channels: { fetch: async (id) => (id === 'logs' ? logCh : null) } };
  const channel = { id: 'chan', name: 'modmail-u', guild, messages: { fetch: async () => msgs }, delete: async () => { deleted = true; } };
  const client = { users: { fetch: async () => ({ id: 'u', send: async () => {} }) }, guilds: { cache: new Collection() } };
  const service = new ModmailService({ client, modmail: repo, config: { get: () => ({ modmail: { logChannel: 'logs' } }) } });
  assert.equal(await service.close(channel, { toString: () => '<@staff>' }), true);
  assert.equal(deleted, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].files[0].name.endsWith('.txt'), true);
  const text = logged[0].files[0].attachment.toString('utf8');
  assert.ok(text.indexOf('Aide svp') < text.indexOf('Bonjour'), 'ordre chronologique');
  assert.match(JSON.stringify(logged[0].embeds[0].toJSON()), /<@staff>/);
  assert.equal(buildTranscript({ id: 1, user_id: 'u' }, null, null), 'Transcript indisponible.');
});

test('/modmail setup exige Gérer le serveur ; reply/close restent au staff', async () => {
  let updated = false;
  const client = { services: { modmail: {}, config: { update: () => { updated = true; }, get: () => ({ modmail: {} }) } } };
  const interaction = (granted) => ({
    guild: { id: 'g' },
    memberPermissions: { has: (f) => granted.includes(f) },
    options: { getSubcommand: () => 'setup', getChannel: () => null, getRole: () => null, getBoolean: () => true },
    reply: async () => {},
  });
  await assert.rejects(modmail.execute(interaction([PermissionFlagsBits.ManageMessages]), client), /Gérer le serveur/);
  assert.equal(updated, false);
  await modmail.execute(interaction([PermissionFlagsBits.ManageGuild]), client);
  assert.equal(updated, true);
  assert.equal(modmail.data.toJSON().default_member_permissions, String(PermissionFlagsBits.ManageMessages));
});

// ---------------------------------------------------------------- giveaways

function giveawaySetup({ send, members, winners = 1, requiredRole = null, forbiddenRole = null } = {}) {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const sent = [];
  const channel = {
    isTextBased: () => true,
    send: send ?? (async (p) => { sent.push(p); return { id: 'm' }; }),
    messages: { fetch: async () => null },
  };
  const guild = members ? { id: 'g1', members: { cache: members, fetch: async (id) => members.get(id) ?? null } } : null;
  const client = {
    channels: { fetch: async () => channel },
    users: { fetch: async (id) => ({ id, bot: false }) },
    guilds: { cache: new Collection(guild ? [['g1', guild]] : []) },
  };
  const service = new GiveawayService({ client, giveaways: repo });
  const id = repo.create({ guildId: 'g1', channelId: 'c1', messageId: null, prize: 'Nitro', winners, hostId: 'h', requiredRole, forbiddenRole, endsAt: Date.now() });
  return { repo, service, id, sent, channel };
}

const gm = (id, roles = []) => ({ id, roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) } });

test('Giveaway : membres partis ou hors conditions de rôles exclus au tirage', async () => {
  const members = new Collection([['ok', gm('ok', ['vip'])], ['norole', gm('norole')], ['banned', gm('banned', ['vip', 'muted'])]]);
  const { repo, service, id } = giveawaySetup({ members, winners: 5, requiredRole: 'vip', forbiddenRole: 'muted' });
  for (const u of ['ok', 'norole', 'banned', 'left']) repo.toggleEntry(id, u);
  assert.deepEqual(await service.end(id, { guildId: 'g1' }), ['ok']);
  assert.equal(isEligible({ required_role: null, forbidden_role: 'x' }, gm('a', ['x'])), false);
  assert.equal(isEligible({ required_role: null, forbidden_role: null }, gm('a')), true);
});

test('Giveaway : reroll avec un nombre de gagnants, en série (pas de doublon)', async () => {
  const { repo, service, id } = giveawaySetup();
  for (const u of ['a', 'b', 'c', 'd', 'e']) repo.toggleEntry(id, u);
  const [first] = await service.end(id, { guildId: 'g1' });
  const [r1, r2] = await Promise.all([
    service.end(id, { reroll: true, guildId: 'g1', count: 2 }),
    service.end(id, { reroll: true, guildId: 'g1', count: 2 }),
  ]);
  assert.equal(r1.length, 2);
  const all = [first, ...r1, ...r2];
  assert.equal(new Set(all).size, all.length, 'aucun gagnant tiré deux fois');
  assert.equal(service.locks.size, 0, 'verrous libérés');
  const reroll = giveaway.data.toJSON().options.find((o) => o.name === 'reroll');
  assert.ok(reroll.options.some((o) => o.name === 'gagnants'));
});

test('Giveaway : annonce en échec → erreur claire, gagnants non mémorisés, /giveaway end la retente', async () => {
  let fail = true;
  const sent = [];
  const { repo, service, id } = giveawaySetup({ send: async (p) => { if (fail) throw new Error('Missing Access'); sent.push(p); return {}; } });
  repo.toggleEntry(id, 'a');
  await assert.rejects(service.end(id, { guildId: 'g1' }), /annonce des gagnants a échoué[\s\S]*\/giveaway end/);
  assert.equal(repo.get(id).ended, 1);
  assert.deepEqual(repo.winners(id), []);
  fail = false;
  assert.deepEqual(await service.end(id, { guildId: 'g1' }), ['a']);
  assert.equal(sent.length, 1);
  assert.deepEqual(repo.winners(id), ['a']);
  // Annonce réussie : plus de reprise possible.
  await assert.rejects(service.end(id, { guildId: 'g1' }), /déjà terminé/);
});

// ---------------------------------------------------------------- projets

test('ProjectService.publish : un double clic ne crée qu\'un seul message', async () => {
  let release;
  const sends = [];
  const stored = { id: 7, channelId: null, messageId: null };
  const repo = { get: () => ({ ...stored }), update: (id, patch) => Object.assign(stored, patch) };
  const service = new ProjectService({ client: { channels: { fetch: async () => null } }, projects: repo, config: { get: () => ({ projects: {} }) } });
  service.render = () => ({ embeds: [] });
  const channel = {
    id: 'c',
    guild: { members: { me: null } },
    isTextBased: () => true,
    send: (p) => { sends.push(p); return new Promise((r) => { release = () => r({ id: `m${sends.length}` }); }); },
  };
  const first = service.publish({ id: 7 }, channel);
  await assert.rejects(service.publish({ id: 7 }, channel), /déjà en cours/);
  await new Promise((r) => setImmediate(r));
  release();
  await first;
  assert.equal(sends.length, 1);
  assert.equal(stored.messageId, 'm1');
  assert.equal(service.publishing.size, 0);
});

// ---------------------------------------------------------------- réconciliation au démarrage

test('ticketReconcile : tickets et ModMail sans salon fermés, serveur par serveur', async () => {
  const { db } = memoryDb();
  const ticketsRepo = new TicketRepository(db);
  const modmailRepo = new ModmailRepository(db);
  ticketsRepo.create({ guildId: 'g1', channelId: 'alive', userId: 'u1' });
  ticketsRepo.create({ guildId: 'g1', channelId: 'gone', userId: 'u2' });
  ticketsRepo.create({ guildId: 'g1', channelId: 'flaky', userId: 'u3' });
  ticketsRepo.create({ guildId: 'g2', channelId: 'gone2', userId: 'u4' });
  modmailRepo.create({ guildId: 'g1', userId: 'u5', channelId: 'mm-gone' });
  modmailRepo.create({ guildId: 'g1', userId: 'u6', channelId: 'alive' });
  const unknown = Object.assign(new Error('Unknown Channel'), { code: 10003 });
  const guild1 = {
    id: 'g1',
    available: true,
    channels: {
      cache: new Collection([['alive', {}]]),
      fetch: async (id) => { if (id === 'flaky') throw new Error('réseau'); throw unknown; },
    },
  };
  const client = {
    guilds: { cache: new Collection([['g1', guild1]]) }, // g2 absent du cache : rien n'est touché
    services: {
      tickets: new TicketService({ tickets: ticketsRepo, config: {}, logging: {} }),
      modmail: new ModmailService({ client: {}, modmail: modmailRepo, config: {} }),
    },
  };
  assert.equal(ticketReconcile.name, 'clientReady');
  assert.equal(ticketReconcile.once, true);
  await ticketReconcile.execute(client);
  assert.deepEqual(ticketsRepo.listByGuild('g1').map((t) => t.channel_id).sort(), ['alive', 'flaky']);
  assert.equal(ticketsRepo.listByGuild('g2').length, 1);
  assert.deepEqual(modmailRepo.listOpenByGuild('g1').map((t) => t.channel_id), ['alive']);
  assert.equal(await channelGone(guild1, 'alive'), false);
});
