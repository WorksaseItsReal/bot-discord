'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, Collection, ChannelType } = require('discord.js');
const antiraid = require('../src/commands/security/antiraid');
const { AntiRaidService } = require('../src/services/AntiRaidService');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const GID = '100000000000000001';
const ALERT = '200000000000000001';
const sf = (base, i) => String(BigInt(base) + BigInt(i));

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const sent = [];
  const alertChannel = { id: ALERT, type: ChannelType.GuildText, send: async (p) => sent.push(p) };
  const roles = new Collection(Array.from({ length: 40 }, (_, i) => [sf('300000000000000000', i), { id: sf('300000000000000000', i) }]));
  const guild = {
    id: GID,
    ownerId: '1',
    channels: { cache: new Collection([[ALERT, alertChannel]]) },
    roles: { cache: roles },
    members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All) } },
  };
  const logged = [];
  const client = { services: { config }, guilds: { cache: new Map([[GID, guild]]) } };
  client.services.antiraid = new AntiRaidService({ client: { channels: { fetch: async () => alertChannel }, services: {} }, config, logging: { send: async (...a) => logged.push(a) } });
  return { client, guild, config, sent, logged };
}

/** Fausse interaction : enregistre update / reply / showModal. */
function fake(guild, { perms = PermissionsBitField.All, values, fields, extra } = {}) {
  const calls = { update: [], reply: [], modal: [], editReply: [] };
  return {
    calls,
    guildId: guild.id,
    guild,
    user: { id: '5', toString: () => '<@5>' },
    memberPermissions: new PermissionsBitField(perms),
    values,
    fields: fields ? { getTextInputValue: (id) => fields[id] ?? '' } : undefined,
    async update(p) { calls.update.push(p); },
    async reply(p) { calls.reply.push(p); },
    async showModal(m) { calls.modal.push(m); },
    async deferUpdate() { this.deferred = true; },
    async editReply(p) { calls.editReply.push(p); },
    ...extra,
  };
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
      if (cmd === 'antiraid') assert.equal(typeof antiraid.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25);
      if (c.default_values) assert.ok(c.default_values.length <= 25, `${label} : trop de valeurs par défaut`);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label} : identifiants en double`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096);
    assert.ok((e.fields ?? []).length <= 25);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256));
  }
}

const VIEWS = ['home', 'joins', 'accounts', 'destructive', 'alerts', 'whitelist', 'presets', 'inconnue'];

test('/antiraid : commande unique sans sous-commande, réservée aux administrateurs', () => {
  const data = antiraid.data.toJSON();
  assert.equal((data.options ?? []).length, 0);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.Administrator));
});

test('chaque vue respecte les limites Discord et route vers un gestionnaire', () => {
  const { client, guild, config } = world();
  for (const v of VIEWS) assertValid(antiraid.render(client, guild, v), `${v} (défaut)`);
  // Listes chargées au-delà des limites des menus.
  config.update(GID, {
    antiraid: { alertChannel: ALERT, enabled: true },
    whitelist: { users: Array.from({ length: 40 }, (_, i) => sf('400000000000000000', i)), roles: [...guild.roles.cache.keys()] },
  });
  for (const v of VIEWS) assertValid(antiraid.render(client, guild, v, 'Notification de test'), v);
  // Serveur minimal (aucun cache) : rendu sans erreur.
  for (const v of VIEWS) assertValid(antiraid.render(client, { id: GID }, v), `${v} (minimal)`);
});

test('tous les gestionnaires refusent sans « Administrateur » (même avec « Gérer le serveur »)', async () => {
  const { client, guild } = world();
  for (const perms of [0n, PermissionFlagsBits.ManageGuild]) {
    const i = fake(guild, { perms, values: ['home'], fields: {} });
    for (const [name, handler] of Object.entries(antiraid.buttons)) {
      await assert.rejects(handler(i, client, ['joins', 'on']), { name: 'UserError' }, name);
    }
    assert.equal(i.calls.update.length + i.calls.reply.length + i.calls.modal.length, 0);
  }
});

test('interrupteurs : la valeur cible du bouton est appliquée (pas d\'inversion)', async () => {
  const { client, guild, config } = world();
  const i = fake(guild);
  await antiraid.buttons.toggle(i, client, ['on']);
  await antiraid.buttons.toggle(i, client, ['on']);
  assert.equal(config.get(GID).antiraid.enabled, true);
  const ids = json(i.calls.update[1].components[1]).components.map((c) => c.custom_id);
  assert.ok(ids.includes('cmd:antiraid:toggle:off'));
  await antiraid.buttons.antibot(i, client, ['off']);
  assert.equal(config.get(GID).antiraid.antiBot, false);
});

test('formulaires : libellés ≤ 45, réglages validés et bornés', async () => {
  const { client, guild, config } = world();
  for (const kind of ['joins', 'accounts', 'destructive']) {
    const i = fake(guild);
    await antiraid.buttons.set(i, client, [kind]);
    const modal = json(i.calls.modal[0]);
    assert.equal(modal.custom_id, `cmd:antiraid:setsubmit:${kind}`);
    assert.equal(typeof antiraid.buttons[modal.custom_id.split(':')[2]], 'function');
    for (const row of modal.components) for (const c of row.components) assert.ok(c.label.length <= 45, c.label);
  }
  await assert.rejects(antiraid.buttons.set(fake(guild), client, ['inconnu']), { name: 'UserError' });
  await antiraid.buttons.setsubmit(fake(guild, { fields: { roleDeleteThreshold: '0', destructiveWindowSeconds: '' } }), client, ['destructive']);
  assert.equal(config.get(GID).antiraid.roleDeleteThreshold, 0);
  assert.equal(config.get(GID).antiraid.destructiveWindowSeconds, 10, 'champ vide : inchangé');
  for (const bad of [{ joinWindowSeconds: '0' }, { joinThreshold: '2.5' }, { joinThreshold: 'abc' }]) {
    await assert.rejects(antiraid.buttons.setsubmit(fake(guild, { fields: bad }), client, ['joins']), { name: 'UserError' });
  }
  await assert.rejects(antiraid.buttons.setsubmit(fake(guild, { fields: {} }), client, ['joins']), /Aucune valeur/);
});

test('menus : action de vague, comptes récents, sanction de l\'auteur, salon d\'alerte', async () => {
  const { client, guild, config } = world();
  for (const [handler, value, key] of [['action', 'ban', 'action'], ['newaccount', 'kick', 'newAccountAction'], ['executor', 'none', 'punishExecutor']]) {
    await antiraid.buttons[handler](fake(guild, { values: [value] }), client);
    assert.equal(config.get(GID).antiraid[key], value);
    await assert.rejects(antiraid.buttons[handler](fake(guild, { values: ['constructor'] }), client), { name: 'UserError' });
  }
  await antiraid.buttons.alertch(fake(guild, { values: [ALERT] }), client);
  assert.equal(config.get(GID).antiraid.alertChannel, ALERT);
  await assert.rejects(antiraid.buttons.alertch(fake(guild, { values: ['abc'] }), client), { name: 'UserError' });
  await antiraid.buttons.alertch(fake(guild, { values: [] }), client);
  assert.equal(config.get(GID).antiraid.alertChannel, null);
});

test('alerte de test : envoyée dans le salon d\'alerte (deferUpdate puis editReply)', async () => {
  const { client, guild, config, sent } = world();
  await assert.rejects(antiraid.buttons.alerttest(fake(guild), client), /Aucun salon/);
  config.update(GID, { antiraid: { alertChannel: ALERT } });
  const i = fake(guild);
  await antiraid.buttons.alerttest(i, client);
  assert.ok(i.deferred);
  assert.equal(sent.length, 1);
  assert.match(json(i.calls.editReply[0].embeds[0]).description, /envoyée/);
});

test('whitelist : les menus remplacent la sélection visible et conservent le reste', async () => {
  const { client, guild, config } = world();
  const users = Array.from({ length: 30 }, (_, i) => sf('400000000000000000', i));
  config.update(GID, { whitelist: { users, roles: [] } });
  // Le menu montre les 25 premiers ; on en retire un et on en ajoute un.
  const picked = [...users.slice(1, 25), '499999999999999999'];
  await antiraid.buttons.wlusers(fake(guild, { values: picked }), client);
  const after = config.get(GID).whitelist.users;
  assert.ok(!after.includes(users[0]));
  assert.ok(after.includes('499999999999999999'));
  assert.ok(users.slice(25).every((u) => after.includes(u)), 'entrées hors menu conservées');
  const role = [...guild.roles.cache.keys()][0];
  await antiraid.buttons.wlroles(fake(guild, { values: [role, GID] }), client);
  assert.deepEqual(config.get(GID).whitelist.roles, [role], '@everyone ignoré');
});

test('préréglages : configuration complète, salon d\'alerte et whitelist conservés', async () => {
  const { client, guild, config } = world();
  config.update(GID, { antiraid: { alertChannel: ALERT }, whitelist: { users: ['400000000000000001'] } });
  for (const key of Object.keys(antiraid.PRESETS)) {
    await antiraid.buttons.preset(fake(guild), client, [key]);
    const c = config.get(GID).antiraid;
    assert.equal(c.enabled, true);
    assert.equal(c.alertChannel, ALERT);
    assert.equal(c.joinThreshold, antiraid.PRESETS[key].patch.joinThreshold);
    for (const [k, [min, max]] of Object.entries(antiraid.BOUNDS)) assert.ok(c[k] >= min && c[k] <= max, `${key}.${k}`);
  }
  assert.deepEqual(config.get(GID).whitelist.users, ['400000000000000001']);
  await assert.rejects(antiraid.buttons.preset(fake(guild), client, ['toString']), { name: 'UserError' });
});

test('simulation : sans effet, signale permissions manquantes et protection désactivée', async () => {
  const base = { enabled: true, joinThreshold: 10, joinWindowSeconds: 10, action: 'lockdown', minAccountAgeDays: 3, antiBot: true, newAccountAction: 'ban', channelDeleteThreshold: 3, roleDeleteThreshold: 0, banThreshold: 0, destructiveWindowSeconds: 10, punishExecutor: 'strip' };
  const all = antiraid.simulate(base, new PermissionsBitField(PermissionsBitField.All));
  assert.equal(all.warnings.length, 0);
  assert.equal(all.lines.length, 4);
  const none = antiraid.simulate({ ...base, enabled: false }, new PermissionsBitField(0n), { alertChannelOk: false });
  const text = none.warnings.join('\n');
  for (const re of [/Bannir/, /Gérer les salons/, /Gérer les rôles/, /logs du serveur/, /introuvable/, /désactivé/]) assert.match(text, re);
  assert.doesNotMatch(text, /Expulser/, 'aucune expulsion configurée');

  const { client, guild, config } = world();
  const i = fake(guild);
  await antiraid.buttons.simulate(i, client);
  assert.equal(i.calls.reply[0].ephemeral, true);
  assert.equal(config.get(GID).antiraid.enabled, false, 'rien n\'est modifié');
});

test('dernier déclenchement : mémorisé par le service et affiché sur l\'accueil', async () => {
  const { client, guild } = world();
  let home = JSON.stringify(json(antiraid.render(client, guild, 'home').embeds[0]));
  assert.match(home, /Aucun depuis le démarrage/);
  await client.services.antiraid.alert(guild, { title: 'Vague d\'arrivées détectée', description: '**12** membres en 10 s.' });
  assert.equal(client.services.antiraid.lastTriggerOf(GID).title, 'Vague d\'arrivées détectée');
  home = JSON.stringify(json(antiraid.render(client, guild, 'home').embeds[0]));
  assert.match(home, /Vague d'arrivées détectée/);
});
