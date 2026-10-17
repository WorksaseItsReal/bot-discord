'use strict';

/**
 * Revue par le chaos (1/2) : fuzz des options de CHAQUE commande et des formulaires
 * avec des valeurs limites et hostiles, puis non-régressions des bugs trouvés ainsi.
 *
 * Rapide et déterministe dans `npm test` (échantillon, graine fixe) ; version longue :
 * `npm run test:chaos` (toutes les valeurs, plusieurs rôles et serveurs), graine
 * modifiable : `CHAOS_SEED=1234 npm run test:chaos`.
 * Échec : « erreur inattendue », rejet non géré, interaction non acquittée, limite
 * Discord dépassée, texte suspect (undefined, NaN…), mention de masse effective.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { leavesOf, runLeaf } = require('./lib/explore');
const { OVERRIDES } = require('./lib/overrides');
const C = require('./lib/chaos');

const LONG = process.env.CHAOS_LONG === '1';
const SEED = C.seedFromEnv(20261009);
const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const replay = `rejouer : CHAOS_SEED=${SEED} npm run test:chaos`;

async function setup(opts = {}) {
  const h = await createHarness(opts);
  h.configureAll();
  C.forbidHostilePings(h);
  return h;
}

test(`fuzz des options de chaque commande (graine ${SEED})`, async (t) => {
  const profiles = LONG
    ? [
      { as: 'admin', harness: {} },
      { as: 'member', harness: {} },
      { as: 'owner', harness: {} },
      { as: 'mod', harness: { big: true } },
      { as: 'admin', harness: { botAdministrator: false, restrictBot: true } },
    ]
    : [{ as: 'admin', harness: {} }];
  const failures = [];
  let actions = 0;
  const rng = new C.Rng(SEED);
  const probe = await createHarness();
  const names = [...probe.client.commands.keys()];
  await probe.close();
  for (const profile of profiles) {
    for (const name of names) {
      // Un serveur neuf par commande : un échec se rejoue avec la graine et le nom seuls.
      const h = await setup(profile.harness);
      try {
        actions += await C.fuzzCommand(h, name, h.client.commands.get(name), {
          rng: rng.fork(`${profile.as}:${name}`),
          perOption: LONG ? Infinity : 4,
          combos: LONG ? 4 : 2,
          as: profile.as,
          failures,
          seed: SEED,
          exploreBudget: LONG ? 5 : 0,
        });
      } finally {
        await h.close();
      }
    }
  }
  t.diagnostic(`graine ${SEED} · ${actions} interactions hostiles sur ${names.length} commandes · ${profiles.length} profil(s)`);
  assert.equal(failures.length, 0, `${C.formatFailures(failures)}\n${replay}`);
});

test(`fuzz des formulaires des tableaux de bord et cartes (graine ${SEED})`, async (t) => {
  const failures = [];
  let actions = 0;
  let modals = 0;
  const rng = new C.Rng(SEED);
  const probe = await createHarness();
  const names = [...probe.client.commands.keys()].filter((n) => LONG || ['automod', 'logs', 'antiraid', 'tickets', 'bienvenue', 'niveaux', 'tempvoice', 'sanctions', 'projet', 'embed'].includes(n));
  await probe.close();
  for (const name of names) {
    const h = await setup();
    try {
      for (const leaf of leavesOf(h.client.commands.get(name).data.toJSON())) {
        const key = [name, ...leaf.path].join(' ');
        const rec = await runLeaf(h, name, leaf, { overrides: OVERRIDES[key] ?? {} });
        const r = await C.fuzzModals(h, rec, { rng: rng.fork(key), failures, seed: SEED, perField: LONG ? Infinity : 2, budget: LONG ? 200 : 60, label: `/${key}` });
        actions += r.actions;
        modals += r.modals;
      }
    } finally {
      await h.close();
    }
  }
  t.diagnostic(`graine ${SEED} · ${modals} formulaires · ${actions} actions`);
  assert.ok(modals >= 10, `${modals} formulaires rencontrés`);
  assert.equal(failures.length, 0, `${C.formatFailures(failures)}\n${replay}`);
});

/* ---------------------------------------------------------------------- */
/* Non-régressions                                                          */
/* ---------------------------------------------------------------------- */

test('régression : « constructor » / « __proto__ » / « toString » dans une option texte n\'empoisonnent plus les caches (events/interactionGuard.js)', async () => {
  const h = await setup();
  try {
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      // Une option utilisateur fournit des données « resolved » ; discord.js y cherchait
      // aussi la valeur de l'option texte (Object.prototype pour ces mots).
      await h.slash('warn', [opt('membre', 6, IDS.users.target), opt('raison', 3, value)], { as: 'mod' });
      await h.slash('role', sub('add', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer)]));
    }
    assert.ok(![...h.guild.roles.cache.values()].some((r) => !r.id), 'rôle sans identifiant dans le cache');
    assert.ok(![...h.client.users.cache.values()].some((u) => !u.id), 'utilisateur sans identifiant dans le cache');
    assert.ok(![...h.guild.members.cache.values()].some((m) => !m.id), 'membre sans identifiant dans le cache');
    assert.ok(![...h.client.channels.cache.values()].some((c) => !c.id), 'salon sans identifiant dans le cache');
    // Avant le correctif : « Cannot convert undefined to a BigInt » jusqu'au redémarrage.
    for (const [name, options] of [['roles', []], ['role', sub('list')], ['diagnostics', []], ['serverinfo', []], ['inrole', [opt('role', 8, IDS.roles.member)]]]) {
      const rec = await h.slash(name, options);
      assert.ok(!h.isError(rec), `/${name} : ${h.replyText(rec)}`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('régression : un texte fait d\'espaces ne produit plus de champ ni de pied de page vides (ui.field/card, /embed)', async () => {
  const h = await setup();
  try {
    for (const blank of [' ', '\u3000\u3000', '\n \t']) {
      await h.slash('warn', [opt('membre', 6, IDS.users.target), opt('raison', 3, blank)], { as: 'mod' });
      await h.slash('8ball', [opt('question', 3, blank)]);
      await h.slash('embed', sub('send', [opt('titre', 3, 'Annonce'), opt('footer', 3, blank)]));
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/** Messages publiés dans #logs depuis `mark` dont le titre contient `text`. */
const logged = (h, mark, text) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs && (m.embeds?.[0]?.title ?? '').includes(text));
const button = (msg, prefix) => (msg?.components ?? []).flatMap((r) => r.components).find((c) => c.custom_id?.startsWith(prefix));

test('régression : triple clic sur « Démuter » / « Retirer le timeout » : une seule levée, un seul log (ModerationService.revokeHandler)', async () => {
  const h = await setup();
  h.fake.latency = 2;
  try {
    for (const [command, options, prefix, title] of [
      ['mute', [opt('membre', 6, IDS.users.target), opt('duree', 3, '1h')], 'cmd:unmute:revoke:', 'Mute retiré'],
      ['timeout', [opt('membre', 6, IDS.users.member), opt('duree', 3, '10m')], 'cmd:untimeout:revoke:', 'Timeout retiré'],
    ]) {
      const rec = await h.slash(command, options, { as: 'mod' });
      const card = h.messagesOf(rec).find((m) => button(m, prefix));
      assert.ok(card, `/${command} : bouton de levée absent`);
      const mark = h.fake.messageLog.length;
      const clicks = await Promise.all([1, 2, 3].map(() => h.click(card, button(card, prefix).custom_id, { as: 'mod' })));
      await h.settle();
      assert.equal(logged(h, mark, title).length, 1, `/${command} : « ${title} » journalisé ${logged(h, mark, title).length} fois`);
      assert.equal(clicks.filter((c) => h.isError(c)).length, 2, 'les clics en double doivent être refusés poliment');
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('régression : verrouillage global cliqué trois fois puis levé : un seul log, état d\'origine restauré (LockdownService)', async () => {
  const h = await setup();
  h.configure({ moderation: { confirmDangerous: false } });
  h.fake.latency = 2;
  const state = () => JSON.stringify([...h.fake.channels.values()].map((c) => [c.id, (c.permission_overwrites ?? []).filter((o) => o.allow !== '0' || o.deny !== '0').map((o) => [o.id, o.allow, o.deny]).sort()]));
  try {
    const before = state();
    const rec = await h.slash('unlockall');
    const card = h.messagesOf(rec).find((m) => button(m, 'cmd:lockall:run:'));
    assert.ok(card, 'bouton « Tout verrouiller » absent');
    const mark = h.fake.messageLog.length;
    await Promise.all([1, 2, 3].map(() => h.click(card, button(card, 'cmd:lockall:run:').custom_id)));
    await h.settle();
    assert.equal(logged(h, mark, 'Lockdown activé').length, 1, 'lockdown journalisé plusieurs fois');
    assert.ok(h.client.services.lockdown.status(h.guild) > 0, 'aucun salon verrouillé');
    // Levée et verrouillage simultanés : l'un attend, l'état reste cohérent.
    await Promise.all([h.slash('unlockall'), h.slash('lockall', [], { as: 'owner' })]);
    await h.slash('unlockall');
    assert.equal(h.client.services.lockdown.status(h.guild), 0);
    assert.equal(state(), before, 'permissions des salons non restaurées à l\'identique');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('régression : double clic sur « Créer le salon créateur » : un seul salon (tempvoice createhub)', async () => {
  const h = await setup();
  h.fake.latency = 2;
  try {
    const dash = await h.slash('tempvoice', sub('config'));
    const view = await h.click(h.message(dash.original), 'cmd:tempvoice:nav', { values: ['salons'] });
    const msg = h.message(view.componentMessageId);
    const hubs = () => [...h.fake.channels.values()].filter((c) => c.name === '➕ Créer un vocal').length;
    const before = hubs();
    await Promise.all([1, 2, 3].map(() => h.click(msg, 'cmd:tempvoice:createhub')));
    await h.settle();
    assert.equal(hubs(), before + 1, `${hubs() - before} salons créateurs créés`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('régression : /diagnostics signale la catégorie des vocaux temporaires et le rôle gestionnaire des projets supprimés', async () => {
  const h = await setup();
  try {
    h.configure({ projects: { managerRoleId: IDS.roles.temp } });
    h.fake.deleteChannel(IDS.channels.catVoice);
    h.fake.deleteRole(IDS.roles.temp);
    await h.settle();
    const rec = await h.slash('diagnostics');
    const text = h.messagesOf(rec).flatMap((m) => m.embeds ?? []).flatMap((e) => (e.fields ?? []).map((f) => f.value)).join('\n');
    assert.match(text, /Catégorie des vocaux temporaires : salon introuvable/);
    assert.match(text, /Rôle gestionnaire des projets : rôle introuvable/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('auto-test du harnais : mention de masse effective détectée, mention neutralisée ignorée', async () => {
  const h = await createHarness();
  try {
    const channel = h.client.channels.cache.get(IDS.channels.general);
    await channel.send({ content: '@everyone regardez', allowedMentions: { parse: ['everyone'] } });
    await channel.send({ content: `<@&${IDS.roles.notif}> annonce`, allowedMentions: { parse: ['roles'] } });
    assert.equal(h.problems().massMentions.length, 2, h.formatProblems());
    h.resetProblems();
    // Comportement par défaut du client (parse: ['users']) et liste de rôles explicite : pas de ping de masse.
    await channel.send({ content: '@everyone et <@&' + IDS.roles.admin + '>' });
    await channel.send({ content: `<@&${IDS.roles.notif}>`, allowedMentions: { roles: [IDS.roles.notif] } });
    assert.equal(h.problemCount(), 0, h.formatProblems());
    // Rôle injecté dans une saisie : interdit même dans une liste explicite.
    h.fake.forbiddenPings.add(IDS.roles.notif);
    await channel.send({ content: `<@&${IDS.roles.notif}>`, allowedMentions: { roles: [IDS.roles.notif] } });
    assert.equal(h.problems().massMentions.length, 1);
    h.resetProblems();
  } finally {
    await h.close();
  }
});
