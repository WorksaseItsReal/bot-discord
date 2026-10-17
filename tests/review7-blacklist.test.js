'use strict';

/**
 * Revue n° 7, lot fx7-blacklist (unitaire) :
 *  - S39 : la riposte automatique (onWave) n'est jamais renouvelée au-delà de 24 h : une série de
 *    ripostes (vagues successives tant que la pause précédente court) est plafonnée à son début
 *    + 24 h − 1 min ; une nouvelle série ne démarre qu'après l'expiration de la précédente ;
 *  - S35 : applyRoles laisse passer l'ajout d'un rôle restrictif à un membre du blrank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { RaidResponseService, MAX_PAUSE_MS, WAVE_COOLDOWN_MS } = require('../src/services/RaidResponseService');
const { applyRoles } = require('../src/utils/memberRoles');

const G = '100000000000000001';
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Faux serveur : PUT enregistrés, échéances validées comme Discord (futur, 24 h au plus). */
function world(raidResponse) {
  const clock = { now: 1_800_000_000_000 };
  const g = {
    id: G,
    incidentsData: null,
    members: { me: { permissions: new PermissionsBitField(P.Administrator) } },
    puts: [],
    async fetch() {
      return g;
    },
    async setIncidentActions({ invitesDisabledUntil: i, dmsDisabledUntil: d }) {
      for (const v of [i, d]) if (v != null) assert.ok(v > clock.now && v <= clock.now + 24 * HOUR, `Discord refuserait ${v - clock.now}`);
      g.puts.push({ at: clock.now, i, d });
      g.incidentsData = { invitesDisabledUntil: i ? new Date(i) : null, dmsDisabledUntil: d ? new Date(d) : null };
      return g.incidentsData;
    },
  };
  const cfg = { raidResponse: { onWave: true, invites: true, dms: false, hours: 6, ...raidResponse } };
  const svc = new RaidResponseService({ client: {}, config: { get: () => cfg }, now: () => clock.now });
  const until = (k) => g.incidentsData?.[k]?.getTime?.() ?? 0;
  return { clock, g, svc, until, t0: clock.now };
}

test('S39 : MP seuls, 24 h — deux vagues à 11 min d\'écart ne portent pas la suspension au-delà de t0 + 24 h', async () => {
  const { clock, g, svc, until, t0 } = world({ invites: false, dms: true, hours: 24 });
  await svc.onWave(g, { count: 10 });
  clock.now += 11 * MINUTE;
  const res = await svc.onWave(g, { count: 10 });
  assert.ok(until('dmsDisabledUntil') <= t0 + MAX_PAUSE_MS, `MP suspendus ${(until('dmsDisabledUntil') - t0) / HOUR} h`);
  assert.equal(g.puts.length, 1, 'aucune extension possible : pas de PUT inutile');
  assert.match(res.text, /MP suspendus jusqu'à/);
});

test('S39 : vagues toutes les 6 h pendant 72 h (24 h par pause) — série plafonnée à t0 + 24 h ; nouvelle série après l\'expiration', async () => {
  const { clock, g, svc, until, t0 } = world({ invites: false, dms: true, hours: 24 });
  let seriesStart = t0;
  let lastEnd = 0;
  for (let t = t0; t <= t0 + 72 * HOUR; t += 6 * HOUR) {
    clock.now = t;
    const res = await svc.onWave(g, { count: 3 });
    assert.ok(res?.text);
    const end = until('dmsDisabledUntil');
    if (lastEnd <= t) seriesStart = t; // la pause précédente avait expiré : nouvelle série
    assert.ok(end <= seriesStart + MAX_PAUSE_MS, `à t0+${(t - t0) / HOUR} h : MP jusqu'à t0+${(end - t0) / HOUR} h (série depuis t0+${(seriesStart - t0) / HOUR} h)`);
    lastEnd = Math.max(lastEnd, end);
  }
  // Première série : jamais au-delà de t0 + 24 h − 1 min (avant le correctif : t0 + 95,98 h).
  assert.ok(g.puts.filter((p) => p.at < t0 + MAX_PAUSE_MS).every((p) => p.d <= t0 + MAX_PAUSE_MS));
  // Le raid continue après l'expiration : une nouvelle série protège de nouveau le serveur.
  assert.ok(g.puts.some((p) => p.at > t0 + MAX_PAUSE_MS), 'aucune nouvelle série après l\'expiration');
});

test('S39 : vagues toutes les 11 min pendant 30 h — aucun PUT au-delà du plafond de la série ; deux vagues simultanées → une seule pause', async () => {
  const { clock, g, svc, until, t0 } = world({ invites: true, dms: true, hours: 24 });
  await Promise.all([svc.onWave(g, { count: 10 }), svc.onWave(g, { count: 11 })]);
  assert.equal(g.puts.length, 1);
  for (let t = t0 + 11 * MINUTE; t < t0 + MAX_PAUSE_MS; t += 11 * MINUTE) {
    clock.now = t;
    await svc.onWave(g, { count: 10 });
    assert.ok(until('invitesDisabledUntil') <= t0 + MAX_PAUSE_MS);
    assert.ok(until('dmsDisabledUntil') <= t0 + MAX_PAUSE_MS);
  }
  assert.equal(g.puts.length, 1, 'renouvellements inutiles');
  // Expiration, puis une vague : nouvelle série de 24 h au plus.
  clock.now = t0 + MAX_PAUSE_MS + WAVE_COOLDOWN_MS;
  await svc.onWave(g, { count: 10 });
  assert.equal(g.puts.length, 2);
  assert.ok(until('dmsDisabledUntil') <= clock.now + MAX_PAUSE_MS);
});

test('S39 : une pause manuelle (/lockdown suspendre) n\'est pas plafonnée par la série', async () => {
  const { clock, g, svc, until, t0 } = world({ invites: true, dms: false, hours: 24 });
  await svc.onWave(g, { count: 10 });
  clock.now += 12 * HOUR;
  await svc.pause(g, { invites: true, hours: 24, actorId: '100000000000000011' });
  assert.ok(until('invitesDisabledUntil') > t0 + MAX_PAUSE_MS, 'pause manuelle plafonnée');
});

test('S35 : applyRoles — un membre du blrank reçoit un rôle restrictif (Muted, « non vérifié ») mais aucun autre', async () => {
  const added = [];
  const member = {
    id: '100000000000000016',
    guild: { id: G },
    client: { services: { blacklist: { isRankBlocked: () => true, restrictiveRoleIds: () => new Set(['muted']) } } },
    roles: { add: async (id) => { added.push(id); }, remove: async () => {} },
  };
  const out = await applyRoles(member, { add: ['muted', 'r1'] });
  assert.deepEqual(out.added, ['muted']);
  assert.deepEqual(out.skipped, ['r1']);
  assert.deepEqual(added, ['muted']);
  // Service en erreur : prudence, l'ajout reste bloqué.
  member.client.services.blacklist.restrictiveRoleIds = () => { throw new Error('boum'); };
  const out2 = await applyRoles(member, { add: ['muted'] });
  assert.deepEqual(out2.skipped, ['muted']);
});
