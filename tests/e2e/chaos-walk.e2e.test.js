'use strict';

/**
 * Revue par le chaos (2/2) : clics simultanés (double / triple clic, deux
 * administrateurs) sur les boutons des tableaux de bord et des cartes, puis marches
 * aléatoires reproductibles mêlant commandes, clics, formulaires et événements
 * (arrivées, départs, messages, suppressions de salons et de rôles configurés, perte
 * de permissions du bot), suivies d'un /diagnostics qui doit signaler les dégâts.
 *
 * Échantillon déterministe dans `npm test` ; tout explorer : `npm run test:chaos`
 * (graine : `CHAOS_SEED=1234 npm run test:chaos`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness');
const { leavesOf } = require('./lib/explore');
const C = require('./lib/chaos');
const { analyze } = require('../../src/commands/configuration/diagnostics');

const LONG = process.env.CHAOS_LONG === '1';
const SEED = C.seedFromEnv(20261009);
const replay = `rejouer : CHAOS_SEED=${SEED} npm run test:chaos`;
const DASHBOARDS = ['automod', 'logs', 'antiraid', 'tickets', 'bienvenue', 'niveaux', 'settings', 'tempvoice'];
/** Commandes à cartes cliquables (levées de sanction, verrouillages, giveaways, rôles…). */
const CARDS = ['mute', 'timeout', 'ban', 'warn', 'pseudo', 'lockall', 'unlockall', 'lock', 'giveaway', 'suggestion', 'rolemenu', 'role', 'reminder', 'backup', 'custom', 'sondage', 'pileface', 'diagnostics', 'sanctions', 'projet'];

async function setup(opts = {}) {
  const h = await createHarness(opts);
  h.configureAll();
  C.forbidHostilePings(h);
  return h;
}

/**
 * Cibles de clics (chaque bouton de chaque vue), découvertes sur un serveur neuf par
 * feuille. `names` null : toutes les commandes (sauf /massrole, aux lots espacés d'1 s).
 */
async function discover(names) {
  const probe = await createHarness();
  const commands = [...probe.client.commands.entries()].filter(([n]) => (names ? names.includes(n) : n !== 'massrole'));
  await probe.close();
  const targets = [];
  for (const [name, command] of commands) {
    for (const leaf of leavesOf(command.data.toJSON())) {
      const h = await setup();
      try {
        targets.push(...await C.raceTargets(h, name, leaf));
      } finally {
        await h.close();
      }
    }
  }
  return targets;
}

test(`clics simultanés : triple clic sur chaque bouton, puis deux administrateurs à la fois (graine ${SEED})`, async (t) => {
  const rng = new C.Rng(SEED);
  const names = LONG ? null : [...DASHBOARDS, ...rng.sample(CARDS, 6)];
  const targets = await discover(names);
  const chosen = LONG ? targets : rng.sample(targets, 36);
  const failures = [];
  let skipped = 0;
  for (const target of chosen) {
    const r = await C.checkRace(setup, target, { clicks: 3 });
    if (r.skipped) skipped += 1;
    else if (r.problems.length || r.diff.length) failures.push({ seed: SEED, target: `/${target.key} ${target.steps.join(' > ')}`, problems: [...r.diff, ...r.problems].join('\n') });
  }
  // Deux administrateurs, chacun sur son tableau de bord, cliquent le même bouton (et soumettent le même formulaire).
  const dashboards = targets.filter((x) => DASHBOARDS.includes(x.name));
  const pairs = LONG ? dashboards : rng.sample(dashboards, 10);
  for (const target of pairs) {
    const r = await C.checkRace(setup, target, { actors: ['admin', 'owner'], clicks: 2 });
    if (r.skipped) skipped += 1;
    else if (r.problems.length || r.diff.length) failures.push({ seed: SEED, target: `/${target.key} ${target.steps.join(' > ')} (2 admins)`, problems: [...r.diff, ...r.problems].join('\n') });
    const m = await C.checkModalRace(setup, target, { rng: rng.fork(target.steps.join('>')) });
    if (m.problems) failures.push({ seed: SEED, target: `/${target.key} ${target.steps.join(' > ')} (formulaires simultanés)`, problems: m.problems });
  }
  t.diagnostic(`graine ${SEED} · ${targets.length} boutons découverts · ${chosen.length} triples clics · ${pairs.length} doubles admins · ${skipped} ignorés`);
  assert.ok(chosen.length - skipped >= Math.min(15, chosen.length), `${skipped} cibles ignorées sur ${chosen.length}`);
  assert.equal(failures.length, 0, `${C.formatFailures(failures)}\n${replay}`);
});

/** Libellé /diagnostics attendu pour une référence de configuration devenue orpheline. */
function expectedLabel(path, cfg) {
  const rules = [
    [/^logChannels\.(\w+)$/, (m) => `Logs « ${m[1]} »`],
    [/^antiraid\.alertChannel$/, () => 'Alertes AntiRaid'],
    [/^tickets\.categoryId$/, () => 'Catégorie des tickets'],
    [/^tickets\.logChannel$/, () => 'Transcripts des tickets'],
    [/^tickets\.panelChannelId$/, () => 'Panneau des tickets'],
    [/^tickets\.supportRoleIds?(\[\d+\])?$/, () => 'Rôle staff des tickets'],
    [/^modmail\.categoryId$/, () => 'Catégorie du modmail'],
    [/^modmail\.logChannel$/, () => 'Transcripts du modmail'],
    [/^modmail\.staffRoleId$/, () => 'Rôle staff du modmail'],
    [/^suggestions\.channelId$/, () => 'Salon des suggestions'],
    [/^projects\.channelId$/, () => 'Salon des projets'],
    [/^welcome\.join\.channelId$/, () => 'Salon de bienvenue'],
    [/^welcome\.leave\.channelId$/, () => 'Salon des départs'],
    [/^welcome\.verification\.channelId$/, () => 'Salon de vérification'],
    [/^welcome\.verification\.roleId$/, () => 'Rôle de vérification'],
    [/^welcome\.autoRoles\.humans\[\d+\]$/, () => 'Rôle auto (membres)'],
    [/^welcome\.autoRoles\.bots\[\d+\]$/, () => 'Rôle auto (bots)'],
    [/^levels\.rewards\[\d+\]\.roleId$/, () => 'Récompense niveau'],
    [/^levels\.announce\.channelId$/, () => (cfg.levels?.announce?.mode === 'channel' ? 'Annonces de niveau' : null)],
    [/^moderation\.mutedRoleId$/, () => 'Rôle muet'],
    [/^logs\.staffRoleId$/, () => 'Rôle staff des logs'],
    [/^projects\.managerRoleId$/, () => 'Rôle gestionnaire des projets'],
    [/^tempVoice\.hubChannelId$/, () => (cfg.tempVoice?.enabled ? 'Salon « Créer un vocal »' : null)],
    [/^tempVoice\.categoryId$/, () => (cfg.tempVoice?.enabled ? 'Catégorie des vocaux temporaires' : null)],
  ];
  for (const [re, label] of rules) {
    const m = re.exec(path);
    if (m) return { label: label(m) };
  }
  return null; // listes d'exemptions, réglages secondaires : non contrôlés par /diagnostics
}

for (const [mode, harness, seedOffset] of [['gros serveur', { big: true }, 0], ['bot sans droits', { botAdministrator: false, restrictBot: true }, 1]]) {
  test(`marche aléatoire — ${mode} (graine ${SEED + seedOffset})`, async (t) => {
    const seeds = LONG ? [0, 2, 4].map((k) => SEED + seedOffset + k) : [SEED + seedOffset];
    const failures = [];
    let actions = 0;
    const kinds = {};
    const uncovered = new Set();
    for (const seed of seeds) {
      const h = await setup(harness);
      try {
        const r = await C.randomWalk(h, { rng: new C.Rng(seed), steps: LONG ? 500 : 250, failures, seed, collectorRate: LONG ? 0.25 : 0.03 });
        actions += r.actions;
        for (const [k, n] of Object.entries(r.kinds)) kinds[k] = (kinds[k] ?? 0) + n;

        // /diagnostics : chaque salon ou rôle configuré puis supprimé doit être signalé.
        const cfg = h.client.services.config.get(h.guild.id);
        const checks = analyze(h.guild, cfg).flatMap((g) => g.checks).filter((c) => c.level === 'fail').map((c) => c.text);
        for (const { path } of C.danglingRefs(h)) {
          const expected = expectedLabel(path, cfg);
          if (!expected) uncovered.add(path.replace(/\[\d+\]/g, '[]'));
          else if (expected.label && !checks.some((c) => c.startsWith(expected.label))) {
            failures.push({ seed, diagnostics: path, problems: `/diagnostics ne signale pas « ${expected.label} » (référence orpheline ${path})` });
          }
        }
        const channel = [...h.fake.channels.values()].find((c) => c.type === 0 && h.client.channels.cache.has(c.id))?.id;
        await C.step(h, failures, { seed, kind: '/diagnostics final' }, async () => {
          const rec = await h.slash('diagnostics', [], { as: 'owner', channel });
          if (checks.length && !/Problèmes détectés/.test(h.replyText(rec))) throw new Error(`diagnostic sans alerte malgré ${checks.length} erreur(s) : ${h.replyText(rec).slice(0, 200)}`);
        });
      } finally {
        await h.close();
      }
    }
    t.diagnostic(`graines ${seeds.join(', ')} · ${actions} actions · ${JSON.stringify(kinds)}${uncovered.size ? ` · références orphelines hors diagnostic : ${[...uncovered].join(', ')}` : ''}`);
    assert.ok(actions >= seeds.length * 80, `${actions} actions exécutées`);
    assert.equal(failures.length, 0, `${C.formatFailures(failures)}\n${replay}`);
  });
}
