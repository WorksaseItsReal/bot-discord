'use strict';

/**
 * Bout en bout : ghostping d'arrivée (/bienvenue › Ghostping) sur le vrai discord.js. Arrivées,
 * vérification et vague d'arrivées passent par la passerelle réelle ; arrêt du bot pendant l'attente.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Messages de ghostping (mention seule, sans embed) affichés pour un membre. */
const ghostIds = (h, userId) => h.fake.messageLog.filter((id) => {
  const m = h.message(id);
  return m && m.content === `<@${userId}>` && !m.embeds?.length;
});
/** Messages du bot qui ne contiennent QUE des mentions d'utilisateurs (ghostpings), depuis `mark`. */
const ghostPosts = (h, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.route) && /^(<@\d+>\s?)+$/.test(c.body?.content ?? '') && !c.body?.embeds?.length);

/** Ghostping réglé par le tableau de bord : salons, délai, activation. */
async function setupByDashboard(h, channels = [IDS.channels.general], seconds = '1') {
  const dash = await h.slash('bienvenue');
  const view = await h.click(h.messagesOf(dash)[0], 'cmd:bienvenue:nav', { values: ['ghostping'] });
  const picked = await h.click(h.messagesOf(view)[0], 'cmd:bienvenue:gpchannels', { values: channels });
  const delay = await h.click(h.messagesOf(picked)[0], 'cmd:bienvenue:gpdelay');
  await h.submitModal(delay, { seconds });
  const on = await h.click(h.messagesOf(picked)[0], 'cmd:bienvenue:gptoggle:on');
  assert.match(h.replyText(on), /Ghostping \*\*activé\*\*/);
  const svc = h.client.services.ghostPing;
  svc.batchMs = 40;
  return svc;
}

test('/bienvenue › Ghostping : chaque vue, menu, formulaire ; refus sans permission', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('bienvenue');
    const stats = await explore(h, rec, { budget: 300 });
    assert.ok(stats.navChosen.has('cmd:bienvenue:nav=ghostping'), 'vue Ghostping jamais ouverte');
    const dash = await h.slash('bienvenue');
    const view = await h.click(h.messagesOf(dash)[0], 'cmd:bienvenue:nav', { values: ['ghostping'] });
    const walked = await explore(h, view, { budget: 40, skip: (a) => a.customId === 'cmd:bienvenue:nav' || a.customId === 'cmd:bienvenue:go:home' });
    for (const key of ['gpchannels', 'gpverify', 'gpdelay']) assert.ok(walked.keys.has(`cmd:bienvenue:${key}`), `${key} jamais utilisé`);
    // Saisies refusées : délai hors bornes, activation sans salon.
    const delay = await h.click(h.messagesOf(view)[0], 'cmd:bienvenue:gpdelay');
    assert.ok(h.isError(await h.submitModal(delay, { seconds: '30' })), 'délai de 30 s refusé');
    h.configure({ ghostPing: { channels: [], enabled: false } });
    const empty = await h.click(h.messagesOf(view)[0], 'cmd:bienvenue:gptoggle:on');
    assert.ok(h.isError(empty), 'activation sans salon refusée');
    h.resetProblems();

    const denied = await h.slash('bienvenue', [], { as: 'member' });
    assert.ok(h.isError(denied));
    const admin = await h.slash('bienvenue');
    const gpView = await h.click(h.messagesOf(admin)[0], 'cmd:bienvenue:nav', { values: ['ghostping'] });
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).ghostPing);
    await explore(h, gpView, { as: 'member', budget: 20 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).ghostPing), before, 'un membre a modifié la configuration');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('arrivée → POST de la mention (allowed_mentions limité), puis DELETE ; jamais pour un bot', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await setupByDashboard(h, [IDS.channels.general, IDS.channels.rules]);
    let mark = h.fake.calls.length;
    const user = h.addUser('Nouvelle');
    await h.memberJoin(user);
    assert.ok(await h.waitFor(() => ghostPosts(h, mark).length === 2));
    for (const call of ghostPosts(h, mark)) {
      assert.equal(call.body.content, `<@${user.id}>`);
      assert.deepEqual(call.body.allowed_mentions, { users: [user.id], parse: [] });
    }
    const ids = ghostIds(h, user.id);
    assert.equal(ids.length, 2);
    // Suppression 1 s plus tard (sans log « Message supprimé »).
    const logsBefore = h.fake.calls.filter((c) => c.method === 'POST' && c.body?.embeds?.some((e) => /Message supprimé/.test(e.title ?? ''))).length;
    assert.ok(await h.waitFor(() => ids.every((id) => !h.message(id)), { timeout: 2_500 }), 'mentions non supprimées');
    await h.settle();
    const deletes = h.fake.calls.slice(mark).filter((c) => c.method === 'DELETE' && ids.some((id) => c.route.endsWith(`/messages/${id}`)));
    assert.equal(deletes.length, 2);
    assert.equal(h.fake.calls.filter((c) => c.method === 'POST' && c.body?.embeds?.some((e) => /Message supprimé/.test(e.title ?? ''))).length, logsBefore, 'aucun log de suppression');

    mark = h.fake.calls.length;
    h.configure({ antiraid: { antiBot: false } });
    await h.memberJoin(h.addUser('RobotAmi', { bot: true }));
    await sleep(80);
    await h.settle();
    assert.equal(ghostPosts(h, mark).length, 0, 'bot : aucun ghostping');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('mode vérification : aucun ping à l\'arrivée, ping après la vérification réussie', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await setupByDashboard(h);
    h.configure({ welcome: { verification: { enabled: true, roleId: IDS.roles.notif, channelId: IDS.channels.rules, captcha: false } } });
    const dash = await h.slash('bienvenue');
    const nav = await h.click(h.messagesOf(dash)[0], 'cmd:bienvenue:nav', { values: ['verify'] });
    await h.click(h.messagesOf(nav)[0], 'cmd:bienvenue:publish');
    const panel = h.fake.messageLog.map((id) => h.message(id)).find((m) => m?.components?.some((r) => r.components.some((c) => c.custom_id === 'cmd:bienvenue:verify')));
    assert.ok(panel, 'panneau publié');
    let mark = h.fake.calls.length;
    const user = h.addUser('Arrivant');
    await h.memberJoin(user);
    await sleep(100);
    await h.settle();
    assert.equal(ghostPosts(h, mark).length, 0, 'pas de ping avant la vérification');
    mark = h.fake.calls.length;
    const verified = await h.click(panel, 'cmd:bienvenue:verify', { as: user.id });
    assert.match(h.replyText(verified), /Vérification réussie/);
    assert.ok(await h.waitFor(() => ghostPosts(h, mark).length === 1));
    assert.equal(ghostPosts(h, mark)[0].body.content, `<@${user.id}>`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('raid : vague détectée par l\'AntiRaid → aucun ping ; arrêt pendant l\'attente → DELETE immédiat', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await setupByDashboard(h);
    let mark = h.fake.calls.length;
    // configureAll : AntiRaid à 3 arrivées en 10 s, action « kick ».
    for (const name of ['Raid1', 'Raid2', 'Raid3', 'Raid4']) await h.memberJoin(h.addUser(name));
    await sleep(120);
    await h.settle();
    assert.equal(ghostPosts(h, mark).length, 0, 'aucun ghostping pendant une vague');
    assert.ok(h.client.services.antiraid.joinAlertAt.get(h.guild.id), 'vague bien détectée');

    // Fin de la vague (plus de 60 s) : ping normal, délai long, puis arrêt du bot.
    h.client.services.antiraid.joinAlertAt.set(h.guild.id, Date.now() - 120_000);
    h.client.services.welcome.waves.clear();
    h.configure({ ghostPing: { deleteAfterSeconds: 10 } });
    mark = h.fake.calls.length;
    const user = h.addUser('Patient');
    await h.memberJoin(user);
    assert.ok(await h.waitFor(() => ghostPosts(h, mark).length === 1));
    const [id] = ghostIds(h, user.id);
    assert.ok(id && h.message(id), 'mention affichée');
    const t0 = Date.now();
    await h.client.services.ghostPing.stop();
    assert.ok(Date.now() - t0 < 1_000, 'arrêt borné');
    assert.equal(h.message(id), null, 'mention supprimée dès l\'arrêt');
    assert.ok(h.fake.calls.some((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${id}`)));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
