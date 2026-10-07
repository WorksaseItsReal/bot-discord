'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, ChannelType, Collection } = require('discord.js');
const logs = require('../src/commands/configuration/logs');
const { shouldLog } = require('../src/services/LoggingService');
const { LoggingService } = require('../src/services/LoggingService');
const { LogSetupService, planChannels } = require('../src/services/LogSetupService');
const { CATEGORY_KEYS, EVENT_KEYS, EVENT_CATEGORY } = require('../src/utils/logCatalog');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

/** Faux serveur Discord : création/suppression de salons en mémoire. */
function fakeGuild() {
  const cache = new Collection();
  let seq = 500000000000000000n;
  const make = (data) => {
    const ch = {
      id: String(seq++),
      name: data.name,
      type: data.type,
      parentId: data.parent ?? null,
      topic: data.topic ?? null,
      sent: [],
      permissionOverwrites: { set: async () => {} },
      edit: async (d) => Object.assign(ch, { topic: d.topic ?? ch.topic }),
      delete: async () => cache.delete(ch.id),
      send: async (p) => ch.sent.push(p),
      permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
      toString: () => `<#${ch.id}>`,
    };
    cache.set(ch.id, ch);
    return ch;
  };
  return {
    id: '100000000000000001',
    name: 'Test',
    roles: { cache: new Collection([['300000000000000001', { id: '300000000000000001' }]]) },
    members: { me: { id: '999999999999999999', permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache, create: async (d) => make(d) },
  };
}

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const guild = fakeGuild();
  const client = { services: { config, logging: new LoggingService({ channels: { fetch: async () => null } }, config), logSetup: new LogSetupService({ config }) } };
  return { client, guild, config };
}

test('catalogue : chaque événement appartient à une catégorie connue', () => {
  assert.equal(CATEGORY_KEYS.length, 9);
  assert.ok(EVENT_KEYS.length >= 29);
  for (const e of EVENT_KEYS) assert.ok(CATEGORY_KEYS.includes(EVENT_CATEGORY[e]));
});

test('shouldLog : interrupteur, pause, événements, salons ignorés, bots, salon de logs', () => {
  const base = { logChannels: { messages: 'L1', members: 'L2' }, logs: { enabled: true, disabledEvents: [], disabledCategories: [], ignoredChannels: ['C9', 'CAT'], ignoreBots: true } };
  assert.equal(shouldLog(base, 'messages', { event: 'messageDelete', channelId: 'C1' }), true);
  assert.equal(shouldLog(base, 'roles', {}), false, 'catégorie sans salon');
  assert.equal(shouldLog({ ...base, logs: { ...base.logs, enabled: false } }, 'messages', {}), false);
  assert.equal(shouldLog({ ...base, logs: { ...base.logs, disabledCategories: ['messages'] } }, 'messages', {}), false);
  assert.equal(shouldLog({ ...base, logs: { ...base.logs, disabledEvents: ['messageEdit'] } }, 'messages', { event: 'messageEdit' }), false);
  assert.equal(shouldLog(base, 'messages', { channelId: 'C9' }), false, 'salon ignoré');
  assert.equal(shouldLog(base, 'messages', { channelId: 'T1', parentId: 'CAT' }), false, 'fil / salon d\'une catégorie ignorée');
  assert.equal(shouldLog(base, 'messages', { channelId: 'C1', bot: true }), false, 'bots ignorés');
  assert.equal(shouldLog(base, 'messages', { channelId: 'L2' }), false, 'jamais de log sur le salon de logs');
  assert.equal(shouldLog(base, 'members', { event: 'memberJoin' }), true);
});

test('plan de création : trois dispositions', () => {
  assert.equal(planChannels('perCategory', CATEGORY_KEYS).length, 9);
  assert.equal(planChannels('grouped', CATEGORY_KEYS).length, 3);
  assert.equal(planChannels('single', CATEGORY_KEYS).length, 1);
  assert.deepEqual(planChannels('grouped', ['messages']).map((p) => p.categories), [['messages']]);
  assert.ok(planChannels('perCategory', CATEGORY_KEYS).every((p) => p.name === p.name.toLowerCase() && !/\s/.test(p.name)));
});

test('création automatique : catégorie privée, salons branchés, réutilisation sans doublon, suppression', async () => {
  const { client, guild, config } = world();
  const r = await client.services.logSetup.create(guild, { layout: 'grouped', categories: CATEGORY_KEYS, staffRoleId: '300000000000000001' });
  assert.equal(r.category.type, ChannelType.GuildCategory);
  assert.equal(r.created.length, 3);
  const cfg = config.get(guild.id);
  for (const k of CATEGORY_KEYS) assert.ok(cfg.logChannels[k], `catégorie ${k} branchée`);
  assert.equal(cfg.logs.createdChannels.length, 3);
  assert.ok(r.created[0].sent.length, 'message d\'accueil dans chaque salon');

  const again = await client.services.logSetup.create(guild, { layout: 'grouped', categories: CATEGORY_KEYS });
  assert.equal(again.created.length, 0, 'aucun doublon');
  assert.equal(again.reused.length, 3);

  const removed = await client.services.logSetup.remove(guild);
  assert.equal(removed, 3);
  const after = config.get(guild.id);
  assert.ok(CATEGORY_KEYS.every((k) => !after.logChannels[k]), 'logs débranchés');
  assert.equal(after.logs.categoryId, null);
});

test('chaque vue de /logs respecte les limites Discord et route vers un gestionnaire', async () => {
  const { client, guild } = world();
  await client.services.logSetup.create(guild, { layout: 'perCategory', categories: CATEGORY_KEYS });
  const views = ['home', 'setup', 'options', 'confirmRemove', ...CATEGORY_KEYS.map((k) => `cat:${k}`), 'cat.messages'];
  for (const v of views) {
    const payload = logs.render(client, guild, v, '✅ Notification');
    const rows = payload.components.map(json);
    assert.ok(rows.length <= 5, `${v} : ${rows.length} rangées`);
    const ids = [];
    for (const r of rows) {
      assert.ok(r.components.length <= 5);
      for (const c of r.components) {
        if (!c.custom_id) continue;
        ids.push(c.custom_id);
        const [, cmd, action] = c.custom_id.split(':');
        assert.equal(cmd, 'logs');
        assert.equal(typeof logs.buttons[action], 'function', `${v} : ${action}`);
        if (c.options) assert.ok(c.options.length <= 25);
      }
    }
    assert.equal(new Set(ids).size, ids.length, `${v} : doublons`);
    for (const e of payload.embeds.map(json)) assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024));
  }
});

test('événements d\'une catégorie : le menu remplace la sélection sans toucher aux autres', async () => {
  const { client, guild, config } = world();
  config.update(guild.id, { logs: { disabledEvents: ['memberJoin'] } });
  const i = { guildId: guild.id, guild, memberPermissions: new PermissionsBitField(PermissionsBitField.All), values: ['messageDelete'], update: async () => {} };
  await logs.buttons.events(i, client, ['messages']);
  const disabled = config.get(guild.id).logs.disabledEvents.sort();
  assert.deepEqual(disabled, ['memberJoin', 'messageBulkDelete', 'messageEdit']);
});

test('tous les gestionnaires de /logs refusent sans « Gérer le serveur »', async () => {
  const { client, guild } = world();
  const i = { guildId: guild.id, guild, memberPermissions: new PermissionsBitField(0n), values: [] };
  for (const [name, handler] of Object.entries(logs.buttons)) {
    await assert.rejects(handler(i, client, ['messages']), { name: 'UserError' }, name);
  }
});
