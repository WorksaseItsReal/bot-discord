'use strict';

/**
 * SEC3 — riposte native (RaidResponseService) : échéance plafonnée à 24 h − 1 min et jamais
 * raccourcie, reprise → null, erreurs traduites, verrou par serveur, riposte de vague (une pause
 * par 10 min), bloc de configuration et sous-commandes de /lockdown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const {
  RaidResponseService, pauseUntil, normalizeHours, translateError, describeState, MAX_PAUSE_MS, WAVE_COOLDOWN_MS, MISSING_PERMISSION,
} = require('../src/services/RaidResponseService');
const { defaultGuildConfig } = require('../src/config/defaults');

const G = '100000000000000001';
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Faux serveur : incidentsData, PUT enregistrés (concurrence mesurée), erreurs injectables. */
function fakeGuild({ perms = P.Administrator, current = null } = {}) {
  const g = {
    id: G,
    incidentsData: current,
    members: { me: { permissions: new PermissionsBitField(perms) } },
    puts: [],
    fetches: 0,
    active: 0,
    maxActive: 0,
    fail: null,
    async fetch() {
      g.fetches += 1;
      return g;
    },
    async setIncidentActions({ invitesDisabledUntil, dmsDisabledUntil }) {
      g.active += 1;
      g.maxActive = Math.max(g.maxActive, g.active);
      await new Promise((r) => setImmediate(r));
      g.active -= 1;
      if (g.fail) throw g.fail;
      g.puts.push({ invitesDisabledUntil, dmsDisabledUntil });
      const d = (v) => (v ? new Date(v) : null);
      g.incidentsData = { invitesDisabledUntil: d(invitesDisabledUntil), dmsDisabledUntil: d(dmsDisabledUntil), raidDetectedAt: null, dmSpamDetectedAt: null };
      return g.incidentsData;
    },
  };
  return g;
}

function service({ now = 1_800_000_000_000, raidResponse = {} } = {}) {
  const clock = { now };
  const cfg = { raidResponse: { ...defaultGuildConfig.raidResponse, ...raidResponse } };
  const svc = new RaidResponseService({ client: {}, config: { get: () => cfg }, now: () => clock.now });
  return { svc, clock, cfg };
}

test('bloc raidResponse juste après antiraid, coupé par défaut ; échéance plafonnée à maintenant + 24 h − 1 min ; durées admises', () => {
  const keys = Object.keys(defaultGuildConfig);
  assert.equal(keys.indexOf('raidResponse'), keys.indexOf('antiraid') + 1);
  assert.deepEqual(defaultGuildConfig.raidResponse, { onWave: false, invites: true, dms: false, hours: 6 });
  const now = 1_000_000;
  assert.equal(pauseUntil(now, 24), now + 24 * HOUR - MINUTE);
  assert.equal(MAX_PAUSE_MS, 24 * HOUR - MINUTE);
  assert.equal(pauseUntil(now, 6), now + 6 * HOUR);
  assert.equal(normalizeHours(5), 6, 'durée inconnue → 6 h');
  assert.equal(normalizeHours('12'), 12);
  assert.match(describeState({ invitesDisabledUntil: now + HOUR }, now), /Invitations suspendues jusqu'à <t:\d+:t>/);
  assert.equal(describeState({}, now), 'Invitations et MP actifs.');
});

test('pause : les deux échéances envoyées, celle qui ne change pas gardée ; jamais raccourcie ; reprise → null', async () => {
  const { svc, clock } = service();
  const g = fakeGuild();
  const first = await svc.pause(g, { invites: true, dms: false, hours: 24 });
  assert.equal(first.invitesDisabledUntil, clock.now + 24 * HOUR - MINUTE);
  assert.equal(first.dmsDisabledUntil, null);
  assert.deepEqual(g.puts[0], { invitesDisabledUntil: clock.now + 24 * HOUR - MINUTE, dmsDisabledUntil: null });
  // 1 h demandée ensuite : l'échéance de 24 h est conservée ; les MP s'ajoutent sans toucher aux invitations.
  clock.now += 10 * MINUTE;
  const second = await svc.pause(g, { invites: true, dms: true, hours: 1 });
  assert.equal(second.invitesDisabledUntil, first.invitesDisabledUntil, 'échéance raccourcie');
  assert.equal(second.dmsDisabledUntil, clock.now + HOUR);
  // Prolongée si la nouvelle échéance est plus lointaine.
  clock.now += 23 * HOUR;
  const third = await svc.pause(g, { invites: true, hours: 6 });
  assert.equal(third.invitesDisabledUntil, clock.now + 6 * HOUR);
  assert.equal(third.dmsDisabledUntil, null, 'MP échus remis à null');
  // Reprise des invitations seules, puis de tout.
  await svc.pause(g, { dms: true, invites: false, hours: 3 });
  const resumed = await svc.resume(g, { invites: true, dms: false });
  assert.equal(resumed.invitesDisabledUntil, null);
  assert.equal(resumed.dmsDisabledUntil, clock.now + 3 * HOUR);
  const all = await svc.resume(g);
  assert.deepEqual([all.invitesDisabledUntil, all.dmsDisabledUntil], [null, null]);
  assert.deepEqual(g.puts.at(-1), { invitesDisabledUntil: null, dmsDisabledUntil: null });
  await assert.rejects(svc.pause(g, { invites: false, dms: false }), /au moins/);
  const status = await svc.status(g);
  assert.deepEqual(status, { invitesDisabledUntil: null, dmsDisabledUntil: null, raidDetectedAt: null, dmSpamDetectedAt: null });
});

test('erreurs traduites (50013, 403, 50035, autre) ; bot sans « Gérer le serveur » : refus sans appel ; verrou par serveur', async () => {
  assert.equal(translateError(Object.assign(new Error('x'), { code: 50013 })).message, MISSING_PERMISSION);
  assert.equal(translateError(Object.assign(new Error('x'), { status: 403 })).message, MISSING_PERMISSION);
  assert.match(translateError(Object.assign(new Error('x'), { code: 50035 })).message, /24 h au plus/);
  assert.match(translateError(new Error('ECONNRESET')).message, /Réessayez/);
  assert.equal(translateError(new Error('x')).name, 'UserError');

  const { svc } = service();
  const weak = fakeGuild({ perms: P.BanMembers });
  await assert.rejects(svc.pause(weak), /Gérer le serveur/);
  await assert.rejects(svc.resume(weak), /Gérer le serveur/);
  assert.equal(weak.puts.length + weak.fetches, 0, 'appel voué au 403');

  const g = fakeGuild();
  g.fail = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  await assert.rejects(svc.pause(g), (e) => e.name === 'UserError' && /Gérer le serveur/.test(e.message));
  g.fail = null;
  // Verrou : dix appels simultanés s'exécutent l'un après l'autre.
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? svc.resume(g) : svc.pause(g, { hours: 3 }))));
  assert.equal(g.maxActive, 1, 'appels concurrents sur le même serveur');
  assert.equal(g.puts.length, 10);
  assert.equal(svc.locks.size, 0, 'verrou laissé');
});

test('riposte de vague : coupée → null sans appel ; active → une pause, puis aucune autre pendant 10 min (deux vagues à 3 min d\'écart) ; échec → texte, jamais d\'exception', async () => {
  const off = service();
  const g0 = fakeGuild();
  assert.equal(await off.svc.onWave(g0, { count: 12 }), null);
  assert.equal(g0.puts.length, 0);

  const { svc, clock } = service({ raidResponse: { onWave: true, invites: true, dms: false, hours: 6 } });
  const g = fakeGuild();
  const [a, b] = await Promise.all([svc.onWave(g, { count: 10 }), svc.onWave(g, { count: 11 })]);
  assert.equal(g.puts.length, 1, 'deux vagues simultanées → deux pauses');
  assert.match(a.text, /Invitations suspendues jusqu'à/);
  assert.ok(b.text);
  clock.now += 3 * MINUTE;
  const c = await svc.onWave(g, { count: 10 });
  assert.equal(g.puts.length, 1, 'seconde vague 3 min après : nouvelle pause');
  assert.equal(c.text, a.text);
  clock.now += WAVE_COOLDOWN_MS;
  await svc.onWave(g, { count: 10 });
  assert.equal(g.puts.length, 2, 'aucune pause 10 min plus tard');
  // L'échéance n'est jamais portée au-delà de 24 h par une riposte (6 h ici).
  assert.ok(g.incidentsData.invitesDisabledUntil.getTime() <= clock.now + 24 * HOUR);

  const failing = service({ raidResponse: { onWave: true, invites: true, hours: 6 } });
  const weak = fakeGuild({ perms: P.BanMembers });
  const res = await failing.svc.onWave(weak, { count: 10 });
  assert.match(res.text, /Suspension impossible/);
  failing.svc.forgetGuild(G);
  assert.equal(failing.svc.waves.size, 0);
});

test('/lockdown : sous-commandes suspendre, reprendre, riposte (durées 1 à 24 h) ; bouton resume revérifie Administrateur', async () => {
  const lockdown = require('../src/commands/security/lockdown');
  const json = lockdown.data.toJSON();
  const subs = Object.fromEntries(json.options.map((o) => [o.name, o]));
  assert.deepEqual(Object.keys(subs), ['enable', 'disable', 'status', 'suspendre', 'reprendre', 'riposte']);
  assert.deepEqual(subs.suspendre.options.find((o) => o.name === 'duree').choices.map((c) => c.value), [1, 3, 6, 12, 24]);
  assert.equal(subs.riposte.options[0].name, 'actif');
  assert.equal(subs.riposte.options[0].required, true);
  const interaction = { memberPermissions: new PermissionsBitField(P.ManageGuild), guild: fakeGuild() };
  await assert.rejects(lockdown.buttons.resume(interaction, {}, ['all']), /Administrateur/);
  const admin = { ...interaction, memberPermissions: new PermissionsBitField(P.Administrator) };
  await assert.rejects(lockdown.buttons.resume(admin, { services: {} }, ['tout']), /invalide/);
  // Boutons « Rétablir » : seulement pour les mesures en cours, args sans « : ».
  const now = Date.now();
  const ids = lockdown.resumeButtons({ invitesDisabledUntil: now + HOUR, dmsDisabledUntil: now + HOUR }, now).filter(Boolean).map((b) => b.toJSON().custom_id);
  assert.deepEqual(ids, ['cmd:lockdown:resume:invites', 'cmd:lockdown:resume:dms', 'cmd:lockdown:resume:all']);
  assert.deepEqual(lockdown.resumeButtons({ invitesDisabledUntil: null, dmsDisabledUntil: now - 1 }, now).filter(Boolean), []);
});
