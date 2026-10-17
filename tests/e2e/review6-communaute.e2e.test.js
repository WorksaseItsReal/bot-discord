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
  h.configure({ automod: { enabled: false } }); // filtres de texte : voir R78
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

// ------------------------------------------------------------------ R76 / R77 : vérification

async function publishVerifyPanel(h) {
  const dash = await h.slash('bienvenue');
  const nav = await h.click(h.message(dash.original), 'cmd:bienvenue:nav', { values: ['verify'] });
  await h.click(h.message(nav.componentMessageId), 'cmd:bienvenue:publish');
  return h.fake.messageLog.map((id) => h.message(id)).find((m) => m?.components?.some((r) => r.components.some((c) => c.custom_id === 'cmd:bienvenue:verify')));
}
const rolesOf = (h, id) => h.fake.members.get(id).roles;

test('R76 vérification « retrait » : arrivée pendant un arrêt du bot rattrapée au démarrage ; /derank ne retire pas le rôle « non vérifié »', async () => {
  const h = await createHarness({ ready: false });
  try {
    h.configure({ moderation: { confirmDangerous: false }, welcome: { verification: { enabled: true, mode: 'remove', roleId: IDS.roles.temp, channelId: IDS.channels.rules } } });
    // Arrivée pendant l'arrêt : présente dans GUILD_CREATE, sans GUILD_MEMBER_ADD.
    const raider = h.addUser('Raider', { ageDays: 2 });
    const raw = rawMember(raider, [], 0);
    raw.joined_at = new Date(Date.now() - 60_000).toISOString();
    h.fake.members.set(raider.id, raw);
    h.guild.members._add({ ...raw });
    await h.emitReady();
    assert.ok(await h.waitFor(() => rolesOf(h, raider.id).includes(IDS.roles.temp), { timeout: 2_000 }), 'arrivée hors ligne non rattrapée (accès complet sans vérification)');
    // Les anciens membres (rôles en place) ne sont pas touchés.
    assert.ok(!rolesOf(h, IDS.users.member).includes(IDS.roles.temp), 'ancien membre re-verrouillé');

    // Arrivant vu en ligne puis vérifié (sans autre rôle) : un nouveau rattrapage ne le re-verrouille pas.
    const fresh = h.addUser('Nouveau', { ageDays: 300 });
    await h.memberJoin(fresh);
    assert.ok(rolesOf(h, fresh.id).includes(IDS.roles.temp));
    const panel = await publishVerifyPanel(h);
    await h.click(panel, 'cmd:bienvenue:verify', { as: fresh.id });
    assert.ok(!rolesOf(h, fresh.id).includes(IDS.roles.temp), 'vérification impossible');
    await h.client.services.welcome.catchUpOfflineJoins(h.guild);
    await h.settle();
    assert.ok(!rolesOf(h, fresh.id).includes(IDS.roles.temp), 'membre vérifié re-verrouillé au rattrapage');

    // /derank du raider : le rôle « non vérifié » reste (sinon accès complet).
    const d = await h.slash('derank', [opt('membre', 6, raider.id), opt('raison', 3, 'test')], { as: 'admin' });
    assert.ok(!h.isError(d) || /aucun rôle/.test(h.replyText(d)), h.replyText(d));
    assert.ok(rolesOf(h, raider.id).includes(IDS.roles.temp), '/derank a retiré le rôle « non vérifié »');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R77 vérification « ajout » : un membre dérank, muet ou en timeout ne se rend pas ses rôles par « Me vérifier »', async () => {
  const h = await createHarness();
  try {
    h.configure({
      moderation: { confirmDangerous: false },
      welcome: { verification: { enabled: true, mode: 'add', roleId: IDS.roles.member, channelId: IDS.channels.rules }, autoRoles: { humans: [IDS.roles.gamer], bots: [] } },
    });
    const panel = await publishVerifyPanel(h);
    assert.ok(panel, 'panneau non publié');
    // 1. /derank : le rôle vérifié est conservé, les autres retirés ; « Me vérifier » ne rend rien.
    await h.slash('derank', [opt('membre', 6, IDS.users.member), opt('raison', 3, 'comportement toxique')], { as: 'admin' });
    assert.ok(!rolesOf(h, IDS.users.member).includes(IDS.roles.gamer), 'derank sans effet');
    await h.click(panel, 'cmd:bienvenue:verify', { as: 'member' });
    assert.ok(!rolesOf(h, IDS.users.member).includes(IDS.roles.gamer), 'derank annulé par le membre (rôles automatiques rendus)');

    // 2. Membre en timeout sans le rôle vérifié : refus.
    const muted = h.addUser('Muet', { ageDays: 300 });
    const raw = rawMember(muted, [], 10, { communication_disabled_until: new Date(Date.now() + 3_600_000).toISOString() });
    h.fake.members.set(muted.id, raw);
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...raw, guild_id: h.guild.id }, 'préparation : membre en timeout');
    await h.settle();
    const v = await h.click(panel, 'cmd:bienvenue:verify', { as: muted.id });
    assert.ok(h.isError(v), 'vérification acceptée en timeout');
    assert.ok(!rolesOf(h, muted.id).includes(IDS.roles.member), 'rôle vérifié donné à un membre en timeout');

    // 3. Membre avec le rôle Muted : refus.
    const mutedRole = h.addUser('Muet2', { ageDays: 300 });
    const raw2 = rawMember(mutedRole, [IDS.roles.muted], 10);
    h.fake.members.set(mutedRole.id, raw2);
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...raw2, guild_id: h.guild.id }, 'préparation : membre muet');
    await h.settle();
    h.configure({ moderation: { mutedRoleId: IDS.roles.muted } });
    const v2 = await h.click(panel, 'cmd:bienvenue:verify', { as: mutedRole.id });
    assert.ok(h.isError(v2), 'vérification acceptée pour un membre muet');
    assert.ok(!rolesOf(h, mutedRole.id).includes(IDS.roles.member));

    // Témoin : un arrivant ordinaire se vérifie.
    const ok = h.addUser('Ordinaire', { ageDays: 300 });
    await h.memberJoin(ok);
    await h.click(panel, 'cmd:bienvenue:verify', { as: ok.id });
    assert.ok(rolesOf(h, ok.id).includes(IDS.roles.member), 'vérification ordinaire refusée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R78 : textes publiés par le bot et AutoMod

test('R78 /suggestion, /reminder, /sondage : texte que l\'AutoMod supprimerait refusé ; membre muet refusé ; liens masqués neutralisés', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const PAYLOAD = 'rejoignez discord.gg/arnaque42 vite';
    const direct = await h.userMessage({ as: 'member', channel: 'general', content: PAYLOAD });
    assert.ok(!h.fake.messages.has(direct.id), 'calibrage : l\'AutoMod ne supprime pas le message');
    const suggestionCards = (mark) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m?.author.id === h.client.user.id && /Suggestion #\d+$/.test(m.embeds?.[0]?.title ?? '') && !(m.flags & 64));

    let mark = h.fake.messageLog.length;
    const s1 = await h.slash('suggestion', sub('create', [opt('contenu', 3, PAYLOAD)]), { as: 'member', channel: 'general' });
    assert.ok(h.isError(s1), 'suggestion avec invitation acceptée');
    assert.equal(suggestionCards(mark).length, 0);
    const s2 = await h.slash('suggestion', sub('create', [opt('contenu', 3, 'Un mot interdit ici')]), { as: 'member', channel: 'general' });
    assert.ok(h.isError(s2), 'suggestion avec mot interdit acceptée');

    const r1 = await h.slash('reminder', sub('create', [opt('duree', 3, '1h'), opt('message', 3, PAYLOAD)]), { as: 'member', channel: 'general' });
    assert.ok(h.isError(r1), 'rappel avec invitation accepté');
    assert.equal(h.client.database.db.prepare('SELECT COUNT(*) n FROM reminders').get().n, 0);

    const p1 = await h.slash('sondage', [opt('question', 3, `Qui vient ? ${PAYLOAD}`)], { as: 'member', channel: 'general' });
    assert.ok(h.isError(p1), 'sondage avec invitation accepté');
    const p2 = await h.slash('sondage', [opt('question', 3, 'On joue ?'), opt('choix', 3, 'Oui | Non | interdit')], { as: 'member', channel: 'general' });
    assert.ok(h.isError(p2), 'sondage avec mot interdit dans les réponses accepté');

    // Membre muet (rôle Muted) : /suggestion refusée même avec un texte propre.
    h.configure({ moderation: { mutedRoleId: IDS.roles.muted } });
    const tm = h.fake.members.get(IDS.users.target);
    tm.roles = [...tm.roles, IDS.roles.muted];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...tm }, 'préparation : cible muette');
    await h.settle();
    mark = h.fake.messageLog.length;
    const s3 = await h.slash('suggestion', sub('create', [opt('contenu', 3, 'Idée propre')]), { as: 'target', channel: 'general' });
    assert.ok(h.isError(s3), 'suggestion d\'un membre muet acceptée');
    assert.equal(suggestionCards(mark).length, 0);

    // Texte propre avec lien masqué vers un hôte autorisé : publié, lien neutralisé.
    mark = h.fake.messageLog.length;
    const ok = await h.slash('suggestion', sub('create', [opt('contenu', 3, 'Voir [la doc](https://discord.com/developers) svp')]), { as: 'member', channel: 'general' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    const card = suggestionCards(mark)[0];
    assert.ok(card, `suggestion propre non publiée : ${h.replyText(ok)}`);
    assert.ok(!/(^|[^\\])\[la doc/.test(card.embeds[0].description), `lien masqué cliquable : ${card.embeds[0].description}`);

    // Staff exempté de l'AutoMod (« Gérer les messages ») : comme pour un message ordinaire.
    const staff = await h.slash('suggestion', sub('create', [opt('contenu', 3, 'Partenariat : discord.gg/partenaire')]), { as: 'mod', channel: 'general' });
    assert.ok(!h.isError(staff), h.replyText(staff));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R81 : /niveaux et hiérarchie

test('R81 /niveaux : « Gérer le serveur » ne fait pas s\'attribuer une récompense au-dessus de son rôle ni modifier un supérieur', async () => {
  const h = await createHarness();
  try {
    // Rôle « Temporaire » (position 1) avec Gérer le serveur, porté par la cible.
    updateRole(h, IDS.roles.temp, () => P.ManageGuild, 'préparation : Temporaire gère le serveur');
    const tm = h.fake.members.get(IDS.users.target);
    tm.roles = [IDS.roles.temp];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...tm }, 'préparation : cible Temporaire');
    await h.settle();
    h.configure({ levels: { enabled: true, rewards: [{ level: 30, roleId: IDS.roles.gamer }] } });

    const openXp = async (as, userId) => {
      const dash = await h.slash('niveaux', [], { as });
      const nav = await h.click(h.message(dash.original), 'cmd:niveaux:nav', { values: ['xp'], as });
      const sel = await h.click(h.message(nav.componentMessageId), 'cmd:niveaux:xpuser', { values: [userId], as });
      return h.message(sel.componentMessageId);
    };
    const setXp = async (as, userId, amount) => {
      const m = await openXp(as, userId);
      const btn = m.components.flatMap((r) => r.components).find((c) => c.custom_id === `cmd:niveaux:xp:set:${userId}`);
      const open = await h.click(m, btn.custom_id, { as });
      const rec = await h.submitModal(open, { amount: String(amount) }, { as });
      await h.settle();
      return rec;
    };

    // 1. Elle-même : XP modifiée, mais la récompense au-dessus de son rôle n'est pas donnée.
    await setXp('target', IDS.users.target, 100000);
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.gamer), 'récompense au-dessus de son rôle attribuée');

    // 2. Un supérieur (le membre « Joueur ») : refus, ni XP ni rôle modifiés.
    h.client.services.levels.levels.setXp(h.guild.id, IDS.users.member, 200000, require('../../src/services/LevelService').levelFromXp);
    const before = h.client.services.levels.levels.get(h.guild.id, IDS.users.member).xp;
    const rec = await setXp('target', IDS.users.member, 0);
    assert.ok(h.isError(rec), 'XP d\'un supérieur modifiée');
    assert.equal(h.client.services.levels.levels.get(h.guild.id, IDS.users.member).xp, before);
    assert.ok(h.fake.members.get(IDS.users.member).roles.includes(IDS.roles.gamer), 'récompense d\'un supérieur retirée');

    // Témoin : l'admin attribue l'XP et la récompense à un membre.
    await setXp('admin', IDS.users.target, 100000);
    assert.ok(h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.gamer), 'récompense non attribuée par l\'admin');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R88 : /invitations voir

test('R88 /invitations voir : les codes d\'un autre membre ne sont jamais affichés publiquement', async () => {
  const h = await createHarness({ ready: false });
  const DAY = 86_400_000;
  const invites = [
    { type: 0, code: 'StaffSecret42', guild: { id: IDS.guild, name: 'Serveur de test' }, channel: { id: IDS.channels.staff, name: 'staff', type: 0 }, inviter: h.fake.users.get(IDS.users.admin), uses: 3, max_uses: 0, max_age: 0, temporary: false, created_at: new Date(Date.now() - DAY).toISOString() },
    { type: 0, code: 'MonCodeAMoi', guild: { id: IDS.guild, name: 'Serveur de test' }, channel: { id: IDS.channels.general, name: 'général', type: 0 }, inviter: h.fake.users.get(IDS.users.member), uses: 1, max_uses: 0, max_age: 0, temporary: false, created_at: new Date(Date.now() - DAY).toISOString() },
  ];
  h.fake.routes.unshift({ method: 'GET', re: /^\/guilds\/(\d+)\/invites$/, keys: ['guild'], handler: () => JSON.parse(JSON.stringify(invites)) });
  h.configureAll();
  try {
    await h.emitReady();
    const activeField = (rec) => h.messagesOf(rec)[0].embeds[0].fields.find((f) => f.name.includes('Invitations actives'));
    const ephemeral = (rec) => Boolean(h.messagesOf(rec)[0].flags & 64);

    // Membre ordinaire qui regarde l'admin : carte publique, sans code.
    const other = await h.slash('invitations', sub('voir', [opt('membre', 6, IDS.users.admin)]), { as: 'member' });
    assert.ok(!/StaffSecret42/.test(activeField(other).value), `code d'un autre membre affiché : ${activeField(other).value}`);
    assert.match(activeField(other).name, /\(1\)/, 'nombre d\'invitations actives perdu');

    // Soi-même : codes visibles, en éphémère.
    const mine = await h.slash('invitations', sub('voir'), { as: 'member' });
    assert.match(activeField(mine).value, /MonCodeAMoi/);
    assert.ok(ephemeral(mine), 'ses propres codes affichés publiquement');

    // « Gérer le serveur » : codes d'un autre membre, en éphémère.
    const staff = await h.slash('invitations', sub('voir', [opt('membre', 6, IDS.users.member)]), { as: 'admin' });
    assert.match(activeField(staff).value, /MonCodeAMoi/);
    assert.ok(ephemeral(staff));

    // Bouton « Mes invitations » sur le classement public : codes masqués (message public).
    const board = await h.slash('invitations', sub('classement'), { as: 'target' });
    const click = await h.click(h.messagesOf(board)[0], `cmd:invitations:member:${IDS.users.target}`, { as: 'member' });
    const updated = h.message(click.componentMessageId) ?? h.messagesOf(click)[0];
    assert.ok(!/MonCodeAMoi/.test(JSON.stringify(updated.embeds)), 'codes affichés dans le classement public');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R89 : projets et AutoMod

test('R89 /projet : invitations, liens d\'arnaque et mots interdits refusés aux non-modérateurs ; réponse de création éphémère ; publication avec « Intégrer des liens »', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const projet = (name, options, as = 'member') => h.slash('projet', sub(name, options), { as, channel: 'general' });
    const r1 = await projet('creer', [opt('nom', 3, 'Cadeaux'), opt('description', 3, 'Nitro offert ici : discord.gg/arnaque')]);
    assert.ok(h.isError(r1), 'projet avec invitation accepté');
    const r2 = await projet('creer', [opt('nom', 3, 'Cadeaux'), opt('lien', 3, 'https://steamcornmunity.ru/login')]);
    assert.ok(h.isError(r2), 'projet avec lien non autorisé accepté');
    const r3 = await projet('creer', [opt('nom', 3, 'Projet interdit')]);
    assert.ok(h.isError(r3), 'projet avec mot interdit accepté');
    assert.equal(h.client.services.projects.repo.count(h.guild.id), 0);

    // Projet propre : réponse éphémère.
    const ok = await projet('creer', [opt('nom', 3, 'Jardin partagé'), opt('description', 3, 'On plante des tomates')]);
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.ok(h.messagesOf(ok)[0].flags & 64, 'réponse de création publique');
    // Ajouts ultérieurs filtrés aussi.
    const t = await projet('tache-ajouter', [opt('projet', 3, '1'), opt('titre', 3, 'Rejoindre discord.gg/arnaque')]);
    assert.ok(h.isError(t), 'tâche avec invitation acceptée');
    const l = await projet('lien-ajouter', [opt('projet', 3, '1'), opt('nom', 3, 'Site'), opt('url', 3, 'https://steamcornmunity.ru/login')]);
    assert.ok(h.isError(l), 'lien non autorisé accepté');

    // Publication : « Intégrer des liens » exigé de la personne dans le salon.
    const gen = h.fake.channels.get(IDS.channels.general);
    const updated = { ...gen, permission_overwrites: [...gen.permission_overwrites, { id: IDS.roles.member, type: 0, allow: '0', deny: P.EmbedLinks.toString() }, { id: IDS.roles.everyone, type: 0, allow: '0', deny: P.EmbedLinks.toString() }] };
    h.fake.channels.set(gen.id, updated);
    h.fake.dispatchNow('CHANNEL_UPDATE', updated, 'préparation : pas d\'intégration de liens dans #général');
    await h.settle();
    const mark = h.fake.messageLog.length;
    const pub = await h.click(h.messagesOf(ok)[0], h.messagesOf(ok)[0].components.flatMap((r) => r.components).find((c) => c.custom_id?.startsWith('cmd:projet:publish:')).custom_id, { as: 'member', channel: 'general' });
    assert.ok(h.isError(pub), 'publication sans « Intégrer des liens » acceptée');
    assert.equal(botMessagesIn(h, IDS.channels.general, mark).filter((m) => !(m.flags & 64)).length, 0);

    // Modérateur (exempté de l'AutoMod) : accepté comme un message ordinaire.
    const mod = await projet('creer', [opt('nom', 3, 'Partenariat'), opt('description', 3, 'discord.gg/partenaire')], 'mod');
    assert.ok(!h.isError(mod), h.replyText(mod));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R5 (partie /giveaway create) et R82

test('R5 /giveaway create : interaction acquittée avant la publication (envoi lent : pas d\'expiration ni de doublon)', async () => {
  const h = await createHarness();
  try {
    const orig = h.client.rest.request.bind(h.client.rest);
    h.client.rest.request = async (o) => {
      if (String(o.method).toUpperCase() === 'POST' && o.fullRoute === `/channels/${IDS.channels.general}/messages`) await sleep(3_200);
      return orig(o);
    };
    const rec = await h.slash('giveaway', sub('create', [opt('recompense', 3, 'Nitro'), opt('duree', 3, '1h')]), { as: 'admin', channel: 'general' });
    await h.waitFor(() => /lancé/.test(h.replyText(rec)), { timeout: 6_000 });
    assert.ok(rec.ackType != null && rec.ackedAt - rec.createdAt < 3_000, `acquittée après ${rec.ackedAt - rec.createdAt} ms`);
    assert.match(h.replyText(rec), /Giveaway #\d+ lancé/);
    assert.equal(h.client.repositories.giveaways.listActive(h.guild.id).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R82 giveaway : double clic sur « Relancer » → un seul nouveau tirage annoncé', async () => {
  const h = await createHarness();
  try {
    const rec = await h.slash('giveaway', sub('create', [opt('recompense', 3, 'Nitro'), opt('duree', 3, '1h')]), { as: 'admin', channel: 'general' });
    assert.match(h.replyText(rec), /lancé/);
    const g = h.client.repositories.giveaways.listActive(h.guild.id)[0];
    for (const as of ['member', 'target', 'mod']) h.client.repositories.giveaways.addEntry(g.id, IDS.users[as]);
    await h.slash('giveaway', sub('end', [opt('id', 4, g.id)]), { as: 'admin' });
    const card = h.message(h.client.repositories.giveaways.get(g.id).message_id);
    const btn = card.components.flatMap((r) => r.components).find((c) => c.custom_id === `cmd:giveaway:reroll:${g.id}`);
    assert.ok(btn, 'bouton « Relancer » absent');
    const mark = h.fake.messageLog.length;
    const [a, b] = await Promise.all([h.click(card, btn.custom_id, { as: 'admin' }), h.click(card, btn.custom_id, { as: 'admin' })]);
    await h.settle();
    const announces = h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && !(m.flags & 64) && m.channel_id === IDS.channels.general);
    assert.equal(announces.length, 1, `annonces du nouveau tirage : ${announces.length}`);
    assert.equal([a, b].filter((r) => h.isError(r)).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R83 / R84 : récompenses et rôles automatiques

test('R83 niveaux : un membre qui revient retrouve ses rôles de récompense (après la vérification si elle est active)', async () => {
  const h = await createHarness();
  try {
    h.configure({ automod: { enabled: false }, levels: { enabled: true, cooldownSeconds: 0, minLength: 1, rewards: [{ level: 1, roleId: IDS.roles.notif }] } });
    const lvl = require('../../src/services/LevelService');
    const u = h.addUser('Habitué', { ageDays: 500 });
    await h.memberJoin(u);
    h.client.repositories.levels.setXp(h.guild.id, u.id, lvl.totalXpForLevel(3), lvl.levelFromXp);
    await h.memberLeave(u.id);
    await h.memberJoin(u);
    await h.settle();
    assert.ok(await h.waitFor(() => h.fake.members.get(u.id).roles.includes(IDS.roles.notif), { timeout: 1_500 }), 'récompense non rendue au retour');

    // Vérification active (mode ajout) : rien avant la vérification, rendue après.
    h.configure({ welcome: { verification: { enabled: true, mode: 'add', roleId: IDS.roles.member, channelId: IDS.channels.rules } } });
    const v = h.addUser('Revenant', { ageDays: 500 });
    await h.memberJoin(v);
    h.client.repositories.levels.setXp(h.guild.id, v.id, lvl.totalXpForLevel(3), lvl.levelFromXp);
    await h.memberLeave(v.id);
    await h.memberJoin(v);
    await h.settle();
    assert.ok(!h.fake.members.get(v.id).roles.includes(IDS.roles.notif), 'récompense rendue avant la vérification');
    const panel = await publishVerifyPanel(h);
    await h.click(panel, 'cmd:bienvenue:verify', { as: v.id });
    assert.ok(await h.waitFor(() => h.fake.members.get(v.id).roles.includes(IDS.roles.notif), { timeout: 1_500 }), 'récompense non rendue après la vérification');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R84 rôle devenu sensible : plus distribué par l\'accueil ni par les niveaux', async () => {
  const h = await createHarness();
  try {
    h.configure({
      automod: { enabled: false },
      welcome: { autoRoles: { humans: [IDS.roles.gamer], bots: [] } },
      levels: { enabled: true, cooldownSeconds: 0, minLength: 1, rewards: [{ level: 1, roleId: IDS.roles.notif }] },
    });
    updateRole(h, IDS.roles.gamer, () => P.BanMembers, 'préparation : Joueur peut bannir');
    const gen = h.fake.channels.get(IDS.channels.general);
    const updated = { ...gen, permission_overwrites: [...gen.permission_overwrites, { id: IDS.roles.notif, type: 0, allow: P.ManageMessages.toString(), deny: '0' }] };
    h.fake.channels.set(gen.id, updated);
    h.fake.dispatchNow('CHANNEL_UPDATE', updated, 'préparation : Notifications gère les messages dans #général');
    await h.settle();

    const u = h.addUser('Nouveau', { ageDays: 300 });
    await h.memberJoin(u);
    assert.ok(!h.fake.members.get(u.id).roles.includes(IDS.roles.gamer), 'rôle automatique sensible attribué');

    h.client.services.levels.grantDelayMs = 0;
    for (let i = 0; i < 12; i += 1) await h.userMessage({ as: 'target', content: `message ${i} pour monter de niveau` });
    await sleep(100);
    await h.settle();
    assert.ok((h.client.repositories.levels.get(h.guild.id, IDS.users.target)?.level ?? 0) >= 1, 'calibrage : niveau 1 non atteint');
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.notif), 'récompense sensible attribuée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ R113 : signalements et ping du staff

test('R113 signalements : rôle du staff pingué au plus une fois par période ; rôle non mentionnable refusé sans « Mentionner @everyone »', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ reports: { channelId: IDS.channels.staff, pingRoleId: IDS.roles.mod } });
  try {
    for (const [as, author] of [['member', 'target'], ['target', 'member'], ['admin', 'member']]) {
      const m = await h.userMessage({ as: author, channel: 'general', content: `message banal de ${author} ${Math.random()}` });
      const menu = await h.contextMenu('Signaler le message', m, { as });
      assert.ok(menu.modals?.length, h.replyText(menu));
      await h.submitModal(menu, { raison: 'spam' });
    }
    const posts = h.fake.calls.filter((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.staff}/messages`);
    assert.equal(posts.length, 3, 'cartes de signalement manquantes');
    const pings = posts.filter((c) => (c.body?.allowed_mentions?.roles ?? []).includes(IDS.roles.mod) && c.body.content?.includes(IDS.roles.mod)).length;
    assert.equal(pings, 1, `pings du rôle du staff : ${pings}`);

    // Configuration : « Gérer le serveur » sans « Mentionner @everyone » ne choisit pas un rôle non mentionnable.
    updateRole(h, IDS.roles.temp, () => P.ManageGuild, 'préparation : Temporaire gère le serveur');
    const tm = h.fake.members.get(IDS.users.target);
    tm.roles = [IDS.roles.temp];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...tm }, 'préparation : cible Temporaire');
    await h.settle();
    h.configure({ reports: { pingRoleId: null } });
    const dash = await h.slash('signalements', [], { as: 'target' });
    const pick = await h.click(h.messagesOf(dash)[0], 'cmd:signalements:role', { values: [IDS.roles.admin], as: 'target' });
    assert.ok(h.isError(pick), 'rôle non mentionnable accepté sans « Mentionner @everyone »');
    assert.equal(h.client.services.config.get(h.guild.id).reports.pingRoleId, null);
    const ok = await h.click(h.messagesOf(dash)[0], 'cmd:signalements:role', { values: [IDS.roles.notif], as: 'target' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(h.client.services.config.get(h.guild.id).reports.pingRoleId, IDS.roles.notif);
    h.fake.massMentions.length = 0; // ping légitime et plafonné du rôle du staff
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
