'use strict';

/**
 * Bout en bout : régressions de la revue n° 4 sur le vrai discord.js (starboard et salons
 * du staff, double clic sur « Envoyer maintenant », /role remove et rôles temporaires,
 * /role temporaire acquitté sous 3 s même avec une API lente).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const findButton = (m, prefix) => buttonsOf(m).find((c) => c.custom_id?.startsWith(prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAR = { id: null, name: '⭐' };

/** Messages publiés par le bot dans un salon depuis `mark`. */
function botMessagesIn(h, channelId, mark = 0) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}

/** Réactions ⭐ simulées (GET …/reactions/:emoji + MESSAGE_REACTION_ADD). */
function installReactions(h) {
  const users = new Map();
  h.fake.routes.unshift({
    method: 'GET',
    re: /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/,
    keys: ['channel', 'message', 'emoji'],
    handler: (p, call) => (call?.query?.type === '1' ? [] : [...(users.get(p.message) ?? [])].map((id) => h.fake.users.get(id)).filter(Boolean)),
  });
  return async (msg, as) => {
    const userId = IDS.users[as] ?? as;
    const set = users.get(msg.id) ?? new Set();
    users.set(msg.id, set.add(userId));
    const stored = h.fake.messages.get(msg.id);
    if (stored) stored.reactions = [{ emoji: STAR, count: set.size, count_details: { burst: 0, normal: set.size }, me: false, me_burst: false, burst_colors: [] }];
    h.fake.dispatchNow('MESSAGE_REACTION_ADD', { user_id: userId, channel_id: msg.channel_id, message_id: msg.id, guild_id: h.guild.id, emoji: STAR, burst: false, type: 0, member: h.fake.members.get(userId) }, `réaction ⭐ ${as}`);
    await h.settle();
  };
}

test('starboard : un message du salon #staff n\'est jamais reposté dans le starboard public', async () => {
  const h = await createHarness();
  h.configureAll();
  h.client.services.starboard.debounceMs = 10;
  h.client.services.starboard.minEditIntervalMs = 10;
  const react = installReactions(h);
  const board = IDS.channels.announcements;
  try {
    h.configure({ community: { starboard: { enabled: true, channelId: board, threshold: 2 } } });
    const secret = await h.userMessage({ as: 'mod', channel: 'staff', content: 'Discussion interne : sanction à venir' });
    for (const as of ['admin', 'owner', 'target']) await react(secret, as);
    const open = await h.userMessage({ as: 'member', content: 'Message public' });
    for (const as of ['admin', 'owner', 'target']) await react(open, as);
    await h.waitFor(() => botMessagesIn(h, board).length >= 1);
    await sleep(60);
    await h.settle();
    const cards = botMessagesIn(h, board);
    assert.equal(cards.length, 1, `cartes : ${cards.length}`);
    assert.match(cards[0].embeds[0].description, /Message public/);
    assert.ok(!cards.some((m) => /interne/.test(JSON.stringify(m.embeds))), 'contenu du salon #staff reposté');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/annonce : double clic sur « Envoyer maintenant » → une seule publication @everyone', async () => {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 20;
  h.fake.intendedPingLabels.push(/annonce/);
  try {
    const rec = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h'), opt('role', 8, IDS.guild)]), { as: 'owner' });
    const preview = await h.submitModal(rec, { titre: 'Annonce', message: 'Venez', couleur: '', image: '' }, { as: 'owner' });
    const pm = h.message(preview.original);
    await h.click(pm, findButton(pm, 'cmd:annonce:confirm:').custom_id, { as: 'owner' });
    const list = await h.slash('annonce', sub('liste'), { as: 'owner' });
    const lm = h.message(list.original);
    const send = findButton(lm, 'cmd:annonce:asend:').custom_id;
    const posts = () => h.fake.calls.filter((c) => c.route === `/channels/${IDS.channels.general}/messages` && c.method === 'POST' && c.body?.content === '@everyone');
    await Promise.all([h.click(lm, send, { as: 'owner' }), h.click(lm, send, { as: 'owner' })]);
    await h.settle();
    assert.equal(posts().length, 1, `publications : ${posts().length}`);
    const [row] = h.client.database.db.prepare('SELECT status, sent_count FROM scheduled_announcements').all();
    assert.deepEqual({ ...row }, { status: 'done', sent_count: 1 });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/role remove clôt le rôle temporaire : il n\'est pas rendu au retour du membre', async () => {
  const h = await createHarness();
  h.configureAll();
  const repo = h.client.repositories.tempRoles;
  try {
    const grant = await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '2h')]));
    assert.ok(!h.isError(grant), h.replyText(grant));
    assert.equal(repo.count(h.guild.id), 1);
    const removed = await h.slash('role', sub('remove', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer)]));
    assert.ok(!h.isError(removed), h.replyText(removed));
    assert.equal(repo.count(h.guild.id), 0, 'ligne active conservée après /role remove');
    const user = h.fake.users.get(IDS.users.target);
    await h.memberLeave(IDS.users.target);
    await h.memberJoin(user);
    await h.settle();
    assert.ok(!h.fake.members.get(IDS.users.target)?.roles.includes(IDS.roles.gamer), 'rôle retiré à la main rendu au retour');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/role temporaire et « Prolonger » : acquittés sous 3 s même quand l\'API est lente', async () => {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 1_600; // sans acquittement préalable : ajout + log + réponse = 4,8 s ; prolongation : log + mise à jour = 3,2 s
  try {
    const grant = await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '2h')]));
    assert.ok(!h.isError(grant), h.replyText(grant));
    const card = h.message(grant.original);
    assert.ok(findButton(card, 'cmd:role:textend:'), 'carte du rôle temporaire absente');
    const extend = await h.click(card, findButton(card, 'cmd:role:textend:').custom_id);
    await h.submitModal(extend, { duree: '1d' });
    await h.settle();
    assert.deepEqual(h.problems().late, []);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
