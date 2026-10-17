'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { TicketRatingRepository } = require('../src/database/repositories/TicketRatingRepository');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { TicketService } = require('../src/services/TicketService');
const R = require('../src/services/TicketRatingService');
const tickets = require('../src/commands/tickets/tickets');
const cmdRouter = require('../src/components/cmd');
const { defaultGuildConfig } = require('../src/config/defaults');

const { TicketRatingService } = R;
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const ids = (rows) => rows.map(json).flatMap((r) => r.components.map((c) => c.custom_id).filter(Boolean));

const GUILD = '100000000000000001';
const AUTHOR = '200000000000000001';
const OTHER = '200000000000000002';
const STAFF = '200000000000000003';
const STAFF2 = '200000000000000004';
const H = 3_600_000;

// ---------------------------------------------------------------- briques pures

test('starBar / formatAverage / formatAvgDuration / parseStars / parseTicketId', () => {
  assert.equal(R.starBar(4), '⭐⭐⭐⭐☆');
  assert.equal(R.starBar(0), '☆☆☆☆☆');
  assert.equal(R.starBar(9), '⭐⭐⭐⭐⭐');
  assert.equal(R.formatAverage(4.25), '4,3 / 5');
  assert.equal(R.formatAverage(null), null);
  assert.equal(R.formatAvgDuration(null), '—');
  assert.equal(R.formatAvgDuration(30_000), '< 1m');
  assert.equal(R.formatAvgDuration(90 * 60_000), '1h 30m');
  for (const ok of ['1', '5']) assert.equal(R.parseStars(ok), Number(ok));
  for (const bad of ['0', '6', '2.5', 'x', undefined]) assert.throws(() => R.parseStars(bad), /invalide/);
  assert.equal(R.parseTicketId('42'), 42);
  for (const bad of ['', '-1', '1e3', 'abc', '1'.repeat(13)]) assert.throws(() => R.parseTicketId(bad), /invalide/);
  assert.equal(defaultGuildConfig.tickets.ratings, true, 'notation activée par défaut');
});

// ---------------------------------------------------------------- dépôt

test('TicketRatingRepository : instantané idempotent, une note par l\'auteur, commentaire après la note, statistiques', () => {
  const { db } = memoryDb();
  const repo = new TicketRatingRepository(db);
  const now = Date.now();
  assert.equal(repo.recordClosure({ ticketId: 1, guildId: GUILD, userId: AUTHOR, claimedBy: STAFF, openedAt: now - 2 * H, claimedAt: now - 2 * H + 600_000, closedAt: now }), true);
  assert.equal(repo.recordClosure({ ticketId: 1, guildId: GUILD, userId: OTHER, closedAt: now }), false, 'instantané conservé');
  assert.equal(repo.get(1).user_id, AUTHOR);

  assert.equal(repo.comment(1, AUTHOR, 'trop tôt'), false, 'commentaire avant la note');
  assert.equal(repo.rate(1, OTHER, 1), false, 'note d\'un autre utilisateur');
  assert.equal(repo.rate(1, AUTHOR, 5), true);
  assert.equal(repo.rate(1, AUTHOR, 1), false, 'deuxième note');
  assert.equal(repo.get(1).rating, 5);
  assert.equal(repo.comment(1, OTHER, 'x'), false);
  assert.equal(repo.comment(1, AUTHOR, 'Parfait'), true);
  assert.equal(repo.comment(1, AUTHOR, 'Encore'), false);

  repo.recordClosure({ ticketId: 2, guildId: GUILD, userId: OTHER, claimedBy: STAFF, openedAt: now - 4 * H, claimedAt: now - 4 * H + 1_200_000, closedAt: now });
  repo.rate(2, OTHER, 3);
  repo.recordClosure({ ticketId: 3, guildId: GUILD, userId: OTHER, claimedBy: STAFF2, openedAt: now - H, claimedAt: null, closedAt: now });
  repo.recordClosure({ ticketId: 4, guildId: GUILD, userId: AUTHOR, claimedBy: null, openedAt: now - 40 * 86_400_000, closedAt: now - 30 * 86_400_000 });
  repo.recordClosure({ ticketId: 5, guildId: '100000000000000002', userId: AUTHOR, closedAt: now });

  const s = repo.summary(GUILD);
  assert.equal(s.closed, 4);
  assert.equal(s.rated, 2);
  assert.equal(s.avgRating, 4);
  assert.equal(s.avgClaimMs, (600_000 + 1_200_000) / 2, 'délai moyen de prise en charge (tickets pris en charge seulement)');
  assert.ok(s.avgCloseMs > 0);
  assert.equal(repo.summary(GUILD, now - 7 * 86_400_000).closed, 3, 'période');
  const staff = repo.byStaff(GUILD);
  assert.deepEqual(staff.map((x) => [x.staffId, x.tickets, x.rated, x.avgRating]), [[STAFF, 2, 2, 4], [STAFF2, 1, 0, null]]);
  assert.equal(staff[0].avgClaimMs, 900_000);
  assert.deepEqual(repo.distribution(GUILD), [0, 0, 1, 0, 1]);
  assert.deepEqual(repo.recentComments(GUILD).map((c) => c.comment), ['Parfait']);
  assert.deepEqual(repo.summary('100000000000000009'), { closed: 0, rated: 0, avgRating: null, avgClaimMs: null, avgCloseMs: null });
});

test('TicketRepository : claimed_at posé à la prise en charge et conservé à la fermeture', () => {
  const { db } = memoryDb();
  const repo = new TicketRepository(db);
  repo.create({ guildId: GUILD, channelId: '400000000000000001', userId: AUTHOR });
  repo.setStatus('400000000000000001', 'claimed', { claimedBy: STAFF, claimedAt: 1234 });
  repo.setStatus('400000000000000001', 'claimed', { claimedBy: STAFF, claimedAt: 9999 });
  assert.equal(repo.getByChannel('400000000000000001').claimed_at, 1234, 'première prise en charge conservée');
  repo.setStatus('400000000000000001', 'closed', { claimedBy: STAFF, closedAt: 5678 });
  const row = repo.getByChannel('400000000000000001');
  assert.equal(row.claimed_at, 1234);
  assert.equal(row.closed_at, 5678);
});

// ---------------------------------------------------------------- service

function world({ ratings = true, bot = false, dmFails = false } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update(GUILD, { tickets: { ratings } });
  const repo = new TicketRatingRepository(db);
  const dms = [];
  const logs = [];
  const client = {
    users: {
      fetch: async (id) => ({ id, bot, send: async (p) => (dmFails ? Promise.reject(new Error('Cannot send')) : dms.push({ id, p })) }),
    },
  };
  const service = new TicketRatingService({ client, ratings: repo, config, logging: { send: async (...args) => logs.push(args) } });
  const guild = { id: GUILD, name: 'Gadget' };
  return { db, config, repo, service, dms, logs, guild };
}

const ticketRow = (id = 7, extra = {}) => ({ id, user_id: AUTHOR, claimed_by: STAFF, created_at: Date.now() - H, claimed_at: Date.now() - H / 2, ...extra });

test('onClosed : instantané + MP de notation (5 boutons) ; rien si désactivé, bot ou arrêt en cours', async () => {
  const w = world();
  w.service.onClosed({ guild: w.guild, ticket: ticketRow(), closedBy: { id: STAFF }, closedAt: Date.now() });
  await Promise.allSettled([...w.service.pending]);
  const row = w.repo.get(7);
  assert.equal(row.closed_by, STAFF);
  assert.ok(row.claimed_at);
  assert.equal(w.dms.length, 1);
  const payload = w.dms[0].p;
  assert.deepEqual(ids(payload.components), [1, 2, 3, 4, 5].map((n) => `cmd:tickets:rate:7:${n}`));
  for (const id of ids(payload.components)) assert.ok(id.length <= 100);
  assert.match(JSON.stringify(payload.embeds[0]), /Gadget/);

  const off = world({ ratings: false });
  off.service.onClosed({ guild: off.guild, ticket: ticketRow(8) });
  await Promise.allSettled([...off.service.pending]);
  assert.ok(off.repo.get(8), 'instantané tenu même sans notation');
  assert.equal(off.dms.length, 0);

  const bots = world({ bot: true });
  bots.service.onClosed({ guild: bots.guild, ticket: ticketRow(9) });
  await Promise.allSettled([...bots.service.pending]);
  assert.equal(bots.dms.length, 0, 'jamais de MP à un bot');

  const stopping = world();
  await stopping.service.flush();
  stopping.service.onClosed({ guild: stopping.guild, ticket: ticketRow(10) });
  assert.equal(stopping.service.pending.size, 0, 'aucun nouveau MP pendant l\'arrêt');
  assert.ok(stopping.repo.get(10));

  const closed = world({ dmFails: true });
  assert.doesNotThrow(() => closed.service.onClosed({ guild: closed.guild, ticket: ticketRow(11) }));
  await closed.service.flush();
  // Données incomplètes : ignorées sans lever.
  assert.doesNotThrow(() => w.service.onClosed({ guild: w.guild, ticket: { id: null } }));
  assert.doesNotThrow(() => w.service.onClosed({ guild: null, ticket: ticketRow(12) }));
});

test('rate / comment : auteur seulement, une fois, commentaire borné après la note', async () => {
  const w = world();
  w.service.onClosed({ guild: w.guild, ticket: ticketRow(3) });
  await w.service.flush();
  assert.throws(() => w.service.rate(3, OTHER, 5), /auteur du ticket/);
  assert.throws(() => w.service.rate(99, AUTHOR, 5), /introuvable/);
  assert.throws(() => w.service.comment(3, AUTHOR, 'x'), /Notez d'abord/);
  const row = w.service.rate(3, AUTHOR, 2);
  assert.equal(row.rating, 2);
  assert.throws(() => w.service.rate(3, AUTHOR, 5), /déjà noté/);
  const thanks = w.service.thanksPayload(row);
  assert.deepEqual(ids(thanks.components), ['cmd:tickets:ratecomment:3']);
  assert.throws(() => w.service.comment(3, AUTHOR, '   '), /vide/);
  assert.throws(() => w.service.comment(3, AUTHOR, 'x'.repeat(R.MAX_COMMENT + 1)), /500/);
  const commented = w.service.comment(3, AUTHOR, '  Merci !  ');
  assert.equal(commented.comment, 'Merci !');
  assert.throws(() => w.service.comment(3, AUTHOR, 'Encore'), /déjà commenté/);
  assert.deepEqual(w.service.thanksPayload(commented).components, []);
  await w.service.log(commented, { comment: true });
  assert.equal(w.logs[0][1], 'moderation');
  assert.deepEqual(w.logs[0][4], { event: 'ticketRating' });
});

test('TicketService : la fermeture prévient la notation avec la ligne relue (prise en charge comprise)', async () => {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new TicketRepository(db);
  repo.create({ guildId: GUILD, channelId: '400000000000000001', userId: AUTHOR });
  const calls = [];
  const service = new TicketService({ tickets: repo, config, logging: { send: async () => {} }, ratings: { onClosed: (info) => calls.push(info) } });
  const channel = {
    id: '400000000000000001',
    name: 'ticket',
    guild: { id: GUILD, channels: { fetch: async () => null } },
    send: async () => {},
    messages: { fetch: async () => new Collection() },
    delete: async () => {},
  };
  // Prise en charge pendant le délai de fermeture : relue au moment de fermer.
  repo.setStatus(channel.id, 'claimed', { claimedBy: STAFF, claimedAt: 4242 });
  await service.close(channel, { id: OTHER, toString: () => `<@${OTHER}>` }, { delayMs: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ticket.claimed_at, 4242);
  assert.equal(calls[0].closedBy.id, OTHER);
  assert.equal(repo.getByChannel(channel.id), undefined, 'ligne supprimée après la fermeture');
  // Sans service de notation (tests, outils) : aucune erreur.
  const bare = new TicketService({ tickets: { getByChannel: () => ({ id: 1, user_id: AUTHOR }), setStatus: () => {}, delete: () => {} }, config, logging: {} });
  await bare.close({ ...channel, id: 'x' }, { id: OTHER }, { delayMs: 0 });
});

test('routeur cmd : seules les actions `dmButtons` de /tickets sont acceptées en MP', async () => {
  assert.deepEqual(tickets.dmButtons, ['rate', 'ratecomment', 'ratenote']);
  const rated = [];
  const client = {
    commands: new Collection([['tickets', tickets]]),
    services: { ticketRatings: { rate: (id, user, n) => { rated.push([id, user, n]); return { ticket_id: id, rating: n, comment: null }; }, thanksPayload: () => ({ embeds: [], components: [] }), log: async () => {} } },
  };
  const dm = (customId) => ({ customId, inGuild: () => false, user: { id: AUTHOR }, values: [], update: async () => {}, memberPermissions: null });
  await cmdRouter.execute(dm('cmd:tickets:rate:7:4'), client);
  assert.deepEqual(rated, [[7, AUTHOR, 4]]);
  await assert.rejects(cmdRouter.execute(dm('cmd:tickets:go:home'), client), /que sur un serveur/);
  await assert.rejects(cmdRouter.execute(dm('cmd:tickets:ratings:on'), client), /que sur un serveur/);
  await assert.rejects(cmdRouter.execute(dm('cmd:tickets:rate:7:9'), client), /invalide/);
});

test('/tickets : vue « Statistiques » dans les limites (vide et remplie), notation désactivable', () => {
  const w = world();
  const now = Date.now();
  for (let i = 1; i <= 15; i += 1) {
    w.repo.recordClosure({ ticketId: i, guildId: GUILD, userId: AUTHOR, claimedBy: String(300000000000000000n + BigInt(i % 12)), openedAt: now - H, claimedAt: now - H / 2, closedAt: now });
    w.repo.rate(i, AUTHOR, (i % 5) + 1);
    w.repo.comment(i, AUTHOR, `Commentaire ${'x'.repeat(400)} ${i}`);
  }
  const guild = { id: GUILD, name: 'Gadget', channels: { cache: new Collection() }, roles: { cache: new Collection() } };
  const client = { services: { config: w.config, ticketRatings: w.service, tickets: { panel: () => ({ embeds: [] }) } }, repositories: { tickets: { listByGuild: () => [] } } };
  for (const view of ['stats', 'stats.7', 'stats.30', 'home']) {
    const payload = tickets.render(client, guild, view);
    assert.ok(payload.components.length <= 5);
    for (const id of ids(payload.components)) {
      const [, cmd, action] = id.split(':');
      assert.equal(cmd, 'tickets');
      assert.equal(typeof tickets.buttons[action], 'function', action);
    }
    const e = json(payload.embeds[0]);
    for (const f of e.fields ?? []) assert.ok(f.value.length <= 1024, `${view} : champ ${f.name} trop long`);
  }
  const stats = JSON.stringify(json(tickets.render(client, guild, 'stats').embeds[0]));
  assert.match(stats, /Note moyenne/);
  assert.match(stats, /Par membre du staff/);
  assert.ok(ids(tickets.render(client, guild, 'stats').components).includes('cmd:tickets:ratings:off'));
  w.config.update(GUILD, { tickets: { ratings: false } });
  assert.ok(ids(tickets.render(client, guild, 'stats').components).includes('cmd:tickets:ratings:on'));
  const empty = world();
  const emptyClient = { ...client, services: { ...client.services, config: empty.config, ticketRatings: empty.service } };
  assert.match(JSON.stringify(json(tickets.render(emptyClient, guild, 'stats').embeds[0])), /Aucun avis/);
  // Permission revérifiée sur le bouton de la vue.
  const denied = { memberPermissions: new PermissionsBitField(0n), guildId: GUILD, guild, update: async () => {} };
  return assert.rejects(tickets.buttons.ratings(denied, client, ['on']), /Gérer le serveur/);
});
