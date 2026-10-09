'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const automod = require('../src/commands/automod/automod');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { AutomodEventRepository } = require('../src/database/repositories/AutomodEventRepository');

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const guild = { id: '100000000000000001', name: 'T', autoModerationRules: { fetch: async () => new Map() }, members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All) } } };
  const client = { services: { config }, repositories: { automodEvents: new AutomodEventRepository(db) }, guilds: { cache: new Map([[guild.id, guild]]) } };
  return { client, guild, config };
}

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

function assertValid(payload, label) {
  const rows = payload.components.map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, `${label} : rangée trop longue`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      ids.push(c.custom_id);
      assert.ok(c.custom_id.length <= 100);
      const [, cmd, action] = c.custom_id.split(':');
      if (cmd === 'automod') assert.equal(typeof automod.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label} : identifiants en double`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256));
  }
}

test('/automod est une commande unique, sans sous-commande', () => {
  const data = automod.data.toJSON();
  assert.equal((data.options ?? []).length, 0);
});

test('chaque vue du tableau de bord respecte les limites Discord et route vers un gestionnaire', async () => {
  const { client, guild, config } = world();
  // Listes chargées au maximum pour éprouver les limites.
  config.update(guild.id, {
    automod: {
      ignoredChannels: Array.from({ length: 40 }, (_, i) => String(200000000000000000n + BigInt(i))),
      filters: { badWords: { words: Array.from({ length: 1000 }, (_, i) => `motinterdit${i}`) } },
    },
  });
  const views = ['home', 'grp:security', 'grp:spam', 'grp:content', 'lists', 'escalation', 'newmembers', 'notify', 'native', 'presets', 'stats:1', 'stats:7', 'stats:30', 'grp.spam', 'stats.30'];
  for (const v of views) assertValid(await automod.render(client, guild, v, 'Notification de test'), v);
  for (const key of ['antiSpam', 'antiPhishing', 'badWords', 'antiZalgo', 'antiCrossChannel', 'antiWall']) {
    assertValid(await automod.render(client, guild, `filter:${key}`), `filter:${key}`);
  }
});

test('paliers des sanctions progressives : saisie validée', () => {
  assert.deepEqual(automod.parseSteps('5=timeout 1h, 3=timeout 10m\n8=kick'), [
    { count: 3, action: 'timeout', duration: '10m' },
    { count: 5, action: 'timeout', duration: '1h' },
    { count: 8, action: 'kick', duration: null },
  ]);
  for (const bad of ['', '2=ban', '1=kick', '3=timeout 99y', '3=kick, 3=timeout 1h', '2=kick,3=kick,4=kick,5=kick,6=kick,7=kick']) {
    assert.throws(() => automod.parseSteps(bad), { name: 'UserError' }, bad);
  }
});

test('tous les gestionnaires refusent sans « Gérer le serveur »', async () => {
  const { client } = world();
  const i = { memberPermissions: new PermissionsBitField(0n), guildId: '100000000000000001', values: ['home'] };
  for (const [name, handler] of Object.entries(automod.buttons)) {
    await assert.rejects(handler(i, client, ['antiSpam']), { name: 'UserError' }, name);
  }
});
