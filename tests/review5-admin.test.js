'use strict';

/**
 * Revue n° 5 (outils d'administration, statistiques, candidatures) : tests de régression
 * unitaires. Chaque test échoue sans le correctif correspondant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, PermissionFlagsBits } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { TicketRatingRepository } = require('../src/database/repositories/TicketRatingRepository');
const { TimedActionRepository } = require('../src/database/repositories/TimedActionRepository');
const { ActivityRepository } = require('../src/database/repositories/ActivityRepository');
const { ApplicationRepository } = require('../src/database/repositories/ApplicationRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ModerationService } = require('../src/services/ModerationService');
const { TimedLockService } = require('../src/services/TimedLockService');
const { ActivityService, GAP_MS } = require('../src/services/ActivityService');
const { ApplicationService, PING_GAP_MS } = require('../src/services/ApplicationService');
const { UserError } = require('../src/core/errors');
const A = require('../src/utils/activity');
const activite = require('../src/commands/moderation/activite');
const modstats = require('../src/commands/moderation/modstats');
const emoji = require('../src/commands/information/emoji');

const G = '100000000000000001';
const U = '500000000000000001';
const MOD = '500000000000000002';
const NOON = Date.parse('2026-10-09T12:00:00Z');
const HOUR = 3_600_000;

function db() {
  return memoryDb().db;
}

// ---------------------------------------------------------------- softban

test('softban d\'un MEMBRE : ban relu juste avant le bannissement, déjà banni → refus sans ban ni débannissement', async () => {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  config.update(G, { moderation: { dmOnSanction: false } });
  const sanctions = new SanctionRepository(raw);
  const moderation = new ModerationService({ sanctions, config, logging: { send: async () => true } });
  const calls = [];
  const guild = {
    id: G,
    ownerId: '500000000000000099',
    members: { me: { id: 'bot', roles: { highest: { position: 50 } } } },
    bans: {
      create: async (id) => calls.push(['ban', id]),
      remove: async (id) => calls.push(['unban', id]),
      // Un autre modérateur a banni le membre pendant la confirmation.
      fetch: async (opts) => {
        calls.push(['fetch', opts?.force === true]);
        return { user: { id: opts?.user ?? opts } };
      },
    },
  };
  guild.members.me.guild = guild;
  const moderator = { id: MOD, guild, roles: { highest: { position: 40 } } };
  const user = { id: U, send: async () => null };
  const member = { id: U, guild, user, bannable: true, joinedTimestamp: 1, roles: { highest: { position: 1 } } };
  await assert.rejects(moderation.softban(guild, user, moderator, 'spam', { targetMember: member }), /déjà banni/);
  assert.deepEqual(calls, [['fetch', true]], 'ban relu sur l\'API, aucun ban ni débannissement');
  assert.equal(sanctions.listPage(G, U, { limit: 5 }).length, 0, 'aucune sanction enregistrée');
});

test('expulsions groupées : sanction « kick » enregistrée et AntiRaid prévenu au nom du modérateur', async () => {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  const sanctions = new SanctionRepository(raw);
  const reported = [];
  const antiraid = { handleDestructive: async (...args) => reported.push(args) };
  const moderation = new ModerationService({ sanctions, config, logging: { send: async () => true }, antiraid });
  const guild = { id: G };
  const id = await moderation.recordBulkKick(guild, { id: U }, { id: MOD }, 'Inactivité (30 jours)', { targetJoinedAt: 5 });
  const row = sanctions.get(G, id);
  assert.equal(row.type, 'kick');
  assert.equal(row.moderator_id, MOD);
  assert.equal(row.reason, 'Inactivité (30 jours)');
  assert.deepEqual(reported, [[guild, MOD, 'kick', { targetId: U, targetJoinedAt: 5 }]]);
  await moderation.reportDestructiveAction(guild, { id: MOD }, 'channelDelete');
  assert.deepEqual(reported[1], [guild, MOD, 'channelDelete', { targetId: null, targetJoinedAt: null }]);
});

// ---------------------------------------------------------------- levées programmées

test('levées programmées : les lignes en attente de réessai ne monopolisent pas le passage ; réessais oubliés une fois la ligne close', async () => {
  const raw = db();
  const timed = new TimedActionRepository(raw);
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 201; i += 1) ids.push(timed.schedule({ guildId: `9000000000000${String(i).padStart(5, '0')}`, channelId: `8${i}`, kind: 'lock', expiresAt: now - 10_000 + i, now: now - 20_000 }));
  // Serveurs absents (client prêt) : une ligne traitée est close « gone ».
  const client = { guilds: { cache: new Map() }, isReady: () => true };
  const service = new TimedLockService({ client, timed });
  for (const id of ids.slice(0, 200)) service.retries.set(id, { at: Date.now() + 3_600_000, attempts: 3 });
  assert.equal(timed.findDue(now, { exclude: ids.slice(0, 200) }).length, 1);
  await service.processDue();
  assert.equal(timed.byId(ids[200]).active, 0, 'la 201e ligne échue n\'a pas été traitée');
  assert.equal(timed.byId(ids[200]).end_reason, 'gone');
  // Une ligne en attente annulée entre-temps (/unlock) : son réessai est oublié.
  timed.close(ids[0], 'cancelled');
  await service.processDue();
  assert.equal(service.retries.has(ids[0]), false, 'réessai d\'une ligne close conservé');
  assert.equal(service.retries.size, 199);
});

// ---------------------------------------------------------------- statistiques

function statsWorld({ clock = NOON } = {}) {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  const repo = new ActivityRepository(raw);
  const time = { now: clock };
  const guild = { id: G, available: true, afkChannelId: null, voiceStates: { cache: new Collection() }, channels: { cache: new Collection() } };
  const guilds = new Collection([[G, guild]]);
  const client = { guilds: { cache: guilds }, isReady: () => true };
  const service = new ActivityService({ client, activity: repo, config, clock: () => time.now });
  client.services = { config, activity: service };
  return { raw, config, repo, service, time, guild, guilds, client };
}

test('statistiques : lectures restreintes à une liste de salons (lecteur non gestionnaire)', () => {
  const { repo } = statsWorld();
  const day = A.dayKey(NOON);
  repo.applyBatch({
    messages: [
      { guildId: G, day, channelId: 'pub', userId: U, count: 3 },
      { guildId: G, day, channelId: 'staff', userId: MOD, count: 7 },
    ],
  });
  assert.equal(repo.totals(G, day).messages, 10);
  assert.equal(repo.totals(G, day, ['pub']).messages, 3, 'salon privé compté');
  assert.deepEqual(repo.topChannels(G, day, 10, ['pub']).map((c) => c.channel_id), ['pub']);
  assert.deepEqual(repo.topMembers(G, day, 10, ['pub']).map((m) => m.user_id), [U]);
  assert.deepEqual(repo.memberChannels(G, MOD, day, 5, ['pub']), []);
  assert.equal(repo.memberLastDay(G, MOD, ['pub']), null);
  assert.equal(repo.sums(G, day, ['pub']).messages, 3);
  assert.equal(repo.totals(G, day, []).messages, 0, 'liste vide : aucun salon');
});

test('statistiques : résultats en cache 60 s, délai de 5 s entre deux clics d\'un membre', () => {
  const { service, time } = statsWorld();
  let computed = 0;
  const compute = () => ++computed;
  assert.equal(service.cachedView(`${G}:salons`, compute), 1);
  assert.equal(service.cachedView(`${G}:salons`, compute), 1, 'recalculé malgré le cache');
  assert.equal(service.cachedView(`${G}:salons`, compute, { refresh: true }), 2);
  time.now += 61_000;
  assert.equal(service.cachedView(`${G}:salons`, compute), 3, 'cache expiré non recalculé');
  service.forgetViews(G);
  assert.equal(service.cachedView(`${G}:salons`, compute), 4);
  assert.equal(service.takeViewCooldown(G, U), 0);
  assert.ok(service.takeViewCooldown(G, U) > 0, 'second clic immédiat accepté');
  time.now += 5_001;
  assert.equal(service.takeViewCooldown(G, U), 0);
});

test('/activite : un trou de collecte de plus de 6 h dans la fenêtre bloque les actions groupées', () => {
  const { repo, service, time, client } = statsWorld({ clock: NOON - 40 * A.DAY_MS });
  repo.setSince(G, time.now);
  service.onGuildAvailable(client.guilds.cache.get(G)); // premier battement
  // Bot actif jusqu'à J-10, puis hors ligne 2 jours.
  time.now = NOON - 12 * A.DAY_MS;
  service.flush();
  time.now = NOON - 10 * A.DAY_MS;
  service.onGuildAvailable(client.guilds.cache.get(G)); // redémarrage
  const gap = repo.getGap(G);
  assert.deepEqual(gap, { start: NOON - 12 * A.DAY_MS, end: NOON - 10 * A.DAY_MS });
  // Battements réguliers ensuite (< 6 h d'écart) : aucun nouveau trou.
  time.now += GAP_MS - 1;
  service.flush();
  assert.deepEqual(repo.getGap(G), gap);
  time.now = NOON;
  assert.equal(service.canAct(G, 30), false, 'actions groupées permises malgré le trou');
  assert.match(activite.blockedReason(client, G, 30, NOON), /interrompue/);
  // Fenêtre de 7 jours : le trou est plus ancien, les actions sont permises.
  assert.equal(service.canAct(G, 7), true);
  assert.equal(activite.blockedReason(client, G, 7, NOON), null);
});

test('statistiques : sessions vocales d\'un serveur quitté closes (sans crédit indéfini)', () => {
  const { repo, service, time, guild, guilds } = statsWorld();
  const member = { id: U, user: { bot: false } };
  guild.voiceStates.cache.set(U, { channelId: 'V1' });
  service.trackVoice({ channelId: null, member, guild }, { channelId: 'V1', member, guild, channel: { id: 'V1' } });
  time.now += 60_000;
  service.flush();
  guilds.delete(G); // le bot est retiré du serveur
  for (let i = 0; i < 3; i += 1) {
    time.now += A.DAY_MS;
    service.flush();
  }
  assert.equal(service.sessions.size, 0, 'session fantôme conservée');
  assert.equal(repo.totals(G, '2000-01-01').voice, 60);
  // guildDelete : sessions créditées jusqu'au départ puis closes.
  guilds.set(G, guild);
  service.trackVoice({ channelId: null, member, guild }, { channelId: 'V1', member, guild, channel: { id: 'V1' } });
  time.now += 30_000;
  service.onGuildRemoved(G);
  assert.equal(service.sessions.size, 0);
  service.flush();
  assert.equal(repo.totals(G, '2000-01-01').voice, 90);
});

test('migration 27 : battement et dernier trou de collecte (stats_guilds)', () => {
  const m = migrations.find((x) => x.id === 27);
  assert.ok(m, 'migration 27 présente');
  const cols = db().prepare('PRAGMA table_info(stats_guilds)').all().map((c) => c.name);
  for (const c of ['last_seen', 'gap_start', 'gap_end']) assert.ok(cols.includes(c), c);
});

// ---------------------------------------------------------------- candidatures

function applicationWorld() {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  const applications = new ApplicationRepository(raw);
  const sent = [];
  const everyoneRole = { id: G };
  let publicReview = false;
  const review = {
    id: '700000000000000001',
    type: ChannelType.GuildText,
    permissionsFor: (who) => ({ has: (flag) => (who === everyoneRole ? publicReview && flag === PermissionFlagsBits.ViewChannel : true) }),
    send: async (payload) => {
      sent.push(payload);
      return { id: String(800000000000000000n + BigInt(sent.length)), channelId: review.id };
    },
  };
  const guild = {
    id: G,
    name: 'Serveur',
    ownerId: '500000000000000099',
    members: { me: { id: 'bot' }, cache: new Collection() },
    roles: { everyone: everyoneRole, cache: new Collection([['600000000000000001', { id: '600000000000000001' }]]) },
    channels: { cache: new Collection([[review.id, review]]) },
  };
  const service = new ApplicationService({ client: { users: { fetch: async () => null } }, applications, config, logging: { send: async () => true } });
  const form = service.createForm(G, { name: 'Recrutement', questions: [{ label: 'Pourquoi ?', long: false }] });
  service.updateForm(G, form.id, { reviewChannelId: review.id, pingRoleId: '600000000000000001', open: true });
  return { service, guild, sent, form: service.form(G, form.id), setPublic: (v) => { publicReview = v; } };
}

test('candidatures : au plus un ping du rôle par formulaire toutes les 10 minutes (la carte part quand même)', async () => {
  const { service, guild, sent, form } = applicationWorld();
  const users = ['500000000000000011', '500000000000000012', '500000000000000013'];
  await service.submit(guild, { id: users[0] }, form, ['Motivé']);
  await service.submit(guild, { id: users[1] }, form, ['Motivée']);
  assert.equal(sent.length, 2, 'les deux cartes sont publiées');
  assert.equal(sent[0].content, '<@&600000000000000001>');
  assert.deepEqual(sent[0].allowedMentions.roles, ['600000000000000001']);
  assert.equal(sent[1].content, undefined, 'second ping en moins de 10 minutes');
  assert.deepEqual(sent[1].allowedMentions, { parse: [] });
  service.lastPings.set(form.id, Date.now() - PING_GAP_MS - 1);
  await service.submit(guild, { id: users[2] }, form, ['Partant']);
  assert.equal(sent[2].content, '<@&600000000000000001>', 'ping de nouveau permis après 10 minutes');
});

test('candidatures : décider de sa propre candidature refusé ; salon de réception public signalé', () => {
  const { service, guild, form, setPublic } = applicationWorld();
  assert.throws(() => service.assertNotApplicant({ user_id: MOD }, MOD), (e) => e instanceof UserError && /propre candidature/.test(e.message));
  assert.doesNotThrow(() => service.assertNotApplicant({ user_id: U }, MOD));
  assert.equal(service.reviewWarning(guild, form), null);
  setPublic(true);
  assert.match(service.reviewWarning(guild, form), /visible par @everyone/);
});

// ---------------------------------------------------------------- emoji, modstats

test('emoji : délai écoulé pendant la lecture de l\'image → erreur explicite (UserError)', async () => {
  const fetchImpl = async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      signal.addEventListener('abort', () => controller.error(signal.reason));
    },
  }), { status: 200 });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(
      emoji.downloadEmojiImage('https://cdn.discordapp.com/emojis/123456789012345678.png', { fetchImpl, timeoutMs: 30 }),
      (e) => e instanceof UserError && /trop long/.test(e.message),
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('/modstats : les tickets FERMÉS pris en charge comptent (instantanés de ticket_ratings)', () => {
  const raw = db();
  const ratings = new TicketRatingRepository(raw);
  const tickets = new TicketRepository(raw);
  const now = Date.now();
  ratings.recordClosure({ ticketId: 1, guildId: G, userId: U, claimedBy: MOD, openedAt: now - HOUR, claimedAt: now - HOUR / 2, closedAt: now - 60_000 });
  ratings.recordClosure({ ticketId: 2, guildId: G, userId: U, claimedBy: null, openedAt: now - HOUR, closedAt: now - 60_000 });
  ratings.recordClosure({ ticketId: 3, guildId: '100000000000000002', userId: U, claimedBy: MOD, openedAt: now - HOUR, claimedAt: now - HOUR, closedAt: now });
  assert.deepEqual(ratings.claimedStats(G, { since: now - 2 * HOUR }), [{ claimed_by: MOD, n: 1 }]);
  const client = { user: { id: 'bot' }, repositories: { sanctions: new SanctionRepository(raw), tickets, ticketRatings: ratings } };
  const view = modstats.statsView(client, { id: G }, { days: 7, now });
  const field = view.embeds[0].toJSON().fields.find((f) => /Tickets pris en charge/.test(f.name));
  assert.match(field.value, /^\*\*1\*\*/, field.value);
});
