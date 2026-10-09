'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, PermissionFlagsBits } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ActivityRepository } = require('../src/database/repositories/ActivityRepository');
const { ActivityService, retentionDays, isIgnoredChannel, toBatch } = require('../src/services/ActivityService');
const { SchedulerService } = require('../src/services/SchedulerService');
const A = require('../src/utils/activity');
const statistiques = require('../src/commands/information/statistiques');
const activite = require('../src/commands/moderation/activite');
const { defaultGuildConfig } = require('../src/config/defaults');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');

const GUILD = '100000000000000001';
const CH = { general: '400000000000000001', rules: '400000000000000002', staff: '400000000000000003', cat: '400000000000000004', voice: '400000000000000005', afk: '400000000000000006', thread: '400000000000000007' };
const U = { a: '500000000000000001', b: '500000000000000002', c: '500000000000000003', bot: '500000000000000009' };
const DAY = A.DAY_MS;
const NOON = Date.parse('2026-10-09T12:00:00Z');

// ---------------------------------------------------------------- fabriques

function setup({ clock = NOON } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new ActivityRepository(db);
  const time = { now: clock };
  const guild = fakeGuild();
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) } };
  const service = new ActivityService({ client, activity: repo, config, clock: () => time.now });
  client.services = { config, activity: service };
  client.repositories = { activity: repo };
  return { db, config, repo, service, time, guild, client };
}

function fakeChannel(id, { parentId = null, thread = false, type = ChannelType.GuildText } = {}) {
  return { id, parentId, type, isThread: () => thread, toString: () => `<#${id}>` };
}

function fakeGuild() {
  const guild = {
    id: GUILD,
    name: 'Serveur test',
    ownerId: U.c,
    memberCount: 3,
    afkChannelId: CH.afk,
    channels: { cache: new Collection() },
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    voiceStates: { cache: new Collection() },
    iconURL: () => null,
  };
  guild.members.fetch = async () => guild.members.cache;
  const general = fakeChannel(CH.general, { parentId: CH.cat });
  const thread = { ...fakeChannel(CH.thread, { parentId: CH.general, thread: true }), parent: general };
  for (const ch of [general, fakeChannel(CH.rules), fakeChannel(CH.staff, { parentId: CH.cat }), thread]) guild.channels.cache.set(ch.id, ch);
  return guild;
}

function message(guild, { author = U.a, channel = CH.general, bot = false, at = NOON, webhookId = null, system = false } = {}) {
  return {
    guild,
    author: { id: author, bot },
    channel: guild?.channels.cache.get(channel) ?? fakeChannel(channel),
    channelId: channel,
    createdTimestamp: at,
    webhookId,
    system,
  };
}

function member(guild, id, { bot = false, joinedDaysAgo = 100, roles = [], now = NOON } = {}) {
  const set = new Set(roles);
  return {
    id,
    guild,
    user: { id, bot, username: `u${id.slice(-2)}` },
    joinedTimestamp: now - joinedDaysAgo * DAY,
    roles: { cache: { has: (r) => set.has(r), some: (fn) => [...set].some((r) => fn({ id: r })) }, highest: { position: 1 } },
    toString: () => `<@${id}>`,
  };
}

function voiceState(guild, m, channelId) {
  return { guild, member: m, channelId, channel: channelId ? fakeChannel(channelId, { type: ChannelType.GuildVoice }) : null };
}

/** Données (JSON) d'une réponse, et contrôle des limites Discord. */
function checkPayload(payload, label) {
  const embeds = payload.embeds.map((e) => (e.toJSON ? e.toJSON() : e));
  const total = embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0)
    + (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
  assert.ok(total <= 6000, `${label} : ${total} caractères`);
  for (const e of embeds) {
    assert.ok((e.description?.length ?? 0) <= 4096, `${label} : description trop longue`);
    for (const f of e.fields ?? []) assert.ok(f.value.length <= 1024, `${label} : champ ${f.name} trop long`);
  }
  const rows = (payload.components ?? []).map((r) => (r.toJSON ? r.toJSON() : r));
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const ids = rows.flatMap((r) => r.components.map((c) => c.custom_id)).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, `${label} : customId en double ${ids}`);
  for (const id of ids) assert.ok(id.length <= 100, `${label} : customId trop long ${id}`);
  for (const r of rows) for (const c of r.components) if (c.options) assert.ok(c.options.length <= 25);
  return { embeds, rows, ids, text: embeds.map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name} ${f.value}`), e.footer?.text].join('\n')).join('\n') };
}

// ---------------------------------------------------------------- outils purs

test('jours UTC, séries alignées, sparkline et histogramme', () => {
  assert.equal(A.dayKey(Date.parse('2026-10-09T23:59:59Z')), '2026-10-09');
  assert.equal(A.addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(A.lastDays(3, NOON), ['2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual(A.fillSeries([{ day: '2026-10-08', messages: 4 }], A.lastDays(3, NOON)), [0, 4, 0]);
  assert.equal(A.sparkline([0, 0, 0]), '▁▁▁');
  assert.equal(A.sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  assert.equal(A.sparkline([10, 5, 0]).length, 3);
  assert.equal(A.sparkline([]), '');
  assert.match(A.sparkline([3, 100]), /^▁█$/);
  const lines = A.hourHistogram(Array.from({ length: 24 }, (_, h) => (h === 14 ? 40 : h)));
  assert.equal(lines.length, 24);
  assert.match(lines[14], /^14 h │█+.*40$/);
  assert.match(lines[0], /^00 h │\s+·$/);
  assert.equal(new Set(lines.map((l) => l.indexOf('│'))).size, 1, 'colonnes alignées');
  assert.equal(A.formatVoice(0), '0 min');
  assert.equal(A.formatVoice(30), '< 1 min');
  assert.equal(A.formatVoice(3600 * 3 + 5 * 60), '3 h 05 min');
  assert.equal(A.signed(3), '+3');
  assert.equal(A.signed(-2), '−2');
  assert.equal(A.perDay(1, 3), '0,3');
  assert.equal(A.formatDay('2026-10-09'), '09/10/2026');
});

test('croissance reconstruite à rebours depuis le total actuel', () => {
  // Jours J-2, J-1, J : +3/-1, +0/-2, +1/-0 ; 50 membres aujourd'hui.
  const flows = [{ joins: 3, leaves: 1 }, { joins: 0, leaves: 2 }, { joins: 1, leaves: 0 }];
  assert.deepEqual(A.reconstructMembers(50, flows), [51, 49, 50]);
  assert.deepEqual(A.reconstructMembers(0, [{ joins: 5, leaves: 0 }]), [0]);
});

test('migration 19 : tables des statistiques créées (id unique)', () => {
  const m = migrations.filter((x) => x.id === 19);
  assert.equal(m.length, 1);
  assert.equal(m[0].name, 'server_stats');
  const { db } = memoryDb();
  for (const table of ['activity_daily', 'activity_hourly', 'member_flow_daily', 'stats_guilds', 'inactivity_dms']) {
    assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table), `table ${table} absente`);
  }
  // Jamais de colonne de contenu.
  const cols = db.prepare('PRAGMA table_info(activity_daily)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['channel_id', 'day', 'guild_id', 'messages', 'user_id', 'voice_seconds']);
});

test('configuration par défaut : collecte active, lecture réservée, 90 jours ; événement de log catalogué', () => {
  assert.equal(defaultGuildConfig.stats.enabled, true);
  assert.equal(defaultGuildConfig.stats.public, false);
  assert.equal(defaultGuildConfig.stats.retentionDays, 90);
  assert.equal(EVENT_CATEGORY.inactivity, 'moderation');
  assert.equal(retentionDays({}), 90);
  assert.equal(retentionDays({ retentionDays: 1 }), 7);
  assert.equal(retentionDays({ retentionDays: 9999 }), 365);
  assert.equal(retentionDays({ retentionDays: 'abc' }), 90);
});

// ---------------------------------------------------------------- dépôt

test('dépôt : lots cumulés, totaux, classements, rang, dernière activité, purge, MP, effacement', () => {
  const { repo } = setup();
  const batch = {
    messages: [
      { guildId: GUILD, day: '2026-10-09', channelId: CH.general, userId: U.a, count: 3 },
      { guildId: GUILD, day: '2026-10-08', channelId: CH.rules, userId: U.b, count: 5 },
      { guildId: GUILD, day: '2026-06-01', channelId: CH.rules, userId: U.c, count: 1 },
    ],
    voice: [{ guildId: GUILD, day: '2026-10-09', channelId: CH.voice, userId: U.a, seconds: 120 }],
    hours: [{ guildId: GUILD, day: '2026-10-09', hour: 14, count: 3 }],
    flows: [{ guildId: GUILD, day: '2026-10-09', joins: 2, leaves: 1 }],
  };
  repo.applyBatch(batch);
  repo.applyBatch({ messages: [batch.messages[0]], flows: [batch.flows[0]], hours: [batch.hours[0]] });
  const totals = repo.totals(GUILD, '2026-10-01');
  assert.equal(totals.messages, 11);
  assert.equal(totals.voice, 120);
  assert.equal(totals.members, 2);
  assert.deepEqual(repo.topChannels(GUILD, '2026-10-01').map((c) => [c.channel_id, c.messages]), [[CH.general, 6], [CH.rules, 5]]);
  assert.deepEqual(repo.topVoiceChannels(GUILD, '2026-10-01').map((c) => [c.channel_id, c.voice]), [[CH.voice, 120]]);
  assert.deepEqual(repo.topMembers(GUILD, '2026-10-01').map((m) => m.user_id), [U.a, U.b]);
  assert.equal(repo.rank(GUILD, '2026-10-01', 5), 2);
  assert.deepEqual(repo.hourly(GUILD, '2026-10-01'), [{ hour: 14, messages: 6 }]);
  assert.deepEqual(repo.flows(GUILD, '2026-10-01'), [{ day: '2026-10-09', joins: 4, leaves: 2 }]);
  assert.equal(repo.lastActive(GUILD).get(U.c), '2026-06-01');
  assert.equal(repo.memberLastDay(GUILD, U.a), '2026-10-09');
  assert.deepEqual(repo.guilds(), [GUILD]);

  // Purge : seules les lignes antérieures au jour limite disparaissent.
  assert.equal(repo.purgeBefore(GUILD, '2026-07-01'), 1);
  assert.equal(repo.lastActive(GUILD).has(U.c), false);

  // MP : une fois par semaine au plus.
  assert.equal(repo.claimDm(GUILD, U.a, NOON, NOON - 7 * DAY), true);
  assert.equal(repo.claimDm(GUILD, U.a, NOON + DAY, NOON + DAY - 7 * DAY), false);
  assert.equal(repo.claimDm(GUILD, U.a, NOON + 8 * DAY, NOON + DAY), true);
  assert.deepEqual([...repo.recentDms(GUILD, NOON)], [U.a]);

  repo.setSince(GUILD, NOON);
  assert.ok(repo.wipe(GUILD) > 0);
  assert.equal(repo.getSince(GUILD), null);
  assert.equal(repo.totals(GUILD, '2000-01-01').messages, 0);
});

// ---------------------------------------------------------------- collecte

test('messages : bots, webhooks, système, MP et salons ignorés exclus ; fil compté pour son salon ; rien en base avant le vidage', () => {
  const { service, repo, config, guild } = setup();
  config.update(GUILD, { logs: { ignoredChannels: [CH.staff, CH.cat] } });
  assert.equal(service.recordMessage(message(guild, { author: U.a, channel: CH.rules })), true);
  assert.equal(service.recordMessage(message(guild, { author: U.a, channel: CH.rules, at: NOON + 60_000 })), true);
  assert.equal(service.recordMessage(message(guild, { author: U.b, channel: CH.thread })), false, 'fil d\'un salon d\'une catégorie ignorée');
  config.update(GUILD, { logs: { ignoredChannels: [CH.staff] } });
  assert.equal(service.recordMessage(message(guild, { author: U.b, channel: CH.thread })), true);
  assert.equal(service.recordMessage(message(guild, { author: U.bot, bot: true })), false);
  assert.equal(service.recordMessage(message(guild, { webhookId: '1' })), false);
  assert.equal(service.recordMessage(message(guild, { system: true })), false);
  assert.equal(service.recordMessage(message(guild, { channel: CH.staff })), false);
  assert.equal(service.recordMessage({ ...message(guild), guild: null }), false);

  // Écriture par lots : rien en base tant que le tampon n'est pas vidé.
  assert.equal(repo.totals(GUILD, '2000-01-01').messages, 0);
  assert.ok(repo.getSince(GUILD), 'début de collecte enregistré au premier message');
  assert.equal(service.flush(), 3); // 2 lignes (salon, membre) + 1 heure
  const rows = repo.topChannels(GUILD, '2026-10-09');
  assert.deepEqual(rows.map((r) => [r.channel_id, r.messages]), [[CH.rules, 2], [CH.general, 1]]);
  assert.deepEqual(repo.hourly(GUILD, '2026-10-09'), [{ hour: 12, messages: 3 }]);
  assert.equal(service.flush(), 0, 'tampon vide');

  // Collecte coupée : rien n'est compté.
  config.update(GUILD, { stats: { enabled: false } });
  assert.equal(service.recordMessage(message(guild)), false);
});

test('vocal : temps crédité par jour UTC (minuit), muet = même session, AFK et bots exclus, déplacement crédité', () => {
  const { service, repo, time, guild } = setup({ clock: Date.parse('2026-10-08T23:50:00Z') });
  const a = member(guild, U.a);
  const bot = member(guild, U.bot, { bot: true });
  service.trackVoice(voiceState(guild, a, null), voiceState(guild, a, CH.voice));
  service.trackVoice(voiceState(guild, bot, null), voiceState(guild, bot, CH.voice));
  assert.equal(service.sessions.size, 1, 'bot ignoré');
  time.now += 5 * 60_000;
  // Muet : même salon, même session.
  service.trackVoice(voiceState(guild, a, CH.voice), voiceState(guild, a, CH.voice));
  time.now += 15 * 60_000; // 00:10 le lendemain
  // Passage dans le salon AFK : session close, rien de plus compté.
  service.trackVoice(voiceState(guild, a, CH.voice), voiceState(guild, a, CH.afk));
  assert.equal(service.sessions.size, 0);
  time.now += 60 * 60_000;
  service.trackVoice(voiceState(guild, a, CH.afk), voiceState(guild, a, null));
  service.flush();
  const daily = repo.memberDaily(GUILD, U.a, '2026-10-01');
  assert.deepEqual(daily.map((d) => [d.day, d.voice]), [['2026-10-08', 600], ['2026-10-09', 600]]);
});

test('vocal : session en cours créditée à chaque vidage, close si le membre n\'est plus dans le salon', () => {
  const { service, repo, time, guild } = setup();
  const a = member(guild, U.a);
  guild.voiceStates.cache.set(U.a, { id: U.a, channelId: CH.voice, member: a });
  service.trackVoice(voiceState(guild, a, null), voiceState(guild, a, CH.voice));
  time.now += 90_000;
  service.flush();
  assert.equal(repo.totals(GUILD, '2026-10-09').voice, 90);
  time.now += 30_000;
  guild.voiceStates.cache.delete(U.a); // événement de départ manqué
  service.flush();
  assert.equal(repo.totals(GUILD, '2026-10-09').voice, 120);
  assert.equal(service.sessions.size, 0);
});

test('arrivées et départs (bots ignorés) ; arrêt : tampon écrit, événements suivants ignorés', async () => {
  const { service, repo, guild } = setup();
  assert.equal(service.recordFlow(member(guild, U.a), 'join'), true);
  assert.equal(service.recordFlow(member(guild, U.b), 'join'), true);
  assert.equal(service.recordFlow(member(guild, U.a), 'leave'), true);
  assert.equal(service.recordFlow(member(guild, U.bot, { bot: true }), 'join'), false);
  service.recordMessage(message(guild));
  service.start();
  assert.ok(service.timer);
  await service.stop();
  assert.equal(service.timer, null);
  assert.deepEqual(repo.flows(GUILD, '2026-10-01'), [{ day: '2026-10-09', joins: 2, leaves: 1 }]);
  assert.equal(repo.totals(GUILD, '2026-10-01').messages, 1, 'tampon écrit à l\'arrêt');
  assert.equal(service.recordMessage(message(guild)), false);
});

test('purge quotidienne selon la rétention de chaque serveur, une fois par jour, interrompue à l\'arrêt', async () => {
  const { service, repo, config } = setup();
  const other = '100000000000000002';
  repo.applyBatch({ messages: [
    { guildId: GUILD, day: '2026-01-01', channelId: CH.general, userId: U.a, count: 1 },
    { guildId: GUILD, day: '2026-10-01', channelId: CH.general, userId: U.a, count: 1 },
    { guildId: other, day: '2026-09-01', channelId: CH.general, userId: U.a, count: 1 },
  ] });
  config.update(other, { stats: { retentionDays: 30 } });
  assert.equal(await service.processDue({ isStopping: () => true }), 0);
  service.lastPurgeAt = 0;
  assert.equal(await service.processDue(), 2);
  assert.equal(repo.totals(GUILD, '2000-01-01').messages, 1);
  assert.equal(repo.totals(other, '2000-01-01').messages, 0);
  // Une fois par jour.
  repo.applyBatch({ messages: [{ guildId: GUILD, day: '2026-01-02', channelId: CH.general, userId: U.a, count: 1 }] });
  assert.equal(await service.processDue(), 0);
});

test('scheduler : étape « activity » isolée, reçoit isStopping', async () => {
  const calls = [];
  const client = {
    guilds: { cache: new Map() },
    repositories: {},
    isReady: () => false,
    services: { activity: { processDue: async (opts) => calls.push(opts) } },
  };
  const scheduler = new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } });
  await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].isStopping, 'function');
  assert.equal(calls[0].isStopping(), false);
});

test('inactifs : arrivés depuis plus de N jours, sans activité récente, hors bots, rôles exclus et membres en vocal', async () => {
  const { service, repo, config, guild, time } = setup();
  const STAFF = '300000000000000001';
  const add = (m) => guild.members.cache.set(m.id, m);
  add(member(guild, U.a, { joinedDaysAgo: 100 })); // actif hier
  add(member(guild, U.b, { joinedDaysAgo: 100 })); // actif il y a 40 jours → inactif
  add(member(guild, U.c, { joinedDaysAgo: 100 })); // jamais actif → inactif (en premier)
  add(member(guild, '500000000000000004', { joinedDaysAgo: 10 })); // arrivé récemment
  add(member(guild, '500000000000000005', { joinedDaysAgo: 100, roles: [STAFF] })); // staff exclu
  add(member(guild, U.bot, { joinedDaysAgo: 100, bot: true }));
  add(member(guild, '500000000000000006', { joinedDaysAgo: 100 })); // en vocal en ce moment
  service.sessions.set(`${GUILD}:500000000000000006`, { guildId: GUILD, userId: '500000000000000006', channelId: CH.voice, since: time.now });
  guild.voiceStates.cache.set('500000000000000006', { id: '500000000000000006', channelId: CH.voice });
  guild.memberCount = guild.members.cache.size;
  repo.applyBatch({ messages: [
    { guildId: GUILD, day: A.addDays(A.dayKey(NOON), -1), channelId: CH.general, userId: U.a, count: 1 },
    { guildId: GUILD, day: A.addDays(A.dayKey(NOON), -40), channelId: CH.general, userId: U.b, count: 1 },
  ] });
  config.update(GUILD, { stats: { inactivity: { excludedRoles: [STAFF] } } });
  const { list, partial } = await service.inactiveMembers(guild, 30);
  assert.equal(partial, false);
  assert.deepEqual(list.map((e) => e.member.id), [U.c, U.b]);
  assert.equal(list[1].lastDay, A.addDays(A.dayKey(NOON), -40));

  // Collecte trop récente : actions refusées, avec une explication.
  repo.setSince(GUILD, NOON - 10 * DAY);
  assert.equal(service.canAct(GUILD, 30), false);
  assert.equal(service.canAct(GUILD, 7), true);
  const client = { services: { activity: service } };
  assert.match(activite.blockedReason(client, GUILD, 30, NOON), /depuis \*\*10 jour\(s\)\*\* seulement/);
  assert.equal(activite.blockedReason(client, GUILD, 7, NOON), null);
  // Collecte coupée : plus de début de collecte ; réactivée : le décompte repart.
  service.setCollecting(GUILD, false);
  assert.equal(service.since(GUILD), null);
  assert.match(activite.blockedReason(client, GUILD, 7, NOON), /désactivée/);
  service.setCollecting(GUILD, true);
  assert.equal(service.since(GUILD), NOON);
  assert.equal(service.canAct(GUILD, 7), false);
});

test('toBatch et salons ignorés (salon, parent, catégorie du parent)', () => {
  const buffer = { messages: new Map([[`${GUILD}|2026-10-09|${CH.general}|${U.a}`, 2]]), voice: new Map(), hours: new Map([[`${GUILD}|2026-10-09|7`, 2]]), flows: new Map() };
  assert.deepEqual(toBatch(buffer).hours, [{ guildId: GUILD, day: '2026-10-09', hour: 7, count: 2 }]);
  assert.ok(isIgnoredChannel({ id: 'x', parentId: 'p', parent: { parentId: 'cat' } }, ['cat']));
  assert.ok(!isIgnoredChannel({ id: 'x' }, []));
});

// ---------------------------------------------------------------- rendus

function seed(repo) {
  const days = A.lastDays(90, NOON);
  const messages = [];
  const hours = [];
  const flows = [];
  days.forEach((day, i) => {
    for (let u = 0; u < 12; u += 1) messages.push({ guildId: GUILD, day, channelId: `4000000000000001${String(u).padStart(2, '0')}`, userId: `5000000000000001${String(u).padStart(2, '0')}`, count: (i * u) % 17 + 1 });
    hours.push({ guildId: GUILD, day, hour: i % 24, count: i + 1 });
    flows.push({ guildId: GUILD, day, joins: i % 4, leaves: i % 3 });
  });
  repo.applyBatch({ messages, hours, flows, voice: [{ guildId: GUILD, day: days[89], channelId: CH.voice, userId: U.a, seconds: 7200 }] });
  repo.setSince(GUILD, NOON - 120 * DAY);
}

test('/statistiques : chaque vue et chaque période dans les limites ; réglages réservés ; période relue sur le message', () => {
  const { repo, client, guild } = setup();
  guild.memberCount = 1234;
  seed(repo);
  for (const view of ['serveur', 'salons', 'membres', 'heures', 'croissance', 'reglages', 'wipe']) {
    for (const period of [7, 30, 90]) {
      const { text, ids } = checkPayload(statistiques.render(client, guild, { view, period, manager: true, now: NOON }), `${view}/${period}`);
      assert.ok(!/undefined|NaN|null/.test(text), `${view} : texte suspect`);
      if (!['reglages', 'wipe'].includes(view)) {
        assert.ok(ids.includes('cmd:statistiques:nav'));
        assert.match(text, new RegExp(`Période : ${period} jours`));
      }
    }
  }
  const server = checkPayload(statistiques.render(client, guild, { view: 'serveur', period: 90, manager: false, now: NOON }), 'serveur');
  assert.match(server.text, /\*\*7 j\*\* `[▁▂▃▄▅▆▇█]{7}`/);
  assert.match(server.text, /\*\*30 j\*\* `[▁▂▃▄▅▆▇█]{30}`/);
  assert.match(server.text, /\*\*90 j\*\* `[▁▂▃▄▅▆▇█]{90}`/);
  const nav = server.rows[0].components[0];
  assert.ok(!nav.options.some((o) => o.value === 'reglages'), 'réglages proposés sans « Gérer le serveur »');
  const hours = checkPayload(statistiques.render(client, guild, { view: 'heures', period: 30, now: NOON }), 'heures');
  assert.match(hours.text, /```\n00 h │/);
  const growth = checkPayload(statistiques.render(client, guild, { view: 'croissance', period: 30, now: NOON }), 'croissance');
  assert.match(growth.text, /1\s234/);

  // Période relue : le bouton de période désactivé du message.
  const payload = statistiques.render(client, guild, { view: 'salons', period: 7, now: NOON });
  const message = { components: payload.components.map((r) => r.toJSON()).map((r) => ({ components: r.components.map((c) => ({ customId: c.custom_id, disabled: c.disabled })) })) };
  assert.equal(statistiques.periodOfMessage(message), 7);
  assert.equal(statistiques.periodOfMessage({ components: [] }), 30);
});

test('/statistiques membre : messages par jour, salons favoris, rang, vocal', () => {
  const { repo, client, guild } = setup();
  seed(repo);
  const user = { id: U.a, username: 'alice', toString: () => `<@${U.a}>`, displayAvatarURL: () => null };
  const { text, ids } = checkPayload(statistiques.renderMember(client, guild, user, null, { period: 30, now: NOON, canSeeServer: true }), 'membre');
  assert.match(text, /Messages par jour/);
  assert.match(text, /Salons favoris/);
  assert.match(text, /2 h 00 min/);
  assert.ok(ids.includes(`cmd:statistiques:member:${U.a}:30:r`));
  assert.ok(ids.includes('cmd:statistiques:go:serveur:30'));
  const hidden = checkPayload(statistiques.renderMember(client, guild, user, null, { period: 7, now: NOON }), 'membre privé');
  assert.ok(!hidden.ids.some((id) => id.startsWith('cmd:statistiques:go:')), 'bouton « Serveur » sans droit de lecture');
});

test('/activite : modèle de MP, mentions neutralisées en embed, permissions de la commande', () => {
  const text = activite.renderDm('Salut {membre} ({pseudo}) de {serveur}, {jours} jours !', { member: '<@1>', name: 'Bob', server: 'S', days: 30 });
  assert.equal(text, 'Salut <@1> (Bob) de S, 30 jours !');
  assert.match(activite.renderDm(null, { member: 'x', name: 'y', server: 'Z', days: 7 }), /Z/);
  const json = activite.data.toJSON();
  assert.equal(BigInt(json.default_member_permissions), PermissionFlagsBits.ManageGuild);
  assert.equal(activite.LIMITS.kick, 50);
  assert.equal(statistiques.data.toJSON().default_member_permissions ?? null, null, '/statistiques : ouverte (stats.public), contrôlée par le bot');
});
