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
