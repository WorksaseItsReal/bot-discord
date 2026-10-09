'use strict';

/**
 * Bout en bout : communauté (starboard, messages épinglés automatiquement, réponses
 * automatiques) sur le vrai discord.js. Réactions, messages, suppressions et
 * redémarrage passent par les handlers réels de la passerelle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { StickyService } = require('../../src/services/StickyService');

const G = () => IDS.channels;
const STAR = { id: null, name: '⭐' };

/** Messages publiés par le bot dans un salon depuis `mark` (position dans messageLog). */
function botMessagesIn(h, channelId, mark = 0) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}

/**
 * Réactions simulées : le faux Discord tient la liste des utilisateurs par (message, emoji)
 * et répond à GET …/reactions/:emoji ; la passerelle émet MESSAGE_REACTION_ADD / REMOVE.
 */
function installReactions(h) {
  const users = new Map(); // messageId → Set(userId)
  h.fake.routes.unshift({
    method: 'GET',
    re: /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/,
    keys: ['channel', 'message', 'emoji'],
    handler: (p) => [...(users.get(p.message) ?? [])].map((id) => h.fake.users.get(id)).filter(Boolean),
  });
  const sync = (messageId) => {
    const msg = h.fake.messages.get(messageId);
    const n = users.get(messageId)?.size ?? 0;
    if (msg) msg.reactions = n ? [{ emoji: STAR, count: n, count_details: { burst: 0, normal: n }, me: false, me_burst: false, burst_colors: [] }] : [];
  };
  return {
    users,
    async react(msg, as, { remove = false, settle = true } = {}) {
      const userId = IDS.users[as] ?? as;
      const set = users.get(msg.id) ?? new Set();
      users.set(msg.id, set);
      if (remove) set.delete(userId);
      else set.add(userId);
      sync(msg.id);
      const member = h.fake.members.get(userId);
      const d = { user_id: userId, channel_id: msg.channel_id, message_id: msg.id, guild_id: h.guild.id, emoji: STAR, burst: false, type: 0 };
      if (!remove && member) d.member = member;
      h.fake.dispatchNow(remove ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD', d, `${remove ? 'retrait' : 'réaction'} ⭐ ${as}`);
      if (settle) await h.settle();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callsTo = (h, method, re, mark) => h.fake.calls.slice(mark).filter((c) => c.method === method && re.test(c.route));

test('/communaute : chaque vue, bouton, menu et formulaire ; refus sans permission', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('communaute');
    assert.match(h.replyText(rec), /Communauté · Tableau de bord/);
    const stats = await explore(h, rec, { budget: 250 });
    assert.ok(stats.modals >= 2, `formulaires soumis : ${stats.modals}`);
    for (const view of ['home', 'starboard', 'auto']) assert.ok(stats.navChosen.has(`cmd:communaute:nav=${view}`), `vue ${view} jamais ouverte`);
    // Vue détaillée d'un déclencheur : créé par le formulaire, puis explorée (mode, salons, pause, suppression).
    const list = await h.slash('communaute');
    const auto = await h.click(h.messagesOf(list)[0], 'cmd:communaute:nav', { values: ['auto'] });
    const add = await h.click(h.messagesOf(auto)[0], 'cmd:communaute:aradd');
    const created = await h.submitModal(add, { pattern: 'salut', response: 'Coucou {membre} !', reaction: '', cooldown: '0' });
    assert.match(h.replyText(created), /Déclencheur ajouté/);
    const detail = await explore(h, created, { budget: 80, skip: (a) => a.customId.startsWith('cmd:communaute:ardelete') });
    for (const key of ['armode', 'archan', 'arexcl', 'artoggle', 'aredit']) assert.ok(detail.keys.has(`cmd:communaute:${key}`), `${key} jamais utilisé`);

    // Membre sans « Gérer le serveur » : commande et composants refusés, rien ne change.
    const denied = await h.slash('communaute', [], { as: 'member' });
    assert.ok(h.isError(denied));
    const admin = await h.slash('communaute');
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).community);
    await explore(h, admin, { as: 'member', budget: 30 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).community), before, 'un membre a modifié la configuration');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('starboard : seuil, auto-étoile et bots ignorés, anti-rebond, retrait, NSFW, message hors cache', async () => {
  const h = await createHarness();
  h.configureAll();
  const sb = h.client.services.starboard;
  sb.debounceMs = 20;
  sb.minEditIntervalMs = 20;
  const r = installReactions(h);
  const board = G().announcements;
  try {
    // Réglages par le tableau de bord : salon du starboard puis activation.
    const rec = await h.slash('communaute');
    const nav = await h.click(h.messagesOf(rec)[0], 'cmd:communaute:nav', { values: ['starboard'] });
    const view = h.messagesOf(nav)[0];
    const setChannel = await h.click(view, 'cmd:communaute:sbchannel', { values: [board] });
    await h.click(h.messagesOf(setChannel)[0], 'cmd:communaute:sbtoggle:on:starboard');
    const cfg = h.client.services.config.get(h.guild.id).community.starboard;
    assert.equal(cfg.channelId, board);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.threshold, 3);

    const image = { id: '1', filename: 'chat.png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/2/chat.png', proxy_url: 'https://media.discordapp.net/attachments/1/2/chat.png', content_type: 'image/png', width: 10, height: 10 };
    const msg = await h.userMessage({ as: 'member', content: 'Regardez mon chat <@' + IDS.users.admin + '> @everyone', extra: { attachments: [image] } });
    let mark = h.fake.calls.length;
    await r.react(msg, 'member'); // auto-étoile : ignorée
    await r.react(msg, 'otherBot'); // bot : ignoré
    await r.react(msg, 'admin');
    await r.react(msg, 'mod');
    await sleep(60);
    await h.settle();
    assert.equal(botMessagesIn(h, board).length, 0, 'reposté sous le seuil (auteur ou bot comptés ?)');

    await r.react(msg, 'target'); // 3 étoiles valides
    await h.waitFor(() => botMessagesIn(h, board).length === 1);
    const cardMsg = botMessagesIn(h, board)[0];
    const embed = cardMsg.embeds[0];
    assert.match(embed.title, /⭐\s+3/);
    assert.equal(embed.image?.url, image.url, 'première image absente');
    assert.match(embed.description, /Regardez mon chat/);
    const link = cardMsg.components[0].components[0];
    assert.equal(link.style, 5);
    assert.match(link.url, new RegExp(`/channels/${h.guild.id}/${msg.channel_id}/${msg.id}$`));
    const post = callsTo(h, 'POST', new RegExp(`^/channels/${board}/messages$`), mark)[0];
    assert.deepEqual(post.body.allowed_mentions, { parse: [] }, 'la carte pourrait notifier');
    assert.equal(h.client.repositories.starboard.get(h.guild.id, msg.id)?.star_message_id, cardMsg.id);

    // Rafale de réactions : une seule édition.
    mark = h.fake.calls.length;
    await r.react(msg, 'owner', { settle: false });
    await r.react(msg, 'botOwner', { settle: false });
    await h.settle();
    await h.waitFor(() => /⭐\s+5/.test(h.message(cardMsg.id)?.embeds?.[0]?.title ?? ''));
    await sleep(60);
    await h.settle();
    const edits = callsTo(h, 'PATCH', new RegExp(`^/channels/${board}/messages/${cardMsg.id}$`), mark);
    assert.equal(edits.length, 1, `éditions : ${edits.length}`);

    // Sous le seuil : carte retirée (option par défaut).
    for (const as of ['owner', 'botOwner', 'target']) await r.react(msg, as, { remove: true, settle: false });
    await h.settle();
    await h.waitFor(() => !h.fake.messages.has(cardMsg.id));
    assert.ok(!h.fake.messages.has(cardMsg.id), 'carte non retirée sous le seuil');
    assert.equal(h.client.repositories.starboard.get(h.guild.id, msg.id), null);

    // Retour au-dessus du seuil, puis suppression du message d'origine : carte retirée.
    await r.react(msg, 'target');
    await h.waitFor(() => botMessagesIn(h, board).filter((m) => h.fake.messages.has(m.id)).length === 1);
    const second = botMessagesIn(h, board).find((m) => h.fake.messages.has(m.id));
    assert.ok(second, 'carte non republiée');
    await h.deleteUserMessage(msg.id);
    await h.waitFor(() => !h.fake.messages.has(second.id));
    assert.ok(!h.fake.messages.has(second.id), 'carte conservée après suppression du message');

    // Salon NSFW → starboard non NSFW : jamais reposté.
    const rules = h.fake.channels.get(G().rules);
    rules.nsfw = true;
    h.fake.dispatchNow('CHANNEL_UPDATE', rules);
    const nsfw = await h.userMessage({ as: 'member', channel: 'rules', content: 'contenu NSFW' });
    const before = botMessagesIn(h, board).length;
    for (const as of ['admin', 'mod', 'target', 'owner']) await r.react(nsfw, as);
    await sleep(60);
    await h.settle();
    assert.equal(botMessagesIn(h, board).length, before, 'message NSFW reposté dans un starboard non NSFW');

    // Message hors cache (partiel) : récupéré au recompte puis reposté.
    const old = h.fake.buildMessage({ channelId: G().general, body: { content: 'Vieux message' }, author: h.fake.users.get(IDS.users.target) });
    for (const as of ['admin', 'mod']) await r.react(old, as, { settle: false });
    await r.react(old, 'member');
    await h.waitFor(() => botMessagesIn(h, board).some((m) => /Vieux message/.test(m.embeds?.[0]?.description ?? '')));
    assert.ok(botMessagesIn(h, board).some((m) => /Vieux message/.test(m.embeds?.[0]?.description ?? '')), 'message partiel non reposté');

    // Toutes les réactions retirées par un modérateur : carte retirée.
    const oldCard = botMessagesIn(h, board).find((m) => /Vieux message/.test(m.embeds?.[0]?.description ?? ''));
    r.users.set(old.id, new Set());
    h.fake.messages.get(old.id).reactions = [];
    h.fake.dispatchNow('MESSAGE_REACTION_REMOVE_ALL', { channel_id: old.channel_id, message_id: old.id, guild_id: h.guild.id }, 'retrait de toutes les réactions');
    await h.waitFor(() => !h.fake.messages.has(oldCard.id));
    assert.ok(!h.fake.messages.has(oldCard.id), 'carte conservée après retrait de toutes les réactions');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/sticky : définir, réaffichage anti-rebond, suppression du précédent, redémarrage, liste, retrait, refus', async () => {
  const h = await createHarness();
  h.configureAll();
  // AutoMod coupé : ses avertissements (messages du bot) compteraient comme de l'activité.
  h.configure({ automod: { enabled: false } });
  const svc = h.client.services.sticky;
  Object.assign(svc, { minIntervalMs: 0, settleMs: 5, idleMs: 60_000 });
  const channel = G().rules;
  try {
    // Refus sans « Gérer les messages ».
    assert.ok(h.isError(await h.slash('sticky', [{ name: 'definir', type: 1, options: [] }], { as: 'member' })));

    const open = await h.slash('sticky', [{ name: 'definir', type: 1, options: [{ name: 'salon', type: 7, value: channel }] }]);
    assert.equal(open.modals.length, 1, 'formulaire non ouvert');
    const done = await h.submitModal(open, { title: 'Règles', content: 'Soyez courtois. @everyone <@&' + IDS.roles.mod + '>', threshold: '2' });
    assert.match(h.replyText(done), /Message épinglé défini/);
    let stickies = botMessagesIn(h, channel);
    assert.equal(stickies.length, 1);
    const first = stickies[0];
    assert.equal(first.embeds[0].title, 'Règles');
    assert.match(first.embeds[0].author.name, /Message épinglé/);
    const post = h.fake.calls.filter((c) => c.method === 'POST' && c.route === `/channels/${channel}/messages`).at(-1);
    assert.deepEqual(post.body.allowed_mentions, { parse: [] });

    // Un message (< seuil de 2) : pas de republication immédiate.
    await h.userMessage({ as: 'member', channel: 'rules', content: 'un' });
    await sleep(30);
    await h.settle();
    assert.equal(botMessagesIn(h, channel).filter((m) => h.fake.messages.has(m.id)).length, 1);
    assert.ok(h.fake.messages.has(first.id));

    // Deuxième message : republié en bas, l'ancien supprimé.
    await h.userMessage({ as: 'target', channel: 'rules', content: 'deux' });
    await h.waitFor(() => !h.fake.messages.has(first.id));
    stickies = botMessagesIn(h, channel).filter((m) => h.fake.messages.has(m.id));
    assert.equal(stickies.length, 1, 'un seul message épinglé doit rester');
    const second = stickies[0];
    assert.notEqual(second.id, first.id);
    assert.equal(h.fake.channels.get(channel).last_message_id, second.id, 'le message épinglé n\'est pas en bas');
    assert.equal(h.client.repositories.sticky.get(channel).last_message_id, second.id, 'non persisté');

    // Anti-rebond : rafale de 6 messages → une seule republication ; puis intervalle minimal respecté.
    const burst = async (n) => {
      for (let i = 0; i < n; i += 1) {
        const m = h.fake.buildMessage({ channelId: channel, body: { content: `rafale ${i}` }, author: h.fake.users.get(IDS.users.member) });
        h.fake.dispatchNow('MESSAGE_CREATE', { ...m, channel_type: 0, member: { ...h.fake.members.get(IDS.users.member), user: undefined } }, `rafale ${i}`);
      }
      await h.settle();
    };
    const posts = (mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && c.route === `/channels/${channel}/messages`);
    Object.assign(svc, { settleMs: 30 });
    let markPosts = h.fake.calls.length;
    await burst(6);
    await h.waitFor(() => posts(markPosts).length >= 1);
    await sleep(60);
    await h.settle();
    assert.equal(posts(markPosts).length, 1, `republications pendant la rafale : ${posts(markPosts).length}`);
    Object.assign(svc, { minIntervalMs: 400, settleMs: 5 });
    markPosts = h.fake.calls.length;
    const lastPost = svc.states.get(channel).lastPostAt;
    await burst(2);
    await h.waitFor(() => posts(markPosts).length >= 1, { timeout: 2_000 });
    assert.equal(posts(markPosts).length, 1);
    assert.ok(svc.states.get(channel).lastPostAt - lastPost >= 390, 'intervalle minimal entre deux republications ignoré');
    Object.assign(svc, { minIntervalMs: 0 });

    // Redémarrage : nouveau service relu depuis la base ; activité pendant l'arrêt → rattrapage.
    await svc.stop();
    const reborn = new StickyService({ client: h.client, sticky: h.client.repositories.sticky, minIntervalMs: 0, settleMs: 5, idleMs: 60_000 });
    h.client.services.sticky = reborn;
    const lastBefore = reborn.get(channel).last_message_id;
    const offline = h.fake.buildMessage({ channelId: channel, body: { content: 'pendant l\'arrêt' }, author: h.fake.users.get(IDS.users.member) });
    h.client.channels.cache.get(channel).lastMessageId = offline.id;
    assert.equal(reborn.resume(), 1);
    await h.waitFor(() => !h.fake.messages.has(lastBefore));
    assert.ok(!h.fake.messages.has(lastBefore), 'pas de rattrapage après redémarrage');
    assert.equal(h.fake.channels.get(channel).last_message_id, reborn.get(channel).last_message_id);

    // Liste, puis retrait par le menu.
    const list = await h.slash('sticky', [{ name: 'liste', type: 1, options: [] }]);
    assert.match(h.replyText(list), /Messages épinglés automatiquement/);
    const lastId = reborn.get(channel).last_message_id;
    const removed = await h.click(h.messagesOf(list)[0], 'cmd:sticky:remove', { values: [channel] });
    assert.match(h.replyText(removed), /1 message\(s\) épinglé\(s\) retiré\(s\)/);
    assert.ok(!h.fake.messages.has(lastId), 'dernier message épinglé non supprimé');
    assert.equal(h.client.repositories.sticky.get(channel), null);

    // Plus de sticky : l'activité ne republie rien ; /sticky retirer refuse proprement.
    const mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'member', channel: 'rules', content: 'calme' });
    await sleep(20);
    await h.settle();
    assert.equal(botMessagesIn(h, channel, mark).length, 0);
    assert.ok(h.isError(await h.slash('sticky', [{ name: 'retirer', type: 1, options: [{ name: 'salon', type: 7, value: channel }] }])));

    // /sticky retirer après un nouveau /sticky definir (salon courant).
    const again = await h.slash('sticky', [{ name: 'definir', type: 1, options: [] }]);
    await h.submitModal(again, { title: '', content: 'Bienvenue', threshold: '3' });
    assert.ok(h.client.repositories.sticky.get(G().general));
    const retire = await h.slash('sticky', [{ name: 'retirer', type: 1, options: [] }]);
    assert.match(h.replyText(retire), /retiré/);
    assert.equal(h.client.repositories.sticky.get(G().general), null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('réponses automatiques : mot entier, cooldown par salon, aucune mention, bots et AutoMod ignorés', async () => {
  const h = await createHarness();
  h.configureAll();
  const svc = h.client.services.autoResponses;
  svc.delayMs = 5;
  try {
    // Création par le tableau de bord.
    const rec = await h.slash('communaute');
    const auto = await h.click(h.messagesOf(rec)[0], 'cmd:communaute:nav', { values: ['auto'] });
    const add = await h.click(h.messagesOf(auto)[0], 'cmd:communaute:aradd');
    assert.equal(add.modals.length, 1);
    const saved = await h.submitModal(add, { pattern: 'Bonjour', response: 'Salut {membre}, bienvenue sur {serveur} ! @everyone', reaction: '👋', cooldown: '1m' });
    assert.match(h.replyText(saved), /Déclencheur ajouté/);
    const back = await h.click(h.messagesOf(saved)[0], 'cmd:communaute:go:auto');
    const toggled = await h.click(h.messagesOf(back)[0], 'cmd:communaute:artoggleall:on:auto');
    assert.ok(!h.isError(toggled));
    assert.match(h.replyText(toggled), /Réponses automatiques \*\*activées\*\*/);
    const cfg = h.client.services.config.get(h.guild.id).community.autoResponses;
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.triggers.length, 1);
    assert.equal(cfg.triggers[0].mode, 'word');
    assert.equal(cfg.triggers[0].cooldownSeconds, 60);

    const replies = (mark) => botMessagesIn(h, G().general, mark).filter((m) => m.message_reference || /Salut/.test(m.content));
    let mark = h.fake.messageLog.length;
    let calls = h.fake.calls.length;
    const hello = await h.userMessage({ as: 'member', content: 'BONJOUR à tous' });
    await h.waitFor(() => replies(mark).length === 1);
    const reply = replies(mark)[0];
    assert.match(reply.content, new RegExp(`Salut <@${IDS.users.member}>, bienvenue sur `));
    const post = h.fake.calls.slice(calls).find((c) => c.method === 'POST' && c.route === `/channels/${G().general}/messages`);
    assert.deepEqual(post.body.allowed_mentions, { parse: [], replied_user: false }, 'une mention pourrait notifier');
    assert.equal(post.body.message_reference?.message_id, hello.id);
    assert.ok(h.fake.calls.slice(calls).some((c) => c.method === 'PUT' && c.route.startsWith(`/channels/${G().general}/messages/${hello.id}/reactions/`)), 'réaction absente');

    // Cooldown par salon : pas de deuxième réponse ici, mais une dans un autre salon.
    mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'target', content: 'bonjour encore' });
    await sleep(30);
    await h.settle();
    assert.equal(replies(mark).length, 0, 'cooldown ignoré');
    const markRules = h.fake.messageLog.length;
    await h.userMessage({ as: 'target', channel: 'rules', content: 'bonjour' });
    await h.waitFor(() => botMessagesIn(h, G().rules, markRules).length === 1);
    assert.equal(botMessagesIn(h, G().rules, markRules).length, 1, 'cooldown non propre au salon');

    // Mot entier : « bonjourno » ne déclenche pas. Bots ignorés.
    svc.cooldowns.clear();
    mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'member', content: 'bonjourno' });
    await h.userMessage({ as: 'otherBot', content: 'bonjour' });
    await sleep(30);
    await h.settle();
    assert.equal(replies(mark).length, 0, 'réponse à un mot partiel ou à un bot');

    // Message supprimé par l'AutoMod : jamais de réponse.
    svc.cooldowns.clear();
    svc.delayMs = 300;
    mark = h.fake.messageLog.length;
    const spam = await h.userMessage({ as: 'target', channel: 'announcements', content: 'bonjour discord.gg/abcdef' });
    await sleep(350);
    await h.settle();
    assert.ok(!h.fake.messages.has(spam.id), 'invitation non supprimée par l\'AutoMod');
    assert.equal(botMessagesIn(h, G().announcements, mark).filter((m) => m.message_reference?.message_id === spam.id).length, 0, 'réponse à un message filtré par l\'AutoMod');

    // Suppression par l'administrateur puis vue vide.
    const list = await h.slash('communaute');
    const autoView = await h.click(h.messagesOf(list)[0], 'cmd:communaute:nav', { values: ['auto'] });
    const id = cfg.triggers[0].id;
    const detail = await h.click(h.messagesOf(autoView)[0], 'cmd:communaute:arpick', { values: [id] });
    const confirm = await h.click(h.messagesOf(detail)[0], `cmd:communaute:go:confirmDel.${id}`);
    const del = await h.click(h.messagesOf(confirm)[0], `cmd:communaute:ardelete:${id}`);
    assert.match(h.replyText(del), /supprimé/);
    assert.equal(h.client.services.config.get(h.guild.id).community.autoResponses.triggers.length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
