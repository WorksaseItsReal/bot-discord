'use strict';

/**
 * Bout en bout : réactions automatiques par salon (/communaute › Réactions automatiques) sur le
 * vrai discord.js. Messages, forum et changements de permissions passent par la passerelle réelle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { nextId } = require('./lib/ids');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Réactions posées par le bot depuis `mark` : [{ message, emoji }] dans l'ordre. */
const reactionsSince = (h, mark) => h.fake.calls.slice(mark)
  .filter((c) => c.method === 'PUT' && /\/reactions\/[^/]+\/@me$/.test(c.route))
  .map((c) => {
    const parts = c.route.split('/'); // ['', 'channels', salon, 'messages', message, 'reactions', emoji, '@me']
    return { message: parts[4], emoji: decodeURIComponent(parts[6]) };
  });

/** Configure les réactions d'un salon par le tableau de bord (sélecteur → formulaire → activation). */
async function setupByDashboard(h, channelId, emojis) {
  const dash = await h.slash('communaute');
  const view = await h.click(h.messagesOf(dash)[0], 'cmd:communaute:nav', { values: ['react'] });
  const add = await h.click(h.messagesOf(view)[0], 'cmd:communaute:rxadd', { values: [channelId] });
  assert.equal(add.modals.length, 1, 'formulaire des emojis');
  const created = await h.submitModal(add, { emojis });
  assert.match(h.replyText(created), /Réactions ajoutées/);
  const on = await h.click(h.messagesOf(created)[0], 'cmd:communaute:go:react');
  await h.click(h.messagesOf(on)[0], 'cmd:communaute:rxtoggle:on:react');
  return h.client.services.config.get(h.guild.id).autoReact;
}

function fastReactions(h) {
  const svc = h.client.services.autoResponses;
  svc.delayMs = 30;
  svc.reactGapMs = 2;
  return svc;
}

test('/communaute › Réactions automatiques : chaque vue, menu, formulaire ; refus sans permission', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('communaute');
    const stats = await explore(h, rec, { budget: 300 });
    assert.ok(stats.navChosen.has('cmd:communaute:nav=react'), 'vue Réactions automatiques jamais ouverte');
    for (const key of ['rxadd', 'rxtoggle']) assert.ok(stats.keys.has(`cmd:communaute:${key}`), `${key} jamais utilisé`);
    // Vue détaillée d'un salon : mode, emojis, fils, retrait.
    const cfg = await setupByDashboard(h, IDS.channels.general, `👍 :gadget: <:gadget:${IDS.emoji}>`);
    assert.deepEqual(cfg.channels[0].emojis, ['👍', `<:gadget:${IDS.emoji}>`], ':nom: résolu, doublon retiré');
    assert.equal(cfg.enabled, true);
    const dash = await h.slash('communaute');
    const list = await h.click(h.messagesOf(dash)[0], 'cmd:communaute:nav', { values: ['react'] });
    const detail = await h.click(h.messagesOf(list)[0], 'cmd:communaute:rxpick', { values: [IDS.channels.general] });
    const walked = await explore(h, detail, { budget: 60, skip: (a) => a.customId.startsWith('cmd:communaute:rxdel') || a.customId === 'cmd:communaute:go:react' || a.customId === 'cmd:communaute:nav' });
    for (const key of ['rxmode', 'rxemojis', 'rxthreads']) assert.ok(walked.keys.has(`cmd:communaute:${key}`), `${key} jamais utilisé`);
    // Saisies refusées : emoji d'un autre serveur, plus de 3 emojis.
    const again = await h.click(h.messagesOf(detail)[0], `cmd:communaute:rxemojis:${IDS.channels.general}`);
    const foreign = await h.submitModal(again, { emojis: '<:ailleurs:123456789012345678>' });
    assert.ok(h.isError(foreign), 'emoji d\'un autre serveur refusé');
    const many = await h.submitModal(again, { emojis: '👍 👎 ❤️ 🎉' });
    assert.ok(h.isError(many), 'plus de 3 emojis refusés');
    h.resetProblems();

    // Membre sans « Gérer le serveur » : commande et composants refusés, rien ne change.
    const denied = await h.slash('communaute', [], { as: 'member' });
    assert.ok(h.isError(denied));
    const admin = await h.slash('communaute');
    const reactView = await h.click(h.messagesOf(admin)[0], 'cmd:communaute:nav', { values: ['react'] });
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).autoReact);
    await explore(h, reactView, { as: 'member', budget: 25 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).autoReact), before, 'un membre a modifié la configuration');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('message du salon → réactions dans l\'ordre ; bot, supprimé avant le délai, autre salon → rien', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await setupByDashboard(h, IDS.channels.general, `👍 <:gadget:${IDS.emoji}> 👎`);
    fastReactions(h);
    let mark = h.fake.calls.length;
    const msg = await h.userMessage({ as: 'member', content: 'Voici ma suggestion' });
    assert.ok(await h.waitFor(() => reactionsSince(h, mark).length === 3));
    assert.deepEqual(reactionsSince(h, mark).map((r) => r.emoji), ['👍', `gadget:${IDS.emoji}`, '👎'], 'ordre des réactions');
    assert.ok(reactionsSince(h, mark).every((r) => r.message === msg.id));

    mark = h.fake.calls.length;
    await h.userMessage({ as: 'otherBot', content: 'Message d\'un bot' });
    const gone = await h.userMessage({ as: 'member', content: 'Message vite supprimé' });
    await h.deleteUserMessage(gone.id);
    await h.userMessage({ as: 'member', channel: 'rules', content: 'Autre salon' });
    await sleep(120);
    await h.settle();
    assert.equal(reactionsSince(h, mark).length, 0, 'aucune réaction attendue');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('forum : réaction au message d\'ouverture de chaque post, pas aux réponses', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await setupByDashboard(h, IDS.channels.forum, '💡');
    fastReactions(h);
    const postId = nextId();
    const thread = {
      id: postId,
      type: 11,
      guild_id: h.guild.id,
      parent_id: IDS.channels.forum,
      name: 'Une idée',
      owner_id: IDS.users.member,
      rate_limit_per_user: 0,
      message_count: 0,
      member_count: 1,
      total_message_sent: 0,
      last_message_id: null,
      flags: 0,
      applied_tags: [],
      thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false },
    };
    h.fake.channels.set(postId, thread);
    h.fake.dispatchNow('THREAD_CREATE', { ...thread, newly_created: true });
    await h.settle();
    const author = h.fake.users.get(IDS.users.member);
    const starter = h.fake.buildMessage({ channelId: postId, body: { content: 'Ajouter un mode sombre' }, author });
    h.fake.messages.delete(starter.id);
    starter.id = postId; // le message d'ouverture d'un post porte l'identifiant du fil
    h.fake.messages.set(postId, starter);
    const member = { ...h.fake.members.get(IDS.users.member), user: undefined };
    const mark = h.fake.calls.length;
    h.fake.dispatchNow('MESSAGE_CREATE', { ...starter, member, channel_type: 11 });
    assert.ok(await h.waitFor(() => reactionsSince(h, mark).length === 1));
    assert.deepEqual(reactionsSince(h, mark), [{ message: postId, emoji: '💡' }]);
    await h.userMessage({ as: 'member', channel: postId, content: 'Bonne idée !' });
    await sleep(100);
    await h.settle();
    assert.equal(reactionsSince(h, mark).length, 1, 'réponse dans le post : aucune réaction');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('bot sans « Ajouter des réactions » : rien, avertissement ; 50 messages → 20 au plus en attente', async () => {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  try {
    await setupByDashboard(h, IDS.channels.general, '👍');
    const svc = fastReactions(h);
    // Surcharge du salon : le bot perd « Ajouter des réactions » (CHANNEL_UPDATE réel).
    const general = h.fake.channels.get(IDS.channels.general);
    general.permission_overwrites = [...general.permission_overwrites, { id: IDS.roles.bot, type: 0, allow: '0', deny: P.AddReactions.toString() }];
    h.fake.dispatchNow('CHANNEL_UPDATE', { ...general });
    await h.settle();
    let mark = h.fake.calls.length;
    await h.userMessage({ as: 'member', content: 'Pas de réaction possible' });
    await sleep(100);
    await h.settle();
    assert.equal(reactionsSince(h, mark).length, 0, 'aucune requête sans la permission');
    const dash = await h.slash('communaute');
    const view = await h.click(h.messagesOf(dash)[0], 'cmd:communaute:nav', { values: ['react'] });
    assert.match(h.replyText(view), /Ajouter des réactions/, 'avertissement de permission');

    // Permission rendue, puis rafale de 50 messages : 20 en attente au plus dans le salon.
    general.permission_overwrites = general.permission_overwrites.filter((o) => o.id !== IDS.roles.bot);
    h.fake.dispatchNow('CHANNEL_UPDATE', { ...general });
    await h.settle();
    svc.delayMs = 60_000;
    for (let i = 0; i < 50; i += 1) {
      await h.userMessage({ as: 'member', content: `Message ${i}` });
      assert.ok(svc.reactionStats(h.guild.id).pending <= 20);
    }
    assert.equal(svc.reactionStats(h.guild.id).pending, 20);
    assert.equal(svc.reactionStats(h.guild.id).dropped, 30);
    const full = await h.slash('communaute');
    const fullView = await h.click(h.messagesOf(full)[0], 'cmd:communaute:nav', { values: ['react'] });
    assert.match(JSON.stringify(h.messagesOf(fullView)[0].embeds[0].fields), /30 \(file pleine\)/);
    mark = h.fake.calls.length;
    svc.stop();
    await sleep(30);
    assert.equal(reactionsSince(h, mark).length, 0, 'arrêt : file abandonnée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
