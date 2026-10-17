'use strict';

/**
 * Revue n° 6 (AntiRaid) : tests de régression unitaires. Chaque test échoue sans le
 * correctif correspondant (identifiant du constat en tête du nom).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { AntiRaidService } = require('../src/services/AntiRaidService');

const G = '100000000000000001';
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const titles = (alerts) => alerts.map((a) => json(a[2]).title);

// ---------------------------------------------------------------- monde de test

/**
 * Service AntiRaid branché sur de faux objets : arrivées (`join`), sanctions enregistrées,
 * alertes reçues par les logs sécurité, lockdown simulé.
 */
function raidWorld(cfg = {}, { banFails = false, kickFails = false, whitelist = { users: [], roles: [] } } = {}) {
  const kicked = [];
  const banned = [];
  const alerts = [];
  const lockdowns = [];
  const members = new Collection();
  const guild = {
    id: G,
    ownerId: 'owner',
    name: 'Serveur',
    members: { cache: members, fetch: async (id) => members.get(id) ?? Promise.reject(Object.assign(new Error('Unknown Member'), { code: 10007 })), me: { id: 'bot' } },
    bans: { create: async (id) => (banFails ? Promise.reject(new Error('Missing Permissions')) : banned.push(id)) },
    roles: { cache: new Collection() },
  };
  const antiraidCfg = { enabled: true, joinThreshold: 3, joinWindowSeconds: 10, minAccountAgeDays: 0, antiBot: false, action: 'kick', ...cfg };
  const config = { get: () => ({ antiraid: antiraidCfg, whitelist, logChannels: {} }) };
  const client = {
    user: { id: 'bot' },
    services: {
      lockdown: { enable: async () => { lockdowns.push(Date.now()); return 4; }, status: () => 4 },
    },
    channels: { fetch: async () => null },
  };
  const service = new AntiRaidService({ client, config, logging: { send: async (...a) => { alerts.push(a); return true; } } });
  const join = (id, { bot = false, ageDays = 365, roles = [] } = {}) => {
    const member = {
      id,
      guild,
      kickable: true,
      bannable: true,
      user: { id, bot, createdTimestamp: Date.now() - ageDays * 86_400_000, toString: () => `<@${id}>`, displayAvatarURL: () => null },
      roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) },
      kick: async () => {
        if (kickFails) throw new Error('Missing Permissions');
        kicked.push(id);
        members.delete(id);
      },
      ban: async () => {
        if (banFails) throw new Error('Missing Permissions');
        banned.push(id);
        members.delete(id);
      },
    };
    members.set(id, member);
    return service.handleJoin(member);
  };
  return { service, join, kicked, banned, alerts, lockdowns, members, guild, client, cfg: antiraidCfg };
}

// ---------------------------------------------------------------- R29

test('R29 : comptes récents comptés dans la vague → lockdown, même si chacun est banni à son arrivée', async (t) => {
  const w = raidWorld({ action: 'lockdown', joinThreshold: 3, minAccountAgeDays: 7, newAccountAction: 'ban' });
  t.after(() => w.service.stop());
  for (const id of ['a', 'b', 'c']) await w.join(id, { ageDays: 0.2 });
  assert.deepEqual(w.banned.sort(), ['a', 'b', 'c'], 'chaque compte récent est banni');
  assert.equal(w.lockdowns.length, 1, 'raid de comptes récents : aucun lockdown');
  assert.ok(titles(w.alerts).some((x) => /Vague d'arrivées détectée/.test(x)), titles(w.alerts).join(' | '));
});

test('R29 : sanction des comptes récents en échec → alerte d\'échec (une seule), vague et lockdown quand même', async (t) => {
  const w = raidWorld({ action: 'lockdown', joinThreshold: 3, minAccountAgeDays: 7, newAccountAction: 'ban' }, { banFails: true });
  t.after(() => w.service.stop());
  for (let i = 0; i < 6; i += 1) await w.join(`f${i}`, { ageDays: 0.2 });
  assert.equal(w.banned.length, 0);
  const list = titles(w.alerts);
  assert.equal(list.filter((x) => /Sanction automatique impossible/.test(x)).length, 1, list.join(' | '));
  assert.ok(list.some((x) => /Vague d'arrivées détectée/.test(x)), 'échec silencieux : aucune vague détectée');
  assert.equal(w.lockdowns.length, 1, 'aucun lockdown alors que les raiders restent');
  const failure = json(w.alerts.find((a) => /impossible/.test(json(a[2]).title))[2]);
  assert.match(JSON.stringify(failure), /Missing Permissions/);
  // Les échecs suivants sont regroupés dans le récapitulatif de la minute.
  const before = w.alerts.length;
  assert.equal(await w.service.flushDigest(G), true);
  const recap = json(w.alerts[before][2]);
  assert.match(recap.title, /récapitulatif/i);
  assert.match(JSON.stringify(recap.fields), /échec/i);
});

test('R29 : raid de comptes récents bannis → au plus 3 alertes individuelles par minute, puis une carte récapitulative', async (t) => {
  const w = raidWorld({ action: 'lockdown', joinThreshold: 1000, minAccountAgeDays: 7, newAccountAction: 'ban' });
  t.after(() => w.service.stop());
  for (let i = 0; i < 10; i += 1) await w.join(`r${i}`, { ageDays: 0.1 });
  assert.equal(w.banned.length, 10);
  assert.equal(w.alerts.length, 3, `une alerte par arrivant : ${w.alerts.length}`);
  assert.equal(await w.service.flushDigest(G), true);
  assert.equal(w.alerts.length, 4);
  const recap = json(w.alerts[3][2]);
  assert.match(recap.title, /récapitulatif/i);
  assert.match(JSON.stringify(recap.fields), /\*\*7\*\* banni/);
  // Rien de neuf : pas de nouvelle carte.
  assert.equal(await w.service.flushDigest(G), false);
  assert.equal(w.alerts.length, 4);
});

test('R29 : vague en mode ban, les comptes récents déjà bannis ne sont pas rebannis par la vague', async (t) => {
  const w = raidWorld({ action: 'ban', joinThreshold: 3, minAccountAgeDays: 7, newAccountAction: 'ban' });
  t.after(() => w.service.stop());
  await w.join('vieux1');
  await w.join('frais', { ageDays: 0.1 });
  const res = await w.join('vieux2');
  assert.equal(res.punished, true);
  assert.deepEqual(w.banned.sort(), ['frais', 'vieux1', 'vieux2'], 'un compte banni deux fois');
});

// ---------------------------------------------------------------- R30

/** Service AntiRaid dont les logs sécurité sont injoignables (salon supprimé / débranché / en pause). */
function lostAlertWorld({ logged = false, ownerDm = true, system = true } = {}) {
  const dms = [];
  const systemPosts = [];
  const channelPosts = [];
  const executor = {
    id: 'nuker',
    roles: { cache: new Collection([['r1', { id: 'r1', editable: true, permissions: { any: () => false }, toString: () => '<@&r1>' }]]), remove: async () => {} },
    user: { id: 'nuker', tag: 'nuker', toString: () => '<@nuker>', displayAvatarURL: () => null },
  };
  const guild = {
    id: G,
    name: 'Serveur',
    ownerId: 'owner',
    members: { cache: new Map(), fetch: async () => executor, me: { id: 'bot' } },
    roles: { everyone: { id: G, permissions: { any: () => false } } },
    channels: { cache: new Collection() },
    systemChannel: system ? { id: 'sys', send: async (p) => systemPosts.push(p), permissionsFor: () => ({ has: () => true }) } : null,
  };
  const cfg = {
    antiraid: { enabled: true, channelDeleteThreshold: 3, roleDeleteThreshold: 3, banThreshold: 5, destructiveWindowSeconds: 10, punishExecutor: 'strip', alertChannel: 'deleted-alert', joinThreshold: 50, joinWindowSeconds: 10 },
    whitelist: { users: [], roles: [] },
    logChannels: { security: null },
  };
  const client = {
    user: { id: 'bot' },
    services: {},
    channels: { fetch: async (id) => (id === 'alive' ? { id, send: async (p) => channelPosts.push(p) } : Promise.reject(new Error('Unknown Channel'))) },
    users: { fetch: async (id) => ({ id, send: async (p) => (ownerDm ? dms.push([id, p]) : Promise.reject(new Error('Cannot send messages to this user'))) }) },
  };
  const service = new AntiRaidService({ client, config: { get: () => cfg }, logging: { send: async () => logged } });
  return { service, guild, cfg, dms, systemPosts, channelPosts };
}

const nuke = async (w) => {
  for (let i = 0; i < 3; i += 1) await w.service.handleDestructive(w.guild, 'nuker', 'channelDelete');
};

test('R30 : alerte de destruction sans salon d\'alerte ni logs sécurité → MP au propriétaire', async () => {
  const w = lostAlertWorld();
  await nuke(w);
  assert.equal(w.dms.length, 1, 'alerte perdue sans repli');
  const [to, payload] = w.dms[0];
  assert.equal(to, 'owner');
  assert.match(json(payload.embeds[0]).title, /Activité destructrice/);
  assert.match(payload.content, /Serveur/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.components, undefined, 'boutons du serveur inutilisables en MP');
  assert.equal(w.systemPosts.length, 0);
});

test('R30 : MP du propriétaire fermés → repli sur le salon système', async () => {
  const w = lostAlertWorld({ ownerDm: false });
  await nuke(w);
  assert.equal(w.dms.length, 0);
  assert.equal(w.systemPosts.length, 1, 'aucun repli quand le MP échoue');
  assert.match(json(w.systemPosts[0].embeds[0]).title, /Activité destructrice/);
});

test('R30 : alerte bien reçue (logs sécurité ou salon d\'alerte) → aucun repli ; alertes ordinaires jamais en MP', async () => {
  const delivered = lostAlertWorld({ logged: true });
  await nuke(delivered);
  assert.equal(delivered.dms.length + delivered.systemPosts.length, 0);
  const alertChannel = lostAlertWorld();
  alertChannel.cfg.antiraid.alertChannel = 'alive';
  await nuke(alertChannel);
  assert.equal(alertChannel.channelPosts.length, 1);
  assert.equal(alertChannel.dms.length + alertChannel.systemPosts.length, 0);
  // Alerte non critique (nouveau membre sanctionné) : pas de MP au propriétaire.
  const quiet = lostAlertWorld();
  await quiet.service.alert(quiet.guild, { tone: 'caution', title: 'Nouveau membre expulsé' });
  assert.equal(quiet.dms.length + quiet.systemPosts.length, 0);
});

// ---------------------------------------------------------------- R31

const antiraidCmd = require('../src/commands/security/antiraid');
const { PermissionsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const BOOSTER = '300000000000000099';
const TRUSTED = '300000000000000001';

/** Tableau de bord /antiraid sur une vraie configuration (base en mémoire). */
function dashboardWorld() {
  const config = new ConfigService(new GuildConfigRepository(memoryDb().db));
  const roles = new Collection([
    [TRUSTED, { id: TRUSTED, managed: false }],
    [BOOSTER, { id: BOOSTER, managed: true, toString: () => `<@&${BOOSTER}>` }],
  ]);
  const guild = { id: G, ownerId: 'owner', roles: { cache: roles }, channels: { cache: new Collection() }, members: { me: null } };
  const logged = [];
  const client = { guilds: { cache: new Map([[G, guild]]) }, services: { config }, user: { id: 'bot' }, channels: { fetch: async () => null } };
  client.services.antiraid = new AntiRaidService({ client, config, logging: { send: async (...a) => { logged.push(a); return true; } } });
  const interaction = (values, { user = 'admin' } = {}) => ({
    guildId: G,
    guild,
    user: { id: user, tag: user, toString: () => `<@${user}>` },
    memberPermissions: new PermissionsBitField(PermissionsBitField.All),
    values,
    updates: [],
    async update(p) { this.updates.push(p); },
    async reply(p) { this.updates.push(p); },
    async deferUpdate() {},
    async editReply(p) { this.updates.push(p); },
  });
  return { config, guild, client, interaction, logged };
}

test('R31 : le tableau de bord refuse un rôle géré (Booster) comme /whitelist', async () => {
  const w = dashboardWorld();
  await assert.rejects(antiraidCmd.buttons.wlroles(w.interaction([TRUSTED, BOOSTER]), w.client), (e) => e.name === 'UserError' && /géré/.test(e.message));
  assert.deepEqual(w.config.get(G).whitelist.roles, [], 'rôle géré whitelisté');
  await antiraidCmd.buttons.wlroles(w.interaction([TRUSTED]), w.client);
  assert.deepEqual(w.config.get(G).whitelist.roles, [TRUSTED]);
});

test('R31 : un rôle géré déjà whitelisté (ancienne configuration) ne donne aucune immunité et disparaît au prochain choix', async () => {
  const w = dashboardWorld();
  w.config.update(G, { whitelist: { roles: [BOOSTER, TRUSTED] } });
  assert.equal(w.client.services.antiraid.isWhitelisted(G, 'booster', [BOOSTER]), false, 'tout booster est immunisé');
  assert.equal(w.client.services.antiraid.isWhitelisted(G, 'staff', [TRUSTED]), true);
  // Le rôle géré n'est plus présélectionné : choisir la whitelist le retire.
  await antiraidCmd.buttons.wlroles(w.interaction([TRUSTED]), w.client);
  assert.deepEqual(w.config.get(G).whitelist.roles, [TRUSTED]);
});
