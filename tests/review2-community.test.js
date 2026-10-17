'use strict';

/**
 * Revue n° 2 — modules communautaires : tests de non-régression
 * (menus de rôles / tickets, sauvegardes, giveaways, ModMail, tags, rappels, projets).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, PermissionsBitField, PermissionFlagsBits, MessageFlags, MessageFlagsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');

const rolemenuComponent = require('../src/components/rolemenu');
const ticketComponent = require('../src/components/ticket');
const giveawayComponent = require('../src/components/giveaway');
const ticketCmd = require('../src/commands/tickets/ticket');
const tickets = require('../src/commands/tickets/tickets');
const modmailCmd = require('../src/commands/tickets/modmail');
const giveawayCmd = require('../src/commands/giveaways/giveaway');
const backupCmd = require('../src/commands/configuration/backup');
const customCmd = require('../src/commands/configuration/custom');
const tagCmd = require('../src/commands/utility/tag');
const reminderCmd = require('../src/commands/utility/reminder');
const projetCmd = require('../src/commands/projects/projet');
const { resetSelectMenu } = require('../src/utils/components');
const { BackupService } = require('../src/services/BackupService');
const { GiveawayService } = require('../src/services/GiveawayService');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { TicketService, createInCategory, OPEN_COOLDOWN_MS } = require('../src/services/TicketService');
const { ModmailService } = require('../src/services/ModmailService');
const { ModmailRepository } = require('../src/database/repositories/ModmailRepository');
const { ProjectService } = require('../src/services/ProjectService');
const { ProjectRepository } = require('../src/database/repositories/ProjectRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { LIMITS } = require('../src/utils/projectFormat');

const A = '111111111111111111';
const B = '222222222222222222';
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const ids = (rows) => (rows ?? []).map(json).flatMap((r) => r.components.map((c) => c.custom_id).filter(Boolean));
const text = (embed) => JSON.stringify(json(embed));
const perms = (...flags) => new PermissionsBitField(flags);
const apiError = (code, message = 'Discord error') => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- 1. menus remis à zéro

test('menu de rôles : le menu public est réédité (remis à zéro) après traitement, même en cas d\'erreur', async () => {
  const edits = [];
  const components = [{ type: 1, components: [] }];
  const role = { id: 'r1', managed: false, position: 1, permissions: perms() };
  const added = [];
  const interaction = {
    isStringSelectMenu: () => true,
    deferReply: async () => {},
    reply: async () => {},
    message: { id: 'm', components, edit: async (p) => edits.push(p) },
    guildId: 'g',
    values: ['r1'],
    guild: { roles: { cache: new Collection([['r1', role]]) }, members: { me: { roles: { highest: { position: 10 } } } } },
    member: { roles: { cache: new Collection(), add: async (id) => added.push(id) } },
  };
  const client = { repositories: { roleMenus: { getByMessage: () => ({ guild_id: 'g', data: { roles: [{ roleId: 'r1' }] } }) } } };
  await rolemenuComponent.execute(interaction, client);
  assert.deepEqual(added, ['r1']);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].components, components, 'mêmes composants : seule la sélection est effacée');

  const broken = { repositories: { roleMenus: { getByMessage: () => { throw new Error('db'); } } } };
  await assert.rejects(rolemenuComponent.execute(interaction, broken), /db/);
  assert.equal(edits.length, 2, 'remise à zéro aussi sur erreur');
});

test('resetSelectMenu : ignore les messages éphémères et ne lève jamais', async () => {
  let edited = 0;
  const ephemeral = { message: { components: [], flags: new MessageFlagsBitField(MessageFlags.Ephemeral), edit: async () => { edited += 1; } } };
  assert.equal(await resetSelectMenu(ephemeral), false);
  assert.equal(edited, 0);
  assert.equal(await resetSelectMenu({ message: { components: [], edit: async () => { throw new Error('x'); } } }), false);
  assert.equal(await resetSelectMenu({}), false);
});

test('panneau de tickets : le menu des motifs est remis à zéro après l\'ouverture', async () => {
  const edits = [];
  const replies = [];
  const components = [{ type: 1, components: [] }];
  const client = {
    services: {
      config: { get: () => ({ tickets: { reasons: [{ value: 'aide', label: 'Aide' }] } }) },
      tickets: { create: async (g, u, { reason }) => ({ reason, url: null, toString: () => '<#c>' }), createdReply: () => ({ title: 'ok' }) },
    },
  };
  const interaction = {
    customId: 'ticket:open',
    isButton: () => false,
    isStringSelectMenu: () => true,
    values: ['aide'],
    guildId: 'g',
    guild: { id: 'g' },
    user: { id: A },
    message: { components, edit: async (p) => edits.push(p) },
    deferReply: async () => {},
    editReply: async (p) => replies.push(p),
  };
  await ticketComponent.execute(interaction, client);
  assert.equal(replies.length, 1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].components, components);
});

// ---------------------------------------------------------------- 2-3, 12. sauvegardes

function backupData() {
  return {
    roles: [{ name: 'Staff', color: 0, hoist: false, mentionable: false, permissions: '0' }],
    channels: [
      { name: 'cat', type: ChannelType.GuildCategory, overwrites: [] },
      { name: 'general', type: ChannelType.GuildText, parentName: 'cat', overwrites: [{ role: 'Fantôme', allow: '0', deny: '1024' }] },
    ],
  };
}

test('restauration : les échecs sont comptés (nom + code) et la carte ne dit plus « Rien à recréer »', async () => {
  const err = apiError(50013, 'Missing Permissions');
  const svc = new BackupService({ backups: { get: () => ({ id: 'x', name: 'B', data: backupData() }) } });
  const guild = {
    id: 'g',
    roles: { cache: new Collection(), everyone: { id: 'g' }, create: async () => { throw err; } },
    channels: { cache: new Collection(), create: async () => { throw err; } },
    members: { cache: new Collection() },
  };
  const res = await svc.restore(guild, 'x');
  assert.equal(res.roles + res.channels, 0);
  assert.deepEqual(res.failed.map((f) => [f.kind, f.name, f.code]), [['role', 'Staff', 50013], ['channel', 'cat', 50013], ['channel', 'general', 50013]]);
  const card = json(backupCmd.restoreResultCard({ id: 'x', name: 'B' }, res));
  assert.match(card.title, /échouée/);
  assert.doesNotMatch(card.description, /Rien à recréer/);
  const failures = card.fields.find((f) => f.name.includes('Échecs'));
  assert.ok(failures && failures.value.includes('50013') && failures.value.includes('Staff'));
});

test('restauration : permissions du bot vérifiées avant de commencer', async () => {
  let created = 0;
  const svc = new BackupService({ backups: { get: () => ({ id: 'x', name: 'B', data: backupData() }) } });
  const guild = {
    id: 'g',
    roles: { cache: new Collection(), everyone: { id: 'g' }, create: async () => { created += 1; } },
    channels: { cache: new Collection(), create: async () => { created += 1; } },
    members: { cache: new Collection(), me: { permissions: perms(PermissionFlagsBits.ManageChannels) } },
  };
  await assert.rejects(svc.restore(guild, 'x'), /Gérer les rôles/);
  assert.equal(created, 0);
  assert.equal(svc.isRestoring('g'), false, 'verrou libéré');
});

test('restauration : deux restaurations simultanées → la seconde est refusée (aucun doublon)', async () => {
  const svc = new BackupService({ backups: { get: () => ({ id: 'x', name: 'B', data: backupData() }) } });
  let n = 0;
  const roles = new Collection();
  const channels = new Collection();
  const later = () => new Promise((r) => setTimeout(r, 10));
  const guild = {
    id: 'g',
    roles: { cache: roles, everyone: { id: 'g' }, create: async (o) => { await later(); const id = String(++n); roles.set(id, { id, name: o.name }); } },
    channels: { cache: channels, create: async (o) => { await later(); const id = String(++n); const c = { id, name: o.name, type: o.type, permissionOverwrites: { cache: new Collection() } }; channels.set(id, c); return c; } },
    members: { cache: new Collection() },
  };
  const [first, second] = await Promise.allSettled([svc.restore(guild, 'x'), svc.restore(guild, 'x')]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /déjà en cours/);
  assert.deepEqual([...roles.values()].map((r) => r.name), ['Staff']);
  assert.deepEqual([...channels.values()].map((c) => c.name).sort(), ['cat', 'general']);
  assert.equal(svc.isRestoring('g'), false);
});

test('restauration : second passage de rattachement aux catégories, surcharges ignorées rapportées', async () => {
  const svc = new BackupService({ backups: { get: () => ({ id: 'x', name: 'B', data: backupData() }) } });
  const channels = new Collection();
  const pending = [];
  const parents = [];
  const guild = {
    id: 'g',
    roles: { cache: new Collection([['r', { id: 'r', name: 'Staff' }]]), everyone: { id: 'g' }, create: async () => ({}) },
    channels: {
      cache: channels,
      create: async (o) => {
        const c = { id: `c${channels.size + pending.length}`, name: o.name, type: o.type, parent: o.parent, setParent: async (id) => parents.push([c.name, id]) };
        // La catégorie n'apparaît dans le cache qu'APRÈS la création du salon suivant.
        if (o.type === ChannelType.GuildCategory) pending.push(c);
        else {
          channels.set(c.id, c);
          for (const p of pending.splice(0)) channels.set(p.id, p);
        }
        return c;
      },
    },
    members: { cache: new Collection() },
  };
  const res = await svc.restore(guild, 'x');
  assert.equal(res.channels, 2);
  assert.equal(res.reparented, 1);
  assert.deepEqual(parents, [['general', 'c0']]);
  assert.deepEqual(res.skippedOverwrites, ['@Fantôme']);
  const card = json(backupCmd.restoreResultCard({ id: 'x', name: 'B' }, res));
  assert.ok(card.fields.some((f) => f.name.includes('Permissions ignorées') && f.value.includes('Fantôme')));
});

test('auto-backup : serveur indisponible ignoré', async () => {
  const created = [];
  const client = {
    user: { id: 'bot' },
    guilds: { cache: new Map([['g1', { id: 'g1', available: false }], ['g2', { id: 'g2', available: true }]]) },
    repositories: {},
    services: {
      backup: { create: (g) => created.push(g.id) },
      config: { get: () => ({ autobackup: { enabled: true, lastRun: 0, intervalHours: 24 } }), update: () => {} },
    },
  };
  await new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } }).tick();
  assert.deepEqual(created, ['g2']);
});

// ---------------------------------------------------------------- 4. /ticket rename

test('/ticket rename : accusé de réception immédiat et délai maximal (« renommage limité par Discord »)', async (t) => {
  const previous = ticketCmd.renameTimeoutMs;
  t.after(() => { ticketCmd.renameTimeoutMs = previous; });
  ticketCmd.renameTimeoutMs = 10;
  const run = async (setName) => {
    const calls = [];
    const interaction = {
      options: { getSubcommand: () => 'rename', getString: () => 'nouveau-nom' },
      channel: { id: 'c', name: 'ancien', setName, toString: () => '<#c>' },
      member: {},
      user: { id: A, tag: 'alice', toString: () => `<@${A}>` },
      deferReply: async () => calls.push('defer'),
      editReply: async (p) => calls.push(p),
      reply: async (p) => calls.push(p),
    };
    const client = { repositories: { tickets: { getByChannel: () => ({ user_id: B }) } }, services: { tickets: { assertStaff() {} } } };
    await ticketCmd.execute(interaction, client);
    return calls;
  };
  const queued = await run(() => new Promise(() => {}));
  assert.equal(queued[0], 'defer');
  assert.match(text(queued[1].embeds[0]), /limité par Discord/);
  const done = await run(async () => {});
  assert.equal(done[0], 'defer');
  assert.match(text(done[1].embeds[0]), /Ticket renommé/);
});

// ---------------------------------------------------------------- 5-7. giveaways

function giveawayWorld({ send, edit, members } = {}) {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const sent = [];
  const edits = [];
  const message = { id: 'm1', embeds: [], edit: edit ?? (async (p) => { edits.push(p); return message; }) };
  const channel = {
    isTextBased: () => true,
    send: send ?? (async (p) => { sent.push(p); return message; }),
    messages: { fetch: async () => message },
  };
  const guild = { members: { cache: members ?? new Collection(), fetch: async () => { throw apiError(10007); } } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async (id) => ({ id, bot: false }) }, guilds: { cache: new Map([['g1', guild]]) } };
  const service = new GiveawayService({ client, giveaways: repo });
  const id = repo.create({ guildId: 'g1', channelId: 'c1', messageId: 'm1', prize: 'Nitro', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() + 60_000 });
  const interaction = (userId) => ({ guildId: 'g1', user: { id: userId, bot: false }, member: { id: userId, roles: { cache: new Collection() } } });
  const member = (userId) => ({ id: userId, roles: { cache: new Collection() } });
  return { db, repo, service, id, sent, edits, interaction, member, guild };
}

const clearEdits = (service) => {
  for (const timer of service.pendingEdits.values()) clearTimeout(timer);
  service.pendingEdits.clear();
};

test('giveaway : « Participer » est idempotent, le retrait passe par « Se retirer »', async () => {
  const { repo, service, id, interaction } = giveawayWorld();
  const results = await Promise.all([service.enter(interaction(A), id), service.enter(interaction(A), id)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(repo.countEntries(id), 1, 'le double clic ne désinscrit pas');

  const click = (customId) => {
    const calls = [];
    return { calls, i: { ...interaction(A), customId, isButton: () => true, deferReply: async () => {}, editReply: async (p) => calls.push(p) } };
  };
  const client = { services: { giveaways: service } };
  const again = click(`giveaway:enter:${id}`);
  await giveawayComponent.execute(again.i, client);
  assert.match(text(again.calls[0].embeds[0]), /participez déjà/);
  assert.deepEqual(ids(again.calls[0].components), [`giveaway:leave:${id}`]);
  assert.equal(repo.countEntries(id), 1);

  const leave = click(`giveaway:leave:${id}`);
  await giveawayComponent.execute(leave.i, client);
  assert.match(text(leave.calls[0].embeds[0]), /Participation retirée/);
  assert.equal(repo.countEntries(id), 0);
  clearEdits(service);
});

test('giveaway : terminé sans gagnant et annoncé → /giveaway end ne refait pas de tirage', async () => {
  const { db, repo, service, id, sent } = giveawayWorld();
  assert.ok(db.prepare('SELECT 1 FROM _migrations WHERE id = 11').get(), 'migration 11 appliquée');
  repo.addEntry(id, A); // parti du serveur : inéligible
  assert.deepEqual(await service.end(id, { guildId: 'g1' }), []);
  assert.ok(repo.get(id).announced_at, 'annonce mémorisée');
  await assert.rejects(service.end(id, { guildId: 'g1' }), /déjà terminé/);
  assert.equal(sent.length, 1, 'une seule annonce');
});

test('giveaway : annonce impossible → carte passée en « terminé », gagnants réannoncés à la reprise', async () => {
  let fail = true;
  const sent = [];
  const members = new Collection();
  const world = giveawayWorld({ members, send: async (p) => { if (fail) throw apiError(50013, 'Missing Permissions'); sent.push(p); return {}; } });
  const { repo, service, id, edits, member } = world;
  members.set(A, member(A));
  members.set(B, member(B));
  repo.addEntry(id, A);
  await assert.rejects(service.end(id, { guildId: 'g1' }), /annonce des gagnants a échoué/);
  assert.equal(edits.length, 1, 'carte de fin publiée malgré l\'échec de l\'annonce');
  assert.deepEqual(ids(edits[0].components), [`cmd:giveaway:reroll:${id}`]);
  assert.deepEqual(repo.winners(id), [A], 'gagnant affiché = gagnant mémorisé');
  assert.equal(repo.get(id).announced_at, null);
  repo.addEntry(id, B);
  fail = false;
  assert.deepEqual(await service.end(id, { guildId: 'g1' }), [A], 'même gagnant, pas de nouveau tirage');
  assert.equal(sent.length, 1);
  await assert.rejects(service.end(id, { guildId: 'g1' }), /déjà terminé/);
});

test('giveaway : flush() exécute tout de suite les éditions en attente', async () => {
  const { service, id, interaction, edits } = giveawayWorld();
  await service.enter(interaction(A), id);
  assert.equal(service.pendingEdits.size, 1);
  await service.flush();
  assert.equal(service.pendingEdits.size, 0);
  assert.equal(edits.length, 1);
  assert.ok(JSON.stringify(json(edits[0].components[0])).includes('Participer · 1'));
});

test('/giveaway create : conditions de rôles impossibles refusées', () => {
  assert.throws(() => giveawayCmd.assertRoleConditions('g', null, 'g'), /@everyone/);
  assert.throws(() => giveawayCmd.assertRoleConditions('g', 'r', 'r'), /différents/);
  assert.doesNotThrow(() => giveawayCmd.assertRoleConditions('g', 'r1', 'r2'));
  assert.doesNotThrow(() => giveawayCmd.assertRoleConditions('g', null, null));
});

// ---------------------------------------------------------------- 8-9, 16. tickets

function ticketWorld({ create, cfg = {} } = {}) {
  const created = [];
  const guild = {
    id: 'g',
    roles: { everyone: { id: 'g' }, cache: new Collection([['r1', { id: 'r1' }]]) },
    members: { me: { id: 'bot' } },
    channels: {
      cache: new Collection([['cat', { id: 'cat', type: ChannelType.GuildCategory }]]),
      create: create ?? (async (o) => {
        const ch = { id: `c${created.length}`, ...o, sent: [], send: async (p) => ch.sent.push(p), toString: () => `<#c${created.length}>` };
        created.push(ch);
        return ch;
      }),
    },
  };
  let n = 0;
  const repo = { countOpenByUser: () => 0, create: () => ++n, getByChannel: () => null };
  const config = { get: () => ({ tickets: { maxPerUser: 5, supportRoleIds: ['r1'], ...cfg } }), update: () => {} };
  const service = new TicketService({ tickets: repo, config, logging: { send: async () => {} } });
  const user = { id: A, username: 'alice', toString: () => `<@${A}>` };
  return { service, guild, created, user };
}

test('tickets : délai de 60 s entre deux ouvertures d\'un même membre', async () => {
  const { service, guild, user } = ticketWorld();
  assert.equal(OPEN_COOLDOWN_MS, 60_000);
  await service.create(guild, user);
  await assert.rejects(service.create(guild, user), /patientez/);
  await service.create(guild, { ...user, id: B, username: 'bob' });
  service.openCooldownMs = 0;
  await service.create(guild, user);
});

test('tickets : mentions du staff autorisées explicitement (allowedMentions)', async () => {
  const { service, guild, user, created } = ticketWorld();
  await service.create(guild, user);
  const welcome = created[0].sent[0];
  assert.equal(welcome.content, `<@${A}> <@&r1>`);
  assert.deepEqual(welcome.allowedMentions, { users: [A], roles: ['r1'] });
});

test('tickets : catégorie pleine (50035) → ticket créé sans catégorie', async () => {
  const opts = [];
  const { service, guild, user } = ticketWorld({
    cfg: { categoryId: 'cat' },
    create: async (o) => {
      opts.push(o);
      if (o.parent) throw apiError(50035, 'Maximum number of channels in category reached (50)');
      return { id: 'c', ...o, send: async () => {} };
    },
  });
  await service.create(guild, user);
  assert.deepEqual(opts.map((o) => o.parent), ['cat', null]);
  // Autre erreur, ou pas de catégorie : pas de nouvel essai.
  const tries = [];
  await assert.rejects(createInCategory({ channels: { create: async (o) => { tries.push(o); throw apiError(50013); } } }, { parent: 'cat' }), /Discord error/);
  assert.equal(tries.length, 1);
});

test('tickets : transcript — nombre réel de messages, contenu des embeds, pièces jointes signalées', async () => {
  const repo = { getByChannel: () => ({ id: 3, user_id: A, created_at: 1 }) };
  const service = new TicketService({ tickets: repo, config: { get: () => ({ tickets: {} }) }, logging: {} });
  const messages = new Collection([
    ['2', { id: '2', createdTimestamp: 2, author: { tag: 'bot' }, content: '', embeds: [{ title: 'Ticket #3', description: 'Bienvenue alice' }] }],
    ['1', { id: '1', createdTimestamp: 1, author: { tag: 'alice' }, content: 'ligne 1\n[pas un message]\n[encore]', attachments: new Collection([['a', { url: 'https://cdn.example/x.png' }]]) }],
  ]);
  const channel = { id: 'c', name: 'ticket-alice', messages: { fetch: async () => messages } };
  const payload = await service.transcriptPayload(channel);
  const card = json(payload.embeds[0]);
  assert.equal(card.fields.find((f) => f.name.includes('Messages')).value, '**2**');
  assert.match(card.description, /pièces jointes ne sont pas archivées/);
  const file = payload.files[0].attachment.toString('utf8');
  assert.match(file, /Ticket #3\] Bienvenue alice/);
  assert.match(file, /pièces jointes ne sont pas archivées/);
  assert.match(file, /https:\/\/cdn\.example\/x\.png/);
});

test('tickets : flush() termine immédiatement une fermeture en attente', async () => {
  const deleted = [];
  const repo = { getByChannel: () => ({ id: 1, user_id: A, created_at: 1 }), setStatus: () => {}, delete: (id) => deleted.push(`row:${id}`) };
  const service = new TicketService({ tickets: repo, config: { get: () => ({ tickets: {} }), update: () => {} }, logging: {} });
  const channel = {
    id: 'c',
    name: 'ticket',
    guild: { id: 'g', channels: { fetch: async () => null } },
    send: async () => {},
    messages: { fetch: async () => new Collection() },
    delete: async () => deleted.push('channel'),
  };
  const closing = service.close(channel, { toString: () => 'x' }, { delayMs: 60_000 });
  assert.equal(service.closeJobs.size, 1);
  const started = Date.now();
  await service.flush();
  await closing;
  assert.ok(Date.now() - started < 5_000, 'délai écourté');
  assert.deepEqual(deleted, ['row:c', 'channel']);
  assert.equal(service.closeJobs.size, 0);
  assert.equal(service.closing.size, 0);
});

test('confirmation de fermeture : le salon de transcripts n\'est cité que s\'il existe', () => {
  const client = { services: { config: { get: () => ({ tickets: { logChannel: '555' } }) } } };
  const gone = json(ticketComponent.closeConfirmation(client, { id: 'g', channels: { cache: new Collection() } }).embeds[0]);
  assert.doesNotMatch(gone.description, /<#555>/);
  assert.match(gone.description, /n'existe plus/);
  const present = json(ticketComponent.closeConfirmation(client, { id: 'g', channels: { cache: new Collection([['555', {}]]) } }).embeds[0]);
  assert.match(present.description, /<#555>/);
});

test('/tickets : emoji personnalisé inconnu refusé, vraie erreur de publication affichée', () => {
  const line = '<:pepe:123456789012345678> Partenariat';
  assert.throws(() => tickets.parseReasons(line, { hasEmoji: () => false }), /Emoji inconnu/);
  assert.equal(tickets.parseReasons(line, { hasEmoji: () => true })[0].emoji, '<:pepe:123456789012345678>');
  const channel = { toString: () => '<#p>' };
  const invalid = tickets.publishFailure(channel, apiError(50035, 'Invalid Form Body\ncomponents[0].components[0].options[0].emoji.id: Invalid emoji'));
  assert.match(invalid, /Invalid emoji/);
  assert.doesNotMatch(invalid, /il me faut/);
  assert.match(tickets.publishFailure(channel, apiError(50013)), /il me faut/);
});

// ---------------------------------------------------------------- 9-10. ModMail

function modmailWorld({ create, fetchChannel } = {}) {
  const { db } = memoryDb();
  const repo = new ModmailRepository(db);
  const sent = [];
  const guild = {
    id: 'g',
    name: 'Serveur',
    iconURL: () => null,
    members: { cache: new Collection([[A, { id: A }]]), me: { id: 'bot' }, fetch: async () => null },
    roles: { everyone: { id: 'g' }, cache: new Collection([['r1', { id: 'r1' }]]) },
    channels: {
      cache: new Collection(),
      fetch: fetchChannel ?? (async () => null),
      create: create ?? (async (o) => ({ id: 'chan', ...o, send: async (p) => sent.push(p) })),
    },
  };
  const client = { guilds: { cache: new Collection([['g', guild]]) } };
  const config = { get: () => ({ modmail: { enabled: true, staffRoleId: 'r1' } }) };
  const service = new ModmailService({ client, modmail: repo, config });
  const replies = [];
  const dm = () => ({ author: { id: A, username: 'alice', tag: 'alice', send: async () => {} }, content: 'aide', reply: async (p) => replies.push(p), react: async () => {} });
  return { repo, service, sent, replies, dm };
}

test('ModMail : ping du rôle staff autorisé explicitement (allowedMentions)', async () => {
  const { service, sent, dm } = modmailWorld();
  await service.handleUserDM(dm());
  assert.equal(sent[0].content, '<@&r1>');
  assert.deepEqual(sent[0].allowedMentions, { roles: ['r1'] });
});

test('ModMail : création impossible → le membre est prévenu et l\'erreur remonte (journalisée)', async () => {
  const { service, replies, dm } = modmailWorld({ create: async () => { throw apiError(50013, 'Missing Permissions'); } });
  await assert.rejects(service.handleUserDM(dm()), /Missing Permissions/);
  assert.equal(replies.length, 1);
  assert.match(text(replies[0].embeds[0]), /n'a pas pu être transmis/);
});

test('ModMail : salon momentanément inaccessible → la conversation n\'est pas fermée', async () => {
  const { repo, service, replies, dm } = modmailWorld({ fetchChannel: async () => { throw apiError(500, 'Internal Server Error'); } });
  repo.create({ guildId: 'g', userId: A, channelId: 'old' });
  await assert.rejects(service.handleUserDM(dm()), /inaccessible/);
  assert.ok(repo.getOpenByUser(A), 'conversation toujours ouverte');
  assert.equal(replies.length, 1);

  // Salon confirmé supprimé (10003) : la ligne périmée est fermée et une nouvelle conversation s'ouvre.
  const gone = modmailWorld({ fetchChannel: async () => { throw apiError(10003, 'Unknown Channel'); } });
  gone.repo.create({ guildId: 'g', userId: A, channelId: 'old' });
  await gone.service.handleUserDM(gone.dm());
  assert.equal(gone.repo.getOpenByUser(A).channel_id, 'chan');

  // Revue 3 — accès perdu au salon (50001) : sans issue sinon, une nouvelle conversation s'ouvre.
  const lost = modmailWorld({ fetchChannel: async () => { throw apiError(50001, 'Missing Access'); } });
  lost.repo.create({ guildId: 'g', userId: A, channelId: 'old' });
  await lost.service.handleUserDM(lost.dm());
  assert.equal(lost.repo.getOpenByUser(A).channel_id, 'chan');
});

// ---------------------------------------------------------------- 13. permissions revérifiées

test('permissions revérifiées dans execute : /backup, /custom, /giveaway, /modmail reply|close', async () => {
  const none = (sub) => ({ memberPermissions: perms(), options: { getSubcommand: () => sub } });
  await assert.rejects(backupCmd.execute(none('list'), { services: {} }), /Administrateur/);
  await assert.rejects(customCmd.execute(none('list'), { repositories: {} }), /Gérer le serveur/);
  for (const sub of ['create', 'end', 'reroll']) {
    await assert.rejects(giveawayCmd.execute(none(sub), { services: {} }), /Gérer les événements/, sub);
  }
  const modmail = new ModmailService({ client: {}, modmail: {}, config: { get: () => ({ modmail: { staffRoleId: 'staff' } }) } });
  const member = { permissions: perms(), guild: { id: 'g' }, roles: { cache: new Collection() } };
  for (const sub of ['reply', 'close']) {
    await assert.rejects(modmailCmd.execute({ ...none(sub), member }, { services: { modmail } }), /staff ModMail/, sub);
  }
});

// ---------------------------------------------------------------- 11, 17-18. divers

test('/projet publier : il faut voir ET écrire dans le salon visé', async () => {
  const channel = { id: 'c', isTextBased: () => true, permissionsFor: () => perms(PermissionFlagsBits.SendMessages), toString: () => '<#c>' };
  const interaction = { options: { getSubcommand: () => 'publier', getString: () => '1', getChannel: () => channel }, guild: { id: 'g' }, member: {} };
  const service = { resolve: () => ({ id: 1 }), settings: () => ({}), assertCanEdit() {} };
  await assert.rejects(projetCmd.execute(interaction, { services: { projects: service } }), /Vous ne pouvez pas envoyer/);
});

test('/reminder : 25 rappels actifs au maximum par utilisateur', async () => {
  let created = 0;
  const repo = { listByUser: () => Array.from({ length: reminderCmd.MAX_ACTIVE_REMINDERS }, (_, i) => ({ id: i })), create: () => { created += 1; return 1; } };
  const interaction = { options: { getSubcommand: () => 'create', getString: (n) => (n === 'duree' ? '10m' : 'boire') }, user: { id: A }, guildId: 'g', channelId: 'c' };
  await assert.rejects(reminderCmd.execute(interaction, { repositories: { reminders: repo } }), /maximum 25/);
  assert.equal(created, 0);
});

test('/tag et /custom delete : nom normalisé comme à la création', async () => {
  const asked = [];
  const repo = { get: (g, name) => { asked.push(name); return { name, content: 'x' }; }, delete: (g, name) => { asked.push(`del:${name}`); return true; } };
  const base = { guild: { id: 'g', name: 'S', memberCount: 1 }, user: { id: A, toString: () => `<@${A}>` }, reply: async () => {} };
  await tagCmd.execute({ ...base, options: { getString: () => '  Mon Tag ' } }, { repositories: { customCommands: repo } });
  await customCmd.execute(
    { ...base, memberPermissions: perms(PermissionFlagsBits.ManageGuild), options: { getSubcommand: () => 'delete', getString: () => 'Mon Tag' } },
    { repositories: { customCommands: repo } },
  );
  assert.deepEqual(asked, ['mon-tag', 'del:mon-tag']);
  assert.equal(tagCmd.lookupTagName('ancien.tag'), 'ancien.tag', 'nom hérité hors format : cherché tel quel');
});

test('projets : le transfert ne dépasse pas la limite de membres ; flush() rafraîchit tout de suite', async () => {
  const { db } = memoryDb();
  const projects = new ProjectRepository(db);
  const config = new ConfigService(new GuildConfigRepository(db));
  const service = new ProjectService({ client: { channels: { fetch: async () => null } }, projects, config });
  service.scheduleRefresh = () => {};
  const owner = { id: 'o', guild: { id: 'g1' }, permissions: { has: () => false }, roles: { cache: new Map() } };
  const project = service.create(owner, { name: 'Équipe' });
  for (let i = 0; i < LIMITS.members; i++) service.addMember(project, `m${i}`);
  assert.throws(() => service.transfer(project, 'externe'), /complète/);
  const moved = service.transfer(projects.get(project.id), 'm0');
  assert.equal(moved.ownerId, 'm0');
  assert.equal(projects.members(project.id).length, LIMITS.members);

  delete service.scheduleRefresh;
  const refreshed = [];
  service.refreshPublished = async (id) => refreshed.push(id);
  service.scheduleRefresh(project.id);
  assert.equal(service.pendingRefresh.size, 1);
  await service.flush();
  assert.deepEqual(refreshed, [project.id]);
  assert.equal(service.pendingRefresh.size, 0);
});
