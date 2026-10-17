'use strict';

/**
 * Revue n° 6, lot « serveur » (tests unitaires) : rôles temporaires, /activite, /statistiques,
 * vocaux temporaires, /emoji, automatisations, boutique, flux RSS, /jeu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { TempRoleRepository } = require('../src/database/repositories/TempRoleRepository');
const { TempRoleService } = require('../src/services/TempRoleService');
const { GUILD, ROLE, USER, fakeMember, fakeGuild, fakeClient } = require('./scheduled.helper');

const HOUR = 3_600_000;

/* ------------------------------------------------------------------ */
/* R90 : renouvellement / prolongation pendant l'expiration             */
/* ------------------------------------------------------------------ */

function tempRoleSetup() {
  const guild = fakeGuild();
  const client = fakeClient(guild);
  const repo = new TempRoleRepository(client.db);
  client.repositories = { tempRoles: repo };
  const service = new TempRoleService({ client, tempRoles: repo });
  client.services.tempRoles = service;
  const member = fakeMember(guild, USER.a);
  guild.members.cache.set(member.id, member);
  return { guild, client, repo, service, member, mod: { id: USER.mod, tag: 'modo', toString: () => `<@${USER.mod}>` } };
}

for (const [mode, when] of [['grant', 'before'], ['extend', 'before'], ['grant', 'after'], ['extend', 'after']]) {
  test(`R90 : ${mode} ${when === 'before' ? 'pendant' : 'juste après'} le retrait du rôle échu : le renouvellement l'emporte`, async () => {
    const { guild, client, repo, service, member, mod } = tempRoleSetup();
    const role = guild.roles.cache.get(ROLE.safe);
    const { id } = await service.grant({ guild, member, role, durationMs: HOUR, moderator: mod });
    client.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
    const realRemove = member.roles.remove;
    let hooked = false;
    member.roles.remove = async (rid) => {
      member.roles.remove = realRemove;
      hooked = true;
      const act = () => (mode === 'grant'
        ? service.grant({ guild, member, role, durationMs: 7 * 24 * HOUR, moderator: mod })
        : service.extend(guild, id, 7 * 24 * HOUR, mod));
      if (when === 'before') {
        await act();
        return realRemove(rid);
      }
      await realRemove(rid);
      return act();
    };
    await service.processDue();
    assert.ok(hooked);
    const row = repo.get(GUILD, id);
    assert.equal(row.active, 1, 'la ligne renouvelée a été close par le scheduler');
    assert.ok(row.expires_at > Date.now() + HOUR);
    assert.ok(member.roles.cache.has(ROLE.safe), 'le rôle renouvelé a été retiré');
    assert.equal(client.logs.filter((l) => /expiré/.test(l.embed.title ?? '')).length, 0, 'expiration journalisée à tort');
  });
}

test('R90 : expiration normale inchangée (ligne close, rôle retiré, log)', async () => {
  const { guild, client, repo, service, member, mod } = tempRoleSetup();
  const role = guild.roles.cache.get(ROLE.safe);
  const { id } = await service.grant({ guild, member, role, durationMs: HOUR, moderator: mod });
  client.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  await service.processDue();
  const row = repo.get(GUILD, id);
  assert.equal(row.active, 0);
  assert.equal(row.end_reason, 'expired');
  assert.equal(member.roles.cache.has(ROLE.safe), false);
});

/* ------------------------------------------------------------------ */
/* R91 : activité dans un salon ignoré des logs                         */
/* ------------------------------------------------------------------ */

const { Collection, ChannelType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ActivityRepository } = require('../src/database/repositories/ActivityRepository');
const { ActivityService } = require('../src/services/ActivityService');

const DAY = 86_400_000;

function activitySetup() {
  const G = '100000000000000001';
  const SPAM = '400000000000000009';
  const VOC = '400000000000000010';
  const U = '500000000000000001';
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new ActivityRepository(db);
  const time = { now: Date.parse('2026-10-01T12:00:00Z') };
  const spam = { id: SPAM, parentId: null, type: ChannelType.GuildText, isThread: () => false };
  const voc = { id: VOC, parentId: null, type: ChannelType.GuildVoice, isThread: () => false };
  const member = { id: U, user: { id: U, bot: false }, joinedTimestamp: time.now - 400 * DAY, roles: { cache: new Collection() } };
  const guild = { id: G, memberCount: 1, channels: { cache: new Collection([[SPAM, spam], [VOC, voc]]) }, members: { cache: new Collection([[U, member]]) }, voiceStates: { cache: new Collection() } };
  const client = { guilds: { cache: new Collection([[G, guild]]) }, isReady: () => true };
  const service = new ActivityService({ client, activity: repo, config, clock: () => time.now });
  config.update(G, { logs: { ignoredChannels: [SPAM, VOC] } });
  repo.setSince(G, time.now - 60 * DAY);
  return { G, SPAM, VOC, U, repo, service, time, spam, voc, member, guild };
}

test('R91 : un membre qui n\'écrit que dans un salon ignoré des logs n\'est pas listé inactif, et reste hors statistiques', async () => {
  const { G, SPAM, U, repo, service, time, spam, member, guild } = activitySetup();
  for (let d = 0; d < 40; d += 1) {
    time.now += DAY;
    assert.equal(service.recordMessage({ guild, author: member.user, channel: spam, channelId: SPAM, createdTimestamp: time.now }), false, 'compté dans les statistiques');
  }
  const { list } = await service.inactiveMembers(guild, 30, time.now);
  assert.equal(list.some((e) => e.member.id === U), false, 'membre actif listé inactif (expulsable)');
  // Statistiques inchangées : aucune trace affichée.
  const totals = repo.totals(G, '2000-01-01');
  assert.equal(totals.messages, 0);
  assert.equal(totals.members, 0);
  assert.deepEqual(repo.topMembers(G, '2000-01-01'), []);
  assert.deepEqual(repo.memberChannels(G, U, '2000-01-01'), []);
  assert.equal(repo.memberLastDay(G, U), null);
  assert.deepEqual(repo.hourly(G, '2000-01-01'), []);
});

test('R91 : présence dans un vocal ignoré des logs retenue comme activité (hors statistiques)', async () => {
  const { G, VOC, U, repo, service, time, voc, member, guild } = activitySetup();
  time.now += 40 * DAY;
  service.trackVoice({ member, guild, channelId: null }, { member, guild, channelId: VOC, channel: voc });
  const { list } = await service.inactiveMembers(guild, 30, time.now);
  assert.equal(list.some((e) => e.member.id === U), false);
  assert.equal(repo.totals(G, '2000-01-01').voice, 0);
});

/* ------------------------------------------------------------------ */
/* R111 : suppression massive des statistiques par lots                 */
/* ------------------------------------------------------------------ */

function bigActivity(rows) {
  const ctx = activitySetup();
  const ins = ctx.repo.db.prepare('INSERT INTO activity_daily (guild_id, day, channel_id, user_id, messages, voice_seconds) VALUES (?, ?, ?, ?, 3, 0)');
  ctx.repo.db.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      const day = new Date(Date.parse('2025-10-17T00:00:00Z') + (i % 365) * DAY).toISOString().slice(0, 10);
      ins.run(ctx.G, day, `4000000000000${String(i % 7).padStart(5, '0')}`, `5${String(i).padStart(17, '0')}`);
    }
  })();
  return ctx;
}

/** Compte les tours de boucle d'événements pendant `fn` (0 : bloc synchrone). */
async function yieldsDuring(fn) {
  let yielded = 0;
  let done = false;
  const spin = () => {
    if (done) return;
    yielded += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  const result = await fn();
  done = true;
  return { yielded, result };
}

test('R111 : « Tout effacer » supprime par lots en rendant la main à la boucle d\'événements', async () => {
  const { G, repo, service } = bigActivity(3_000);
  service.deleteChunk = 200;
  const { yielded, result } = await yieldsDuring(() => service.wipe(G));
  assert.ok(yielded >= 10, `suppression d'un seul bloc (${yielded} tour(s) de boucle)`);
  assert.ok(result >= 3_000, `lignes supprimées : ${result}`);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM activity_daily WHERE guild_id = ?').get(G).n, 0);
  assert.ok(repo.getSince(G), 'la collecte (active) repart de zéro');
});

test('R111 : purge quotidienne (conservation réduite) par lots, sans figer le bot', async () => {
  const { G, repo, service, time } = bigActivity(3_000);
  service.deleteChunk = 200;
  time.now = Date.parse('2026-10-17T12:00:00Z');
  service.config.update(G, { stats: { retentionDays: 7 } });
  const { yielded, result } = await yieldsDuring(() => service.processDue({ now: time.now }));
  assert.ok(yielded >= 10, `purge d'un seul bloc (${yielded} tour(s) de boucle)`);
  assert.ok(result > 2_900, `lignes purgées : ${result}`);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM activity_daily WHERE guild_id = ? AND day < ?').get(G, '2026-10-11').n, 0);
});

/* ------------------------------------------------------------------ */
/* R92 : /statistiques publique (fils privés, heures de pointe)         */
/* ------------------------------------------------------------------ */

const { PermissionsBitField, PermissionFlagsBits: PF } = require('discord.js');
const statistiques = require('../src/commands/information/statistiques');

function privateStatsSetup() {
  const G = '100000000000000001';
  const GEN = '400000000000000001';
  const STAFF = '400000000000000003';
  const PT = '400000000000000007';
  const NOON = Date.parse('2026-10-09T12:00:00Z');
  const everyone = { id: G };
  const visible = (yes) => () => new PermissionsBitField(yes ? PF.ViewChannel : 0n);
  const general = { id: GEN, parentId: null, type: ChannelType.GuildText, isThread: () => false, permissionsFor: visible(true), toString: () => `<#${GEN}>` };
  const staff = { id: STAFF, parentId: null, type: ChannelType.GuildText, isThread: () => false, permissionsFor: visible(false), toString: () => `<#${STAFF}>` };
  const privThread = { id: PT, parentId: GEN, parent: general, type: ChannelType.PrivateThread, isThread: () => true, permissionsFor: visible(true) };
  const guild = { id: G, name: 'Test', memberCount: 2, roles: { everyone, cache: new Collection([[G, everyone]]) }, channels: { cache: new Collection([[GEN, general], [STAFF, staff], [PT, privThread]]) }, members: { cache: new Collection() }, voiceStates: { cache: new Collection() }, iconURL: () => null };
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new ActivityRepository(db);
  const client = { guilds: { cache: new Collection([[G, guild]]) }, isReady: () => true };
  const activity = new ActivityService({ client, activity: repo, config, clock: () => NOON });
  client.services = { config, activity };
  config.update(G, { stats: { public: true } });
  const msg = (author, channel, n) => {
    for (let i = 0; i < n; i += 1) activity.recordMessage({ guild, author: { id: author, bot: false }, channel, channelId: channel.id, createdTimestamp: NOON - 3_600_000 });
  };
  return { G, GEN, STAFF, PT, NOON, guild, client, repo, msg, general, staff, privThread };
}

const payloadText = (p) => p.embeds.map((e) => {
  const j = e.toJSON ? e.toJSON() : e;
  return [j.description, ...(j.fields ?? []).map((f) => `${f.name}: ${f.value}`)].join('\n');
}).join('\n');

test('R92 : un fil privé n\'est pas crédité à son salon parent public (vue publique)', () => {
  const { client, guild, msg, privThread, general, NOON, PT, repo, G } = privateStatsSetup();
  msg('500000000000000001', privThread, 40);
  msg('500000000000000002', general, 5);
  const reader = statistiques.makeReader(guild, false);
  const members = payloadText(statistiques.render(client, guild, { view: 'membres', period: 7, now: NOON, reader }));
  assert.doesNotMatch(members, /500000000000000001/, 'auteur du fil privé classé dans la vue publique');
  assert.doesNotMatch(members, /\*\*40\*\* msg/);
  // La gestion voit le fil sous son propre identifiant.
  assert.ok(repo.topChannels(G, '2000-01-01').some((c) => c.channel_id === PT));
});

test('R92 : heures de pointe de la vue publique sans les salons privés (la gestion voit tout)', () => {
  const { client, guild, msg, general, staff, privThread, NOON } = privateStatsSetup();
  msg('500000000000000002', general, 5);
  msg('500000000000000002', staff, 70);
  msg('500000000000000001', privThread, 40);
  const pub = payloadText(statistiques.render(client, guild, { view: 'heures', period: 7, now: NOON, reader: statistiques.makeReader(guild, false) }));
  assert.match(pub, /📨[^\n]*\*\*5\*\*/, `heures publiques : ${pub.match(/📨[^\n]*/)?.[0]}`);
  const all = payloadText(statistiques.render(client, guild, { view: 'heures', period: 7, now: NOON, reader: statistiques.makeReader(guild, true) }));
  assert.match(all, /📨[^\n]*\*\*115\*\*/, `heures (gestion) : ${all.match(/📨[^\n]*/)?.[0]}`);
});

/* ------------------------------------------------------------------ */
/* R95 : erreur passagère ≠ suppression définitive                      */
/* ------------------------------------------------------------------ */

const { ProjectRepository } = require('../src/database/repositories/ProjectRepository');
const { ProjectService } = require('../src/services/ProjectService');
const { TempVoiceRepository } = require('../src/database/repositories/TempVoiceRepository');
const { TempVoiceService } = require('../src/services/TempVoiceService');

const outage = async () => {
  throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
};
const unknown = (code) => async () => {
  throw Object.assign(new Error(`Unknown ${code}`), { code, status: 404 });
};

test('R95 : vocal temporaire : un 503 au démarrage ne fait pas oublier le salon ; 10003 oui', async () => {
  const G = '100000000000000001';
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const tempVoice = new TempVoiceRepository(db);
  tempVoice.create('400000000000000099', G, '500000000000000001');
  const tv = new TempVoiceService({ tempVoice, config });
  const guild = { id: G, channels: { fetch: outage } };
  const res = await tv.cleanup({ guilds: { cache: new Collection([[G, guild]]) } });
  assert.ok(tempVoice.get('400000000000000099'), 'ligne supprimée après une erreur passagère');
  assert.equal(res.dropped, 0);
  guild.channels.fetch = unknown(10003);
  const res2 = await tv.cleanup({ guilds: { cache: new Collection([[G, guild]]) } });
  assert.equal(res2.dropped, 1);
  assert.ok(!tempVoice.get('400000000000000099'));
});

test('R95 : fiche de projet : un 503 ne fait pas oublier la publication ; message inconnu (10008) oui', async () => {
  const G = '100000000000000001';
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const projects = new ProjectRepository(db);
  const client = { channels: { fetch: outage } };
  const svc = new ProjectService({ client, projects, config });
  const p = projects.create({ guildId: G, ownerId: '500000000000000001', name: 'Site' });
  projects.update(p.id, { channelId: '400000000000000001', messageId: '600000000000000001' });
  await assert.rejects(svc.refreshPublished(p.id));
  assert.equal(projects.get(p.id).messageId, '600000000000000001', 'publication oubliée après une erreur passagère');
  client.channels.fetch = async () => ({ guild: { id: G }, messages: { fetch: unknown(10008) } });
  await svc.refreshPublished(p.id);
  assert.equal(projects.get(p.id).messageId, null);
});
