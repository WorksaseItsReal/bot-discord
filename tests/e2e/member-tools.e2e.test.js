'use strict';

/**
 * Bout en bout : outils des membres — absences (/afk), alertes de mots-clés (/alertes),
 * snipe (/snipe) et leur tableau de bord (/alertes config) — sur le vrai discord.js.
 * Messages, modifications, suppressions et départs passent par les handlers réels.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sub = (name, options = []) => [{ name, type: 1, options }];
const opt = (name, type, value) => ({ name, type, value });
const group = (g, name, options = []) => [{ name: g, type: 2, options: [{ name, type: 1, options }] }];

/** Messages privés reçus par un membre (canal MP créé par le bot). */
function dmsOf(h, as) {
  const userId = IDS.users[as] ?? as;
  const dm = [...h.fake.dms.values()].find((d) => d.recipients[0].id === userId);
  if (!dm) return [];
  return [...h.fake.messages.values()].filter((m) => m.channel_id === dm.id && m.author.id === h.client.user.id);
}

/** Messages publiés par le bot dans un salon depuis `mark` (position dans messageLog). */
function botMessagesIn(h, channelId, mark = 0) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}

/** Bot plus rapide pour les tests : délais post-AutoMod et durées d'affichage réduits. */
function fast(h) {
  Object.assign(h.client.services.highlights, { delayMs: 5 });
  Object.assign(h.client.services.afk, { delayMs: 5, ttlMs: 60 });
}

/** AutoMod réduit au filtre de mots interdits (« interdit ») : les rafales de test ne sont pas du spam. */
function onlyBadWords(h) {
  const filters = Object.fromEntries(Object.keys(h.client.services.config.get(h.guild.id).automod.filters).map((k) => [k, { enabled: k === 'badWords' }]));
  h.configure({ automod: { filters, newMembers: { enabled: false } } });
}

test('/alertes config : chaque bouton du tableau de bord ; refus sans « Gérer le serveur »', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('alertes', sub('config'));
    assert.match(h.replyText(rec), /Outils des membres · Configuration/);
    const stats = await explore(h, rec, { budget: 60 });
    for (const key of ['cfg', 'cfgview']) assert.ok(stats.keys.has(`cmd:alertes:${key}`), `${key} jamais utilisé`);
    // Chaque bascule a été essayée : on revient à l'état voulu par les boutons eux-mêmes.
    const view = h.messagesOf(await h.slash('alertes', sub('config')))[0];
    const tools = () => h.client.services.config.get(h.guild.id).memberTools;
    for (const key of ['afk', 'nick', 'highlights', 'snipe']) {
      const on = h.findComponent(view, `cmd:alertes:cfg:${key}:on`);
      if (on) await h.click(view, on.custom_id);
    }
    assert.deepEqual(tools(), { afk: { enabled: true, nickname: true }, highlights: { enabled: true }, snipe: { enabled: true } });
    const off = await h.click(h.messagesOf(await h.slash('alertes', sub('config')))[0], 'cmd:alertes:cfg:snipe:off');
    assert.match(h.replyText(off), /Snipe \*\*désactivé\*\* \(mémoire vidée\)/);
    assert.equal(tools().snipe.enabled, false);

    // Membre : sous-commande refusée, boutons de l'administrateur sans effet.
    assert.ok(h.isError(await h.slash('alertes', sub('config'), { as: 'member' })));
    const admin = await h.slash('alertes', sub('config'));
    const before = JSON.stringify(tools());
    await explore(h, admin, { as: 'member', budget: 20 });
    assert.equal(JSON.stringify(tools()), before, 'un membre a modifié la configuration');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/alertes : ajouter, liste (menus, formulaire, pause), retirer (autocomplétion), bloquer salon et membre', async () => {
  const h = await createHarness();
  h.configureAll();
  const repo = h.client.repositories.highlights;
  const entry = () => repo.get(h.guild.id, IDS.users.member);
  try {
    const added = await h.slash('alertes', sub('ajouter', [opt('mot', 3, '  Inspecteur   Gadget ')]), { as: 'member' });
    assert.match(h.replyText(added), /Mot-clé `Inspecteur Gadget` ajouté \(1 \/ 10\)/);
    assert.deepEqual(entry().words, ['Inspecteur Gadget']);
    // Doublon (casse et accents ignorés), trop court, sans lettre : refusés.
    for (const bad of ['inspecteur gadgét', 'ab', '!!!', 'a b']) assert.ok(h.isError(await h.slash('alertes', sub('ajouter', [opt('mot', 3, bad)]), { as: 'member' })), bad);
    assert.equal(entry().words.length, 1);

    // Vue « liste » explorée : retrait par le menu, formulaire d'ajout, pause, blocages.
    const list = await h.slash('alertes', sub('liste'), { as: 'member' });
    assert.match(h.replyText(list), /Vos alertes de mots-clés/);
    const stats = await explore(h, list, { as: 'member', budget: 40 });
    for (const key of ['remove', 'add', 'pause', 'view', 'chans', 'users']) assert.ok(stats.keys.has(`cmd:alertes:${key}`), `${key} jamais utilisé`);
    assert.ok(stats.modals >= 1, 'formulaire d\'ajout jamais soumis');

    // Formulaire : ajout explicite, puis 10 mots-clés au plus.
    const fresh = await h.slash('alertes', sub('liste'), { as: 'member' });
    const form = await h.click(h.messagesOf(fresh)[0], 'cmd:alertes:add', { as: 'member' });
    const saved = await h.submitModal(form, { mot: 'Pénélope' });
    assert.match(h.replyText(saved), /Mot-clé `Pénélope` ajouté/);
    for (let i = entry().words.length; i < 10; i += 1) await h.slash('alertes', sub('ajouter', [opt('mot', 3, `motcle${i}`)]), { as: 'member' });
    assert.equal(entry().words.length, 10);
    assert.ok(h.isError(await h.slash('alertes', sub('ajouter', [opt('mot', 3, 'onzieme')]), { as: 'member' })));
    const full = await h.slash('alertes', sub('liste'), { as: 'member' });
    assert.equal(h.findComponent(h.messagesOf(full)[0], 'cmd:alertes:add').disabled, true, 'bouton « Ajouter » actif à 10 mots-clés');

    // Retrait par la commande, autocomplétion réelle.
    const ac = await h.autocomplete('alertes', [{ name: 'retirer', type: 1, options: [{ name: 'mot', type: 3, value: 'péné', focused: true }] }], { as: 'member' });
    assert.deepEqual(ac.autocomplete.map((c) => c.value), ['Pénélope']);
    const removed = await h.slash('alertes', sub('retirer', [opt('mot', 3, 'PENELOPE')]), { as: 'member' });
    assert.match(h.replyText(removed), /Mot-clé `Pénélope` retiré/);
    assert.ok(h.isError(await h.slash('alertes', sub('retirer', [opt('mot', 3, 'inconnu')]), { as: 'member' })));

    // Pause (bascule), blocages (bascule) ; soi-même et les bots refusés.
    const paused = entry().paused;
    await h.slash('alertes', sub('pause'), { as: 'member' });
    assert.equal(entry().paused, paused ? 0 : 1);
    await h.slash('alertes', sub('pause'), { as: 'member' });
    assert.equal(entry().paused, paused ? 1 : 0);
    if (entry().paused) await h.slash('alertes', sub('pause'), { as: 'member' });
    const wasBlocked = entry().blockedChannels.includes(IDS.channels.rules);
    if (wasBlocked) await h.slash('alertes', group('bloquer', 'salon', [opt('salon', 7, IDS.channels.rules)]), { as: 'member' });
    const blocked = await h.slash('alertes', group('bloquer', 'salon', [opt('salon', 7, IDS.channels.rules)]), { as: 'member' });
    assert.match(h.replyText(blocked), /bloqué : plus aucune alerte/);
    assert.ok(entry().blockedChannels.includes(IDS.channels.rules));
    const unblocked = await h.slash('alertes', group('bloquer', 'salon', [opt('salon', 7, IDS.channels.rules)]), { as: 'member' });
    assert.match(h.replyText(unblocked), /débloqué/);
    assert.ok(!entry().blockedChannels.includes(IDS.channels.rules), 'salon non débloqué');
    if (entry().blockedUsers.includes(IDS.users.target)) await h.slash('alertes', group('bloquer', 'membre', [opt('membre', 6, IDS.users.target)]), { as: 'member' });
    await h.slash('alertes', group('bloquer', 'membre', [opt('membre', 6, IDS.users.target)]), { as: 'member' });
    assert.ok(entry().blockedUsers.includes(IDS.users.target));
    assert.ok(h.isError(await h.slash('alertes', group('bloquer', 'membre', [opt('membre', 6, IDS.users.member)]), { as: 'member' })));
    assert.ok(h.isError(await h.slash('alertes', group('bloquer', 'membre', [opt('membre', 6, IDS.users.otherBot)]), { as: 'member' })));

    // Fonction désactivée : ajout refusé, gestion toujours possible.
    h.configure({ memberTools: { highlights: { enabled: false } } });
    assert.ok(h.isError(await h.slash('alertes', sub('ajouter', [opt('mot', 3, 'nouveau')]), { as: 'member' })));
    const off = await h.slash('alertes', sub('liste'), { as: 'member' });
    assert.match(h.replyText(off), /désactivées\*\* sur ce serveur/);
    assert.ok(!h.isError(await h.slash('alertes', sub('retirer', [opt('mot', 3, 'motcle9')]), { as: 'member' })));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('alertes : MP si le membre peut voir le salon, mot entier, cooldown, activité, blocages, AutoMod, pause automatique', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyBadWords(h);
  fast(h);
  const svc = h.client.services.highlights;
  const G = IDS.channels;
  const settle = async () => {
    await sleep(25);
    await h.settle();
  };
  try {
    await h.slash('alertes', sub('ajouter', [opt('mot', 3, 'gadget')]), { as: 'member' });
    await h.slash('alertes', sub('ajouter', [opt('mot', 3, 'Gadget')]), { as: 'mod' });
    await h.slash('alertes', sub('ajouter', [opt('mot', 3, 'docteur gang')]), { as: 'mod' });

    // Mot entier, casse et accents ignorés : les deux membres alertés, avec le contexte.
    let mark = h.fake.calls.length;
    const msg = await h.userMessage({ as: 'target', content: 'L\'inspecteur GADGÉT arrive ! <@' + IDS.users.admin + '> @everyone' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'membre non alerté');
    assert.equal(dmsOf(h, 'mod').length, 1, 'modérateur non alerté');
    const dm = dmsOf(h, 'member')[0];
    const embed = dm.embeds[0];
    assert.match(embed.title, /Mot-clé mentionné : « gadget »/);
    assert.match(embed.description, /^> L'inspecteur GADGÉT arrive/);
    assert.ok(embed.fields.some((f) => /Auteur/.test(f.name) && f.value.includes(IDS.users.target)));
    assert.ok(embed.fields.some((f) => /Salon/.test(f.name) && f.value.includes(G.general)));
    const link = dm.components[0].components[0];
    assert.equal(link.style, 5);
    assert.match(link.url, new RegExp(`/channels/${h.guild.id}/${G.general}/${msg.id}$`));
    const posts = h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.route) && h.fake.dms.has(c.route.split('/')[2]));
    assert.ok(posts.length >= 2 && posts.every((c) => JSON.stringify(c.body.allowed_mentions) === JSON.stringify({ parse: [] })), 'un MP pourrait notifier');

    // Cooldown de 5 min par (membre, salon) ; mot-clé de plusieurs mots ; mot partiel ignoré.
    await h.userMessage({ as: 'target', content: 'encore gadget, et le docteur gang' });
    await h.userMessage({ as: 'target', content: 'gadgets et gadgetophone' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'cooldown ignoré');
    assert.equal(dmsOf(h, 'mod').length, 1, 'cooldown ignoré (modérateur)');
    svc.cooldowns.clear();
    await h.userMessage({ as: 'target', content: 'le Docteur  Gang revient' });
    await settle();
    assert.equal(dmsOf(h, 'mod').length, 2);
    assert.match(dmsOf(h, 'mod')[1].embeds[0].title, /docteur gang/);
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte pour un mot-clé d\'un autre membre');

    // Salon réservé au staff : seul le modérateur (qui peut le voir) est alerté.
    svc.cooldowns.clear();
    await h.userMessage({ as: 'admin', channel: 'staff', content: 'réunion gadget' });
    await settle();
    assert.equal(dmsOf(h, 'mod').length, 3, 'modérateur non alerté dans #staff');
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte pour un salon que le membre ne peut pas voir');

    // Ses propres messages, les bots : jamais.
    svc.cooldowns.clear();
    await h.userMessage({ as: 'member', channel: 'announcements', content: 'mon gadget' });
    await h.userMessage({ as: 'otherBot', channel: 'announcements', content: 'gadget' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte pour son propre message ou celui d\'un bot');

    // Activité : le membre vient d'écrire dans #annonces → pas d'alerte ; le modérateur, si.
    svc.cooldowns.clear();
    const modBefore = dmsOf(h, 'mod').length;
    await h.userMessage({ as: 'target', channel: 'announcements', content: 'gadget en vue' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte alors que le membre participe à la conversation');
    assert.equal(dmsOf(h, 'mod').length, modBefore + 1);

    // Blocages : membre bloqué, salon (catégorie) bloqué.
    svc.cooldowns.clear();
    svc.activity.clear();
    await h.slash('alertes', group('bloquer', 'membre', [opt('membre', 6, IDS.users.target)]), { as: 'member' });
    await h.userMessage({ as: 'target', channel: 'rules', content: 'gadget' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte venant d\'un membre bloqué');
    await h.slash('alertes', group('bloquer', 'membre', [opt('membre', 6, IDS.users.target)]), { as: 'member' });
    await h.slash('alertes', group('bloquer', 'salon', [opt('salon', 7, IDS.channels.catGeneral)]), { as: 'member' });
    svc.cooldowns.clear();
    await h.userMessage({ as: 'target', channel: 'rules', content: 'gadget' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte venant d\'une catégorie bloquée');
    await h.slash('alertes', group('bloquer', 'salon', [opt('salon', 7, IDS.channels.catGeneral)]), { as: 'member' });

    // Message supprimé par l'AutoMod (mot interdit) : aucun MP.
    svc.cooldowns.clear();
    Object.assign(svc, { delayMs: 150 });
    const spam = await h.userMessage({ as: 'target', channel: 'rules', content: 'gadget interdit' });
    await sleep(200);
    await h.settle();
    assert.ok(!h.fake.messages.has(spam.id), 'message non supprimé par l\'AutoMod');
    assert.equal(dmsOf(h, 'member').length, 1, 'MP pour un message filtré par l\'AutoMod');
    Object.assign(svc, { delayMs: 5 });

    // MP fermés : 3 échecs d'affilée → pause automatique, signalée dans /alertes liste ; reprise.
    const dmChannel = [...h.fake.dms.values()].find((d) => d.recipients[0].id === IDS.users.member);
    h.fake.inject({ method: 'POST', route: `/channels/${dmChannel.id}/messages` }, { status: 403, code: 50007, message: 'Cannot send messages to this user', times: 3 });
    for (let i = 0; i < 3; i += 1) {
      svc.cooldowns.clear();
      await h.userMessage({ as: 'target', channel: 'rules', content: `gadget ${i}` });
      await settle();
    }
    const row = h.client.repositories.highlights.get(h.guild.id, IDS.users.member);
    assert.equal(row.paused, 2, 'pas de pause automatique après 3 échecs');
    svc.cooldowns.clear();
    await h.userMessage({ as: 'target', channel: 'rules', content: 'gadget après la pause' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 1, 'alerte envoyée pendant la pause');
    const list = await h.slash('alertes', sub('liste'), { as: 'member' });
    assert.match(h.replyText(list), /pause automatique/);
    const resumed = await h.click(h.messagesOf(list)[0], 'cmd:alertes:pause:off', { as: 'member' });
    assert.match(h.replyText(resumed), /reprises/);
    assert.equal(h.client.repositories.highlights.get(h.guild.id, IDS.users.member).paused, 0);
    svc.cooldowns.clear();
    await h.userMessage({ as: 'target', channel: 'rules', content: 'gadget de retour' });
    await settle();
    assert.equal(dmsOf(h, 'member').length, 2, 'alertes non reprises');

    // Départ : alertes effacées.
    await h.memberLeave(IDS.users.mod);
    assert.equal(h.client.repositories.highlights.get(h.guild.id, IDS.users.mod), null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/afk : préfixe du pseudo, réponse aux mentions (auto-supprimée, cooldown), retour au premier message, raison filtrée', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyBadWords(h);
  fast(h);
  const afk = h.client.services.afk;
  const G = IDS.channels;
  const nick = (as) => h.fake.members.get(IDS.users[as] ?? as)?.nick ?? null;
  const notices = (channelId, mark) => botMessagesIn(h, channelId, mark).filter((m) => /absent/i.test(m.embeds?.[0]?.title ?? ''));
  try {
    // Raison refusée : mot interdit de l'AutoMod, mentions de masse.
    for (const bad of ['c\'est interdit', 'ping @everyone', `<@&${IDS.roles.mod}>`]) {
      assert.ok(h.isError(await h.slash('afk', [opt('raison', 3, bad)], { as: 'member' })), bad);
    }
    assert.equal(afk.isAfk(h.guild.id, IDS.users.member), false);

    const rec = await h.slash('afk', [opt('raison', 3, 'Parti déjeuner')], { as: 'member' });
    assert.match(h.replyText(rec), /Vous êtes AFK/);
    assert.equal(nick('member'), '[AFK] Membre');
    const row = h.client.repositories.afk.get(h.guild.id, IDS.users.member);
    assert.equal(row.reason, 'Parti déjeuner');
    assert.equal(row.old_nick, null);
    assert.equal(row.afk_nick, '[AFK] Membre');
    await explore(h, rec, { as: 'member', budget: 5 });

    // Mention : réponse courte, sans notification, supprimée après le délai ; puis cooldown de 30 s par salon.
    let mark = h.fake.messageLog.length;
    let calls = h.fake.calls.length;
    await h.userMessage({ as: 'target', content: `<@${IDS.users.member}> tu es là ?` });
    await h.waitFor(() => notices(G.general, mark).length === 1);
    const notice = notices(G.general, mark)[0];
    assert.match(notice.embeds[0].description, /est \*\*AFK\*\* depuis <t:\d+:R>/);
    assert.match(notice.embeds[0].description, /> Parti déjeuner/);
    const post = h.fake.calls.slice(calls).find((c) => c.method === 'POST' && c.route === `/channels/${G.general}/messages`);
    assert.deepEqual(post.body.allowed_mentions, { parse: [], replied_user: false });
    await h.waitFor(() => !h.fake.messages.has(notice.id));
    assert.ok(!h.fake.messages.has(notice.id), 'réponse non supprimée');
    mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'admin', content: `<@${IDS.users.member}> ?` });
    await sleep(30);
    await h.settle();
    assert.equal(notices(G.general, mark).length, 0, 'cooldown ignoré');
    await h.userMessage({ as: 'admin', channel: 'rules', content: `<@${IDS.users.member}> ?` });
    await h.waitFor(() => notices(G.rules, mark).length === 1);
    assert.equal(notices(G.rules, mark).length, 1, 'cooldown non propre au salon');

    // Raison mise à jour sans perdre le début de l'absence ni le pseudo.
    const again = await h.slash('afk', [opt('raison', 3, 'Réunion')], { as: 'member' });
    assert.match(h.replyText(again), /Raison mise à jour/);
    assert.equal(h.client.repositories.afk.get(h.guild.id, IDS.users.member).since, row.since);

    // Le membre écrit : de retour, pseudo rétabli, message supprimé après le délai.
    mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'member', content: 'me revoilà' });
    await h.waitFor(() => botMessagesIn(h, G.general, mark).length >= 1);
    const back = botMessagesIn(h, G.general, mark)[0];
    assert.match(back.embeds[0].title, /De retour/);
    assert.equal(nick('member'), null, 'pseudo non rétabli');
    assert.equal(afk.isAfk(h.guild.id, IDS.users.member), false);
    assert.equal(h.client.repositories.afk.get(h.guild.id, IDS.users.member), null);
    await h.waitFor(() => !h.fake.messages.has(back.id));
    assert.ok(!h.fake.messages.has(back.id), 'message de retour non supprimé');
    mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'target', content: `<@${IDS.users.member}> re` });
    await sleep(30);
    await h.settle();
    assert.equal(notices(G.general, mark).length, 0, 'réponse pour un membre revenu');

    // Pseudo de serveur conservé ; nom long raccourci à 32 caractères.
    const long = h.addUser('Un pseudo vraiment beaucoup trop long');
    await h.memberJoin(long);
    h.fake.members.get(long.id).nick = 'Surnom de trente caractères !';
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', h.fake.memberWithGuild(h.fake.members.get(long.id)));
    await h.settle();
    await h.slash('afk', [], { as: long.id });
    assert.ok(nick(long.id).startsWith('[AFK] ') && nick(long.id).length <= 32, nick(long.id));
    assert.equal(h.client.repositories.afk.get(h.guild.id, long.id).old_nick, 'Surnom de trente caractères !');
    await h.userMessage({ as: long.id, content: 'coucou' });
    await h.waitFor(() => nick(long.id) === 'Surnom de trente caractères !');
    assert.equal(nick(long.id), 'Surnom de trente caractères !');

    // Propriétaire : pseudo inchangé, expliqué. Pseudo modifié pendant l'absence : laissé tel quel.
    const owner = await h.slash('afk', [], { as: 'owner' });
    assert.match(h.replyText(owner), /propriétaire/);
    assert.equal(nick('owner'), null);
    await h.slash('afk', [], { as: 'target' });
    assert.equal(nick('target'), '[AFK] Cible');
    h.fake.members.get(IDS.users.target).nick = 'Choisi par un modo';
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', h.fake.memberWithGuild(h.fake.members.get(IDS.users.target)));
    await h.settle();
    await h.userMessage({ as: 'target', content: 'je suis là' });
    await sleep(20);
    await h.settle();
    assert.equal(nick('target'), 'Choisi par un modo');

    // Fonction désactivée : /afk refusé, pas de réponse aux mentions, mais un absent revient toujours.
    await h.slash('afk', [], { as: 'member' });
    assert.equal(nick('member'), '[AFK] Membre');
    h.configure({ memberTools: { afk: { enabled: false } } });
    assert.ok(h.isError(await h.slash('afk', [], { as: 'mod' })));
    afk.cooldowns.clear();
    mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'admin', channel: 'announcements', content: `<@${IDS.users.member}>` });
    await sleep(30);
    await h.settle();
    assert.equal(notices(G.announcements, mark).length, 0, 'réponse alors que l\'AFK est désactivé');
    await h.userMessage({ as: 'member', channel: 'announcements', content: 'retour' });
    await h.waitFor(() => nick('member') === null);
    assert.equal(nick('member'), null);
    assert.equal(botMessagesIn(h, G.announcements, mark).length, 0, 'message de retour alors que l\'AFK est désactivé');

    // Préfixe désactivé : absence sans renommage. Départ : absence oubliée.
    h.configure({ memberTools: { afk: { enabled: true, nickname: false } } });
    await h.slash('afk', [], { as: 'member' });
    assert.equal(nick('member'), null);
    assert.ok(afk.isAfk(h.guild.id, IDS.users.member));
    await h.memberLeave(IDS.users.member);
    assert.equal(h.client.repositories.afk.get(h.guild.id, IDS.users.member), null);
    assert.equal(afk.isAfk(h.guild.id, IDS.users.member), false);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/snipe : supprimé et modifié, AutoMod et bots ignorés, salons ignorés des logs, permissions, expiration, journal', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyBadWords(h);
  const snipe = h.client.services.snipe;
  const G = IDS.channels;
  const run = (kind, options = [], ctx = {}) => h.slash('snipe', sub(kind, options), { as: 'mod', ...ctx });
  const embedOf = (rec) => h.messagesOf(rec)[0]?.embeds?.[0];
  const logsMark = () => h.fake.messageLog.length;
  const logCards = (mark, re) => botMessagesIn(h, G.logs, mark).filter((m) => re.test(m.embeds?.[0]?.title ?? ''));
  try {
    // Rien en mémoire.
    const empty = await run('supprime');
    assert.match(h.replyText(empty), /Rien à afficher/);

    // Message supprimé (texte + pièce jointe) : contenu en embed, pièce jointe par son nom.
    const file = { id: '1', filename: 'plan-secret.pdf', size: 10, url: 'https://cdn.discordapp.com/attachments/1/2/plan-secret.pdf', proxy_url: 'https://media.discordapp.net/attachments/1/2/plan-secret.pdf', content_type: 'application/pdf' };
    const msg = await h.userMessage({ as: 'target', content: 'Le code est 1234 @everyone', extra: { attachments: [file] } });
    await h.deleteUserMessage(msg.id);
    let mark = logsMark();
    const shown = await run('supprime');
    const card = embedOf(shown);
    assert.match(card.title, /Dernier message supprimé/);
    assert.match(card.description, /Le code est 1234/);
    assert.ok(card.fields.some((f) => /Pièces jointes \(1\)/.test(f.name) && f.value.includes('plan-secret.pdf')));
    assert.ok(!JSON.stringify(card).includes('cdn.discordapp.com/attachments'), 'URL de pièce jointe exposée');
    assert.ok(card.fields.some((f) => /Auteur/.test(f.name) && f.value.includes(IDS.users.target)));
    assert.equal(h.messagesOf(shown)[0].flags & 64, 64, 'réponse publique');
    await h.waitFor(() => logCards(mark, /Snipe consulté/).length === 1);
    assert.equal(logCards(mark, /Snipe consulté/).length, 1, 'consultation non journalisée');

    // Modification : avant / après, lien vers le message.
    const edited = await h.userMessage({ as: 'member', channel: 'rules', content: 'premier jet' });
    await h.editUserMessage(edited.id, 'version corrigée');
    const ed = await run('modifie', [opt('salon', 7, G.rules)]);
    const edCard = embedOf(ed);
    assert.match(edCard.title, /Dernière modification/);
    assert.ok(edCard.fields.some((f) => /Avant/.test(f.name) && f.value.includes('premier jet')));
    assert.ok(edCard.fields.some((f) => /Après/.test(f.name) && f.value.includes('version corrigée')));
    assert.match(h.messagesOf(ed)[0].components[0].components[0].url, new RegExp(`/${edited.id}$`));
    await explore(h, ed, { as: 'mod', budget: 5 });

    // AutoMod : le message filtré n'est jamais retenu, et la marque reste pour les logs
    // (pas de « Message supprimé » en double dans le salon des messages).
    const automodDeleted = logsMark();
    const bad = await h.userMessage({ as: 'target', content: 'mot interdit ici' });
    await h.waitFor(() => !h.fake.messages.has(bad.id));
    assert.ok(!h.fake.messages.has(bad.id), 'message non supprimé par l\'AutoMod');
    const still = await run('supprime');
    assert.match(embedOf(still).description, /Le code est 1234/, 'le snipe montre le message filtré par l\'AutoMod');
    assert.equal(logCards(automodDeleted, /Message supprimé/).length, 0, 'marque de l\'AutoMod consommée : log en double');
    // Modifié puis filtré par l'AutoMod : la modification est oubliée aussi.
    const sneaky = await h.userMessage({ as: 'target', channel: 'announcements', content: 'bonjour' });
    await h.editUserMessage(sneaky.id, 'bonjour interdit');
    await h.waitFor(() => !h.fake.messages.has(sneaky.id));
    assert.match(h.replyText(await run('modifie', [opt('salon', 7, G.announcements)])), /Rien à afficher/);

    // Bots ignorés ; salons ignorés par les logs ignorés.
    const botMsg = await h.userMessage({ as: 'otherBot', channel: 'announcements', content: 'message de bot' });
    await h.deleteUserMessage(botMsg.id);
    assert.match(h.replyText(await run('supprime', [opt('salon', 7, G.announcements)])), /Rien à afficher/);
    h.configure({ logs: { ignoredChannels: [G.catGeneral] } });
    const quiet = await h.userMessage({ as: 'target', channel: 'rules', content: 'salon ignoré' });
    await h.deleteUserMessage(quiet.id);
    assert.match(h.replyText(await run('supprime', [opt('salon', 7, G.rules)])), /Rien à afficher/);
    h.configure({ logs: { ignoredChannels: [] } });

    // Permissions : membre refusé ; salon que l'appelant ne peut pas lire refusé.
    assert.ok(h.isError(await run('supprime', [], { as: 'member' })));
    const staffMsg = await h.userMessage({ as: 'admin', channel: 'staff', content: 'note du staff' });
    await h.deleteUserMessage(staffMsg.id);
    assert.match(embedOf(await run('supprime', [opt('salon', 7, G.staff)])).description, /note du staff/);
    h.fake.members.get(IDS.users.target).roles.push(IDS.roles.mod);
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', h.fake.memberWithGuild(h.fake.members.get(IDS.users.target)));
    await h.settle();
    const staff = h.fake.channels.get(G.staff);
    staff.permission_overwrites.push({ id: IDS.users.target, type: 1, allow: '0', deny: '1024' });
    h.fake.dispatchNow('CHANNEL_UPDATE', staff);
    await h.settle();
    assert.ok(h.isError(await run('supprime', [opt('salon', 7, G.staff)], { as: 'target' })), 'salon illisible pour l\'appelant');

    // Expiration après 10 minutes (durée réduite ici).
    snipe.ttlMs = 20;
    const old = await h.userMessage({ as: 'target', channel: 'announcements', content: 'éphémère' });
    await h.deleteUserMessage(old.id);
    await sleep(30);
    assert.match(h.replyText(await run('supprime', [opt('salon', 7, G.announcements)])), /Rien à afficher/);
    snipe.ttlMs = 10 * 60_000;

    // Désactivé : mémoire vidée, commande refusée, plus rien n'est retenu.
    const kept = await h.userMessage({ as: 'target', channel: 'announcements', content: 'avant désactivation' });
    await h.deleteUserMessage(kept.id);
    assert.ok(snipe.get(G.announcements, 'deleted'));
    const cfg = await h.slash('alertes', sub('config'));
    await h.click(h.messagesOf(cfg)[0], 'cmd:alertes:cfg:snipe:off');
    assert.equal(snipe.get(G.announcements, 'deleted'), null, 'mémoire non vidée');
    assert.ok(h.isError(await run('supprime')));
    const after = await h.userMessage({ as: 'target', channel: 'announcements', content: 'après désactivation' });
    await h.deleteUserMessage(after.id);
    assert.equal(snipe.get(G.announcements, 'deleted'), null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
