'use strict';

/**
 * Revue n° 6, bout en bout (vrai discord.js, faux Discord) : communauté — starboard sur un
 * serveur à vérification, rappels, annonces, niveaux, giveaways, invitations, projets,
 * alertes de mots-clés, signalements.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { rawMember } = require('./lib/fixtures');
const { nextId } = require('./lib/ids');

const STAR = { id: null, name: '⭐' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const botMessagesIn = (h, channelId, mark = 0) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);

/** Réactions ⭐ simulées (même mécanisme que tests/e2e/community.e2e.test.js). */
function installReactions(h) {
  const users = new Map();
  h.fake.routes.unshift({
    method: 'GET',
    re: /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/,
    keys: ['channel', 'message', 'emoji'],
    handler: (p) => [...(users.get(p.message) ?? [])].map((id) => h.fake.users.get(id)).filter(Boolean),
  });
  return async (msg, as) => {
    const userId = IDS.users[as] ?? as;
    const set = users.get(msg.id) ?? new Set();
    users.set(msg.id, set);
    set.add(userId);
    const raw = h.fake.messages.get(msg.id);
    raw.reactions = [{ emoji: STAR, count: set.size, count_details: { burst: 0, normal: set.size }, me: false, me_burst: false, burst_colors: [] }];
    const member = h.fake.members.get(userId);
    h.fake.dispatchNow('MESSAGE_REACTION_ADD', { user_id: userId, channel_id: msg.channel_id, message_id: msg.id, guild_id: h.guild.id, emoji: STAR, burst: false, type: 0, ...(member ? { member } : {}) }, `réaction ⭐ ${as}`);
    await h.settle();
  };
}

function updateRole(h, roleId, mutate, label) {
  const role = { ...h.fake.roles.get(roleId) };
  role.permissions = mutate(BigInt(role.permissions)).toString();
  h.fake.roles.set(roleId, role);
  h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role }, label);
}

// ------------------------------------------------------------------ R75 : starboard

test('R75 starboard : serveur à vérification (@everyone ne voit rien) → un message de #staff n\'est jamais reposté pour le rôle Membre', async () => {
  const h = await createHarness();
  const sb = h.client.services.starboard;
  sb.debounceMs = 20;
  sb.minEditIntervalMs = 20;
  const react = installReactions(h);
  try {
    const board = nextId();
    const rawBoard = { id: board, type: 0, guild_id: h.guild.id, name: 'starboard', position: 9, permission_overwrites: [], parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0 };
    h.fake.channels.set(board, rawBoard);
    h.fake.dispatchNow('CHANNEL_CREATE', rawBoard, 'préparation : #starboard');
    const modo2 = h.addUser('Modo2', { ageDays: 800 });
    const m2 = rawMember(modo2, [IDS.roles.mod, IDS.roles.member], 300);
    h.fake.members.set(modo2.id, m2);
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...m2, guild_id: h.guild.id }, 'préparation : Modo2');
    await h.settle();

    const rec = await h.slash('communaute');
    const nav = await h.click(h.messagesOf(rec)[0], 'cmd:communaute:nav', { values: ['starboard'] });
    const setChannel = await h.click(h.messagesOf(nav)[0], 'cmd:communaute:sbchannel', { values: [board] });
    await h.click(h.messagesOf(setChannel)[0], 'cmd:communaute:sbtoggle:on:starboard');
    const reactors = ['mod', 'admin', 'owner'];

    // Témoin public : un message de #général atteint le seuil → carte publiée.
    const pub = await h.userMessage({ as: modo2.id, channel: 'general', content: 'Message public' });
    for (const as of reactors) await react(pub, as);
    await sleep(80);
    await h.settle();
    assert.equal(botMessagesIn(h, board).length, 1, 'message public non reposté');

    // Vérification « ajout » : @everyone perd « Voir les salons », le rôle Membre l'obtient.
    h.configure({ welcome: { verification: { enabled: true, mode: 'add', roleId: IDS.roles.member } } });
    updateRole(h, IDS.roles.everyone, (p) => p & ~P.ViewChannel, 'préparation : @everyone sans Voir les salons');
    updateRole(h, IDS.roles.member, (p) => p | P.ViewChannel, 'préparation : Membre voit les salons');
    await h.settle();
    const sees = (userId, channelId) => h.client.channels.cache.get(channelId).permissionsFor(h.guild.members.cache.get(userId)).has(P.ViewChannel);
    assert.equal(sees(IDS.users.target, IDS.channels.staff), false);
    assert.equal(sees(IDS.users.target, board), true);

    const mark = h.fake.messageLog.length;
    const secret = await h.userMessage({ as: modo2.id, channel: 'staff', content: 'CONFIDENTIEL : on bannit X demain' });
    for (const as of reactors) await react(secret, as);
    await sleep(80);
    await h.settle();
    assert.equal(botMessagesIn(h, board, mark).length, 0, 'message de #staff reposté dans un starboard lu par le rôle Membre');
    assert.equal(h.client.repositories.starboard.get(h.guild.id, secret.id), null);

    // Le message public reste éligible (le rôle Membre voit #général).
    await react(pub, 'target');
    await sleep(80);
    await h.settle();
    assert.ok(h.client.repositories.starboard.get(h.guild.id, pub.id)?.star_message_id, 'message public retiré à tort');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R75 starboard : salon devenu privé après la publication → la carte existante est retirée au recompte suivant', async () => {
  const h = await createHarness();
  const sb = h.client.services.starboard;
  sb.debounceMs = 20;
  sb.minEditIntervalMs = 20;
  const react = installReactions(h);
  try {
    const board = nextId();
    const rawBoard = { id: board, type: 0, guild_id: h.guild.id, name: 'starboard', position: 9, permission_overwrites: [], parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0 };
    h.fake.channels.set(board, rawBoard);
    h.fake.dispatchNow('CHANNEL_CREATE', rawBoard, 'préparation : #starboard');
    h.configure({ community: { starboard: { enabled: true, channelId: board, threshold: 2 } } });
    await h.settle();
    const msg = await h.userMessage({ as: 'member', channel: 'general', content: 'Bientôt privé' });
    await react(msg, 'mod');
    await react(msg, 'admin');
    await sleep(80);
    await h.settle();
    const row = h.client.repositories.starboard.get(h.guild.id, msg.id);
    assert.ok(row?.star_message_id, 'carte non publiée');

    // #général devient invisible pour @everyone (le starboard reste public).
    const general = h.fake.channels.get(IDS.channels.general);
    const updated = { ...general, permission_overwrites: [...general.permission_overwrites.filter((o) => o.id !== IDS.roles.everyone), { id: IDS.roles.everyone, type: 0, allow: '0', deny: P.ViewChannel.toString() }] };
    h.fake.channels.set(general.id, updated);
    h.fake.dispatchNow('CHANNEL_UPDATE', updated, 'préparation : #général privé');
    await h.settle();
    await react(msg, 'owner');
    await sleep(80);
    await h.settle();
    assert.equal(h.client.repositories.starboard.get(h.guild.id, msg.id), null, 'ligne conservée');
    assert.ok(h.fake.calls.some((c) => c.method === 'DELETE' && c.route === `/channels/${board}/messages/${row.star_message_id}`), 'carte d\'un salon devenu privé laissée en place');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});


// ------------------------------------------------------------------ R79 : rappels

/** Rend les rappels échus et lance un tick du planificateur ; renvoie les messages du bot publiés. */
async function deliverReminders(h) {
  const mark = h.fake.messageLog.length;
  h.client.database.db.prepare('UPDATE reminders SET remind_at = ?').run(Date.now() - 1000);
  await h.client.services.scheduler.tick();
  await h.settle();
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id);
}
const isDm = (h, m) => h.fake.dms.has(m.channel_id);

test('R79 /reminder : salon en lecture seule → rappel en MP ; auteur banni ou parti → jamais publié dans le salon ; lien masqué neutralisé', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rules = h.fake.channels.get(IDS.channels.rules);
    rules.permission_overwrites = [{ id: IDS.guild, type: 0, allow: '0', deny: String(P.SendMessages) }];
    h.fake.dispatchNow('CHANNEL_UPDATE', rules, 'préparation : #règles en lecture seule');
    await h.settle();

    // 1. Création dans un salon où l'auteur ne peut pas écrire : le rappel partira en MP.
    const payload = 'Vérification obligatoire : [https://discord.com/verify](https://discord-verify.example.ru/login)';
    const rec = await h.slash('reminder', sub('create', [opt('duree', 3, '6h'), opt('message', 3, payload)]), { as: 'member', channel: 'rules' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /message privé/i);
    const row = h.client.database.db.prepare('SELECT * FROM reminders').get();
    assert.equal(row.channel_id, null, 'rappel enregistré pour #règles (lecture seule pour son auteur)');
    let posted = await deliverReminders(h);
    assert.equal(posted.filter((m) => m.channel_id === IDS.channels.rules).length, 0, 'rappel publié dans #règles');
    const dm = posted.find((m) => isDm(h, m));
    assert.ok(dm, 'rappel non livré en MP');
    assert.ok(!/(^|[^\\])\[/.test(dm.embeds[0].description), `lien masqué cliquable : ${dm.embeds[0].description}`);

    // 2. Rappel créé dans #général, auteur banni avant l'échéance → MP, rien dans #général.
    await h.slash('reminder', sub('create', [opt('duree', 3, '1h'), opt('message', 3, 'Annonce du banni')]), { as: 'member', channel: 'general' });
    assert.equal(h.client.database.db.prepare('SELECT channel_id FROM reminders').get().channel_id, IDS.channels.general);
    const ban = await h.slash('ban', [opt('membre', 6, IDS.users.member), opt('raison', 3, 'phishing')], { as: 'admin' });
    if (/Confirmation/.test(h.replyText(ban))) await h.confirm(ban);
    await h.settle();
    assert.ok(h.fake.bans.has(IDS.users.member));
    posted = await deliverReminders(h);
    assert.equal(posted.filter((m) => m.channel_id === IDS.channels.general && /Annonce du banni/.test(m.embeds?.[0]?.description ?? '')).length, 0, 'rappel d\'un membre banni publié dans #général');
    assert.equal(h.client.database.db.prepare('SELECT COUNT(*) n FROM reminders').get().n, 0, 'rappel conservé');

    // 3. Membre présent qui peut écrire : publication dans le salon comme avant.
    await h.slash('reminder', sub('create', [opt('duree', 3, '1h'), opt('message', 3, 'Rappel normal')]), { as: 'target', channel: 'general' });
    posted = await deliverReminders(h);
    assert.ok(posted.some((m) => m.channel_id === IDS.channels.general && /Rappel normal/.test(m.embeds?.[0]?.description ?? '')), 'rappel normal non publié dans le salon');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R100 : alertes dans un fil privé

test('R100 /alertes dans un fil privé : vérifications d\'appartenance bornées par message, refus retenus', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ automod: { enabled: false } }); // l'anti-spam supprimerait les messages rapprochés
  const hl = h.client.services.highlights;
  hl.delayMs = 5;
  const N = 40;
  try {
    const ids = [];
    for (let i = 0; i < N; i += 1) {
      const u = h.addUser(`Abonne${i}`);
      const m = rawMember(u, [], 0);
      h.fake.members.set(u.id, m);
      h.guild.members._add(m);
      hl.addWord(h.guild.id, u.id, 'gadget');
      ids.push(u.id);
    }
    // Un abonné réellement membre du fil, absent du cache des membres du fil (redémarrage).
    const insider = h.addUser('Insider');
    const im = rawMember(insider, [], 0);
    h.fake.members.set(insider.id, im);
    h.guild.members._add(im);
    hl.addWord(h.guild.id, insider.id, 'gadget');
    const thread = await h.guild.channels.cache.get(IDS.channels.general).threads.create({ name: 'prive', type: 12, invitable: false });
    h.fake.threadMembers.get(thread.id).add(IDS.users.member);
    h.fake.threadMembers.get(thread.id).add(insider.id);
    await h.settle();
    const isThreadMemberGet = (c) => c.method === 'GET' && c.route.startsWith(`/channels/${thread.id}/thread-members/`);
    const perMessage = [];
    let insiderAlerted = false;
    for (let k = 0; k < 7; k += 1) {
      const mark = h.fake.calls.length;
      await h.userMessage({ as: 'member', channel: thread.id, content: `message ${k} : qui a vu le gadget ?` });
      await sleep(60);
      await h.settle();
      perMessage.push(h.fake.calls.slice(mark).filter(isThreadMemberGet).length);
      const dm = [...h.fake.dms.values()].find((d) => d.recipients[0].id === insider.id);
      if (dm && h.fake.messageLog.some((id) => h.message(id)?.channel_id === dm.id)) insiderAlerted = true;
    }
    assert.ok(perMessage.every((n) => n <= 10), `requêtes par message : ${perMessage.join(', ')}`);
    assert.ok(perMessage.reduce((a, b) => a + b, 0) <= N + 1, `refus non retenus : ${perMessage.join(', ')}`);
    assert.equal(perMessage.at(-1), 0, `requêtes encore émises pour des refus connus : ${perMessage.join(', ')}`);
    assert.ok(insiderAlerted, 'membre du fil jamais alerté');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R80 : /annonce et « Mentionner @everyone »

async function modWithEveryoneDeniedIn(h, channelKey) {
  updateRole(h, IDS.roles.mod, (p) => p | P.ManageGuild | P.MentionEveryone, 'préparation : Modérateur gère le serveur');
  const ch = h.fake.channels.get(IDS.channels[channelKey]);
  const updated = { ...ch, permission_overwrites: [...ch.permission_overwrites, { id: IDS.roles.mod, type: 0, allow: '0', deny: P.MentionEveryone.toString() }] };
  h.fake.channels.set(ch.id, updated);
  h.fake.dispatchNow('CHANNEL_UPDATE', updated, `préparation : @everyone refusé au Modérateur dans #${channelKey}`);
  await h.settle();
}

test('R80 /annonce : « Mentionner @everyone » vérifié dans le salon de publication (programmation, échéance, envoi immédiat)', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await modWithEveryoneDeniedIn(h, 'general');
    assert.equal(h.client.channels.cache.get(IDS.channels.general).permissionsFor(h.member('mod')).has(P.MentionEveryone), false);

    // 1. Programmation depuis #staff vers #général : refusée.
    const rec = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h'), opt('role', 8, IDS.guild)]), { as: 'mod', channel: 'staff' });
    assert.ok(h.isError(rec), 'programmation acceptée malgré la surcharge');
    assert.match(h.replyText(rec), /@everyone/);

    // 2. Annonce déjà programmée (avant la surcharge, simulée en base) : désactivée à l'échéance.
    const repo = h.client.repositories.announcements;
    const now = Date.now();
    const draftId = repo.createDraft({ guildId: h.guild.id, channelId: IDS.channels.general, authorId: IDS.users.mod, roleId: IDS.guild, repeat: 'none', timeZone: 'Europe/Paris', runAt: now + 3_600_000, now });
    repo.setContent(h.guild.id, draftId, { title: 'Annonce', message: 'Réveil général', color: null, image: null });
    repo.schedule(h.guild.id, draftId, now + 3_600_000, { anchorAt: now + 3_600_000, runs: 0 });
    h.client.database.db.prepare('UPDATE scheduled_announcements SET next_run = ?, anchor_at = ? WHERE id = ?').run(now - 1000, now - 1000, draftId);
    let mark = h.fake.calls.length;
    await h.client.services.scheduler.tick();
    await h.settle();
    const posted = (m) => h.fake.calls.slice(m).filter((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.general}/messages` && c.body?.allowed_mentions?.parse?.includes('everyone'));
    assert.equal(posted(mark).length, 0, '@everyone publié à l\'échéance malgré la surcharge');
    assert.equal(repo.get(h.guild.id, draftId).status, 'disabled');

    // 3. « Envoyer maintenant » d'une annonce programmée par l'admin, cliqué par le modérateur : refusé.
    const second = repo.createDraft({ guildId: h.guild.id, channelId: IDS.channels.general, authorId: IDS.users.admin, roleId: IDS.guild, repeat: 'none', timeZone: 'Europe/Paris', runAt: now + 3_600_000, now });
    repo.setContent(h.guild.id, second, { title: 'Annonce', message: 'Deuxième', color: null, image: null });
    repo.schedule(h.guild.id, second, now + 3_600_000, { anchorAt: now + 3_600_000, runs: 0 });
    const list = await h.slash('annonce', sub('liste'), { as: 'mod', channel: 'staff' });
    const sendBtn = h.messagesOf(list)[0].components.flatMap((r) => r.components).find((c) => c.custom_id?.startsWith(`cmd:annonce:asend:${second}:`));
    assert.ok(sendBtn, 'bouton « Envoyer maintenant » absent');
    mark = h.fake.calls.length;
    const click = await h.click(h.messagesOf(list)[0], sendBtn.custom_id, { as: 'mod', channel: 'staff' });
    await h.settle();
    assert.equal(posted(mark).length, 0, '@everyone publié par « Envoyer maintenant » malgré la surcharge');
    assert.match(h.replyText(click), /@everyone/);
    assert.equal(repo.get(h.guild.id, second).status, 'scheduled');

    // 4. Témoin : l'admin (Administrateur) publie normalement.
    const list2 = await h.slash('annonce', sub('liste'), { as: 'admin', channel: 'staff' });
    const btn2 = h.messagesOf(list2)[0].components.flatMap((r) => r.components).find((c) => c.custom_id?.startsWith(`cmd:annonce:asend:${second}:`));
    mark = h.fake.calls.length;
    await h.click(h.messagesOf(list2)[0], btn2.custom_id, { as: 'admin', channel: 'staff' });
    await h.settle();
    assert.equal(posted(mark).length, 1, 'annonce de l\'admin non publiée');
    assert.equal(h.problems().massMentions.length, 1, 'seul le @everyone légitime de l\'admin est publié');
    h.fake.massMentions.length = 0;
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
