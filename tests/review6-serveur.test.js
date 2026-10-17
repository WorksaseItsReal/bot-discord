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
