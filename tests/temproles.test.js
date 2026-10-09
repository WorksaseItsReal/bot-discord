'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const { TempRoleRepository } = require('../src/database/repositories/TempRoleRepository');
const { TempRoleService, roleIssue, MAX_LATE_MS } = require('../src/services/TempRoleService');
const tempRoleRejoin = require('../src/events/tempRoleRejoin');
const role = require('../src/commands/roles/role');
const { GUILD, ROLE, USER, apiError, fakeMember, fakeGuild, fakeClient } = require('./scheduled.helper');

const HOUR = 3_600_000;

function setup() {
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

test('migration 16 : tables des fonctionnalités planifiées', () => {
  const { client } = setup();
  const tables = client.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['temp_roles', 'scheduled_announcements', 'birthdays']) assert.ok(tables.includes(t), t);
  assert.ok(client.db.prepare('SELECT 1 FROM _migrations WHERE id = 16').get());
});

test('roleIssue : @everyone, géré, sensible et hiérarchie du bot refusés', () => {
  const guild = fakeGuild();
  assert.match(roleIssue(guild, guild.roles.cache.get(GUILD)), /@everyone/);
  assert.match(roleIssue(guild, guild.roles.cache.get(ROLE.bot)), /intégration/);
  assert.match(roleIssue(guild, guild.roles.cache.get(ROLE.mod)), /modération/);
  assert.match(roleIssue(guild, guild.roles.cache.get(ROLE.high)), /au-dessus/);
  assert.equal(roleIssue(guild, guild.roles.cache.get(ROLE.safe)), null);
  guild.members.me.permissions = new PermissionsBitField(0n);
  assert.match(roleIssue(guild, guild.roles.cache.get(ROLE.safe)), /Gérer les rôles/);
});

test('grant : ajoute le rôle, enregistre l\'échéance, renouvelle sans doublon, journalise', async () => {
  const { guild, client, repo, service, member, mod } = setup();
  const r = guild.roles.cache.get(ROLE.safe);
  const first = await service.grant({ guild, member, role: r, durationMs: HOUR, moderator: mod, reason: 'Événement' });
  assert.equal(first.renewed, false);
  assert.ok(member.roles.cache.has(ROLE.safe));
  const again = await service.grant({ guild, member, role: r, durationMs: 2 * HOUR, moderator: mod });
  assert.equal(again.renewed, true);
  assert.equal(again.id, first.id);
  assert.equal(repo.count(GUILD), 1);
  assert.equal(repo.get(GUILD, first.id).reason, 'Événement', 'la raison d\'origine est conservée');
  assert.equal(member.calls.filter(([a]) => a === 'add').length, 1, 'rôle déjà présent : pas de second ajout');
  assert.equal(client.logs.length, 2);
  assert.equal(client.logs[0].category, 'members');
  assert.equal(client.logs[0].ctx.event, 'memberRoles');
});

test('grant : rôle permanent, rôle sensible et durée hors limites refusés', async () => {
  const { guild, service, member, mod } = setup();
  const permanent = fakeMember(guild, USER.b, [ROLE.safe]);
  await assert.rejects(service.grant({ guild, member: permanent, role: guild.roles.cache.get(ROLE.safe), durationMs: HOUR, moderator: mod }), /sans échéance/);
  await assert.rejects(service.grant({ guild, member, role: guild.roles.cache.get(ROLE.mod), durationMs: HOUR, moderator: mod }), /modération/);
  await assert.rejects(service.grant({ guild, member, role: guild.roles.cache.get(ROLE.safe), durationMs: 400 * 24 * HOUR, moderator: mod }), /un an/);
  member.failNext = apiError(50013);
  await assert.rejects(service.grant({ guild, member, role: guild.roles.cache.get(ROLE.safe), durationMs: HOUR, moderator: mod }), /Impossible/);
});

test('processDue : rôle retiré à l\'échéance, ligne close et log', async () => {
  const { guild, client, repo, service, member, mod } = setup();
  const { id } = await service.grant({ guild, member, role: guild.roles.cache.get(ROLE.safe), durationMs: HOUR, moderator: mod });
  client.logs.length = 0;
  await service.processDue({ now: Date.now() });
  assert.ok(member.roles.cache.has(ROLE.safe), 'pas encore échu');
  client.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  await service.processDue();
  assert.ok(!member.roles.cache.has(ROLE.safe));
  const row = repo.get(GUILD, id);
  assert.equal(row.active, 0);
  assert.equal(row.end_reason, 'expired');
  assert.match(client.logs[0].embed.title, /expiré/);
});

test('processDue : membre parti, rôle supprimé, serveur quitté → ligne close sans appel inutile', async () => {
  const { guild, client, repo, service } = setup();
  const past = Date.now() - 1000;
  const left = repo.upsert({ guildId: GUILD, userId: USER.b, roleId: ROLE.safe, expiresAt: past }).id;
  const deleted = repo.upsert({ guildId: GUILD, userId: USER.a, roleId: '300000000000000099', expiresAt: past }).id;
  const gone = repo.upsert({ guildId: '100000000000000099', userId: USER.a, roleId: ROLE.safe, expiresAt: past }).id;
  await service.processDue();
  assert.equal(repo.get(GUILD, left).end_reason, 'left');
  assert.equal(repo.get(GUILD, deleted).end_reason, 'role_deleted');
  assert.equal(repo.byId(gone).end_reason, 'guild_left');
  assert.equal(client.logs.length, 0);
});

test('processDue : ligne relue — prolongée pendant le tick, le rôle n\'est pas retiré', async () => {
  const { guild, client, repo, service } = setup();
  const member = fakeMember(guild, USER.b, [ROLE.safe]);
  const id = repo.upsert({ guildId: GUILD, userId: USER.b, roleId: ROLE.safe, expiresAt: Date.now() - 1000 }).id;
  // Membre absent du cache : récupéré par l'API, pendant laquelle un modérateur prolonge.
  guild.members.fetch = async () => {
    client.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() + HOUR, id);
    return member;
  };
  await service.processDue();
  assert.ok(member.roles.cache.has(ROLE.safe));
  assert.equal(repo.get(GUILD, id).active, 1);
});

test('processDue : erreur transitoire → réessai ; hiérarchie insuffisante depuis 24 h → abandon signalé', async () => {
  const { guild, client, repo, service } = setup();
  const member = fakeMember(guild, USER.b, [ROLE.safe]);
  guild.members.cache.set(member.id, member);
  const id = repo.upsert({ guildId: GUILD, userId: USER.b, roleId: ROLE.safe, expiresAt: Date.now() - 1000 }).id;
  member.failNext = apiError(500);
  await service.processDue();
  assert.equal(repo.get(GUILD, id).active, 1, 'gardée pour un nouvel essai');
  guild.roles.cache.get(ROLE.safe).position = 15; // au-dessus du bot
  member.calls.length = 0;
  await service.processDue();
  assert.equal(member.calls.length, 0, 'aucun appel voué à l\'échec');
  client.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() - MAX_LATE_MS - 1000, id);
  await service.processDue();
  assert.equal(repo.get(GUILD, id).end_reason, 'failed');
  assert.match(client.logs.at(-1).embed.title, /non retiré/);
});

test('extend / removeNow : prolongation bornée à un an, retrait immédiat', async () => {
  const { guild, repo, service, member, mod } = setup();
  const { id } = await service.grant({ guild, member, role: guild.roles.cache.get(ROLE.safe), durationMs: HOUR, moderator: mod });
  const before = repo.get(GUILD, id).expires_at;
  const after = await service.extend(guild, id, 2 * HOUR, mod);
  assert.equal(after, before + 2 * HOUR);
  await assert.rejects(service.extend(guild, id, 365 * 24 * HOUR, mod), /un an/);
  await service.removeNow(guild, id, mod);
  assert.ok(!member.roles.cache.has(ROLE.safe));
  assert.equal(repo.get(GUILD, id).end_reason, 'removed');
  await assert.rejects(service.removeNow(guild, id, mod), /terminé/);
  await assert.rejects(service.extend(guild, id, HOUR, mod), /terminé/);
});

test('retour avant l\'échéance : guildMemberAdd réapplique les rôles temporaires', async () => {
  const { guild, client, repo, service } = setup();
  repo.upsert({ guildId: GUILD, userId: USER.b, roleId: ROLE.safe, expiresAt: Date.now() + HOUR });
  repo.upsert({ guildId: GUILD, userId: USER.b, roleId: ROLE.other, expiresAt: Date.now() - 1000 }); // échu : non rendu
  const back = fakeMember(guild, USER.b);
  assert.equal(tempRoleRejoin.name, 'guildMemberAdd');
  await tempRoleRejoin.execute(client, back);
  assert.ok(back.roles.cache.has(ROLE.safe));
  assert.ok(!back.roles.cache.has(ROLE.other));
  assert.match(client.logs.at(-1).embed.title, /réappliqués/);
  assert.deepEqual(await service.reapply(back), [], 'déjà rendus');
});

test('/role : sous-commandes temporaire et temporaires déclarées, boutons routés', () => {
  const json = role.data.toJSON();
  const subs = json.options.map((o) => o.name);
  assert.ok(subs.includes('temporaire') && subs.includes('temporaires'));
  const temp = json.options.find((o) => o.name === 'temporaire');
  assert.deepEqual(temp.options.map((o) => [o.name, Boolean(o.required)]), [['membre', true], ['role', true], ['duree', true], ['raison', false]]);
  for (const action of ['tlist', 'tremove', 'textend', 'textendsubmit']) assert.equal(typeof role.buttons[action], 'function', action);
});
