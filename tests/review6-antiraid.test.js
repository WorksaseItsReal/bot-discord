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
