'use strict';

/**
 * Bout en bout : /automatisations (publication automatique, fils, rôle vocal, boosts,
 * présence) et /flux (RSS / YouTube) sur le vrai discord.js. Les flux sont servis par un
 * serveur HTTP LOCAL (127.0.0.1, autorisé par injection) : jamais le vrai réseau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHarness, IDS } = require('./harness');
const { explore, newStats } = require('./lib/explore');
const { nextId } = require('./lib/ids');

const G = () => IDS.channels;
const R = () => IDS.roles;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callsTo = (h, method, re, mark = 0) => h.fake.calls.slice(mark).filter((c) => c.method === method && re.test(c.route));
const botMessagesIn = (h, channelId, mark = 0) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
const memberRoles = (h, as) => h.fake.members.get(IDS.users[as] ?? as)?.roles ?? [];

/** Ouvre une vue du tableau de bord. */
async function openView(h, view, as = 'admin') {
  const rec = await h.slash('automatisations', [], { as });
  if (view === 'home') return rec;
  return h.click(h.messagesOf(rec)[0], 'cmd:automatisations:nav', { values: [view], as });
}
const first = (h, rec) => h.messagesOf(rec)[0];

test('/automatisations : chaque vue, bouton, menu et formulaire ; refus sans permission', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('automatisations');
    assert.match(h.replyText(rec), /Automatisations · Tableau de bord/);
    const stats = newStats();
    await explore(h, rec, { budget: 120, stats });
    // Puis chaque section en partant de sa propre vue, sans le menu de navigation (ses menus propres d'abord).
    const own = (a) => a.customId === 'cmd:automatisations:nav' || a.customId === 'cmd:automatisations:go:home';
    for (const view of ['crosspost', 'threads', 'voice', 'boost', 'presence']) await explore(h, await openView(h, view), { budget: 60, stats, skip: own });
    for (const view of ['home', 'crosspost', 'threads', 'voice', 'boost', 'presence']) assert.ok(stats.navChosen.has(`cmd:automatisations:nav=${view}`), `vue ${view} jamais ouverte`);
    for (const key of ['cpchannels', 'thchannels', 'thmode', 'tharchive', 'thname', 'vrrole', 'vrpick', 'bochannel', 'borole', 'bomsg', 'toggle']) {
      assert.ok(stats.keys.has(`cmd:automatisations:${key}`), `${key} jamais utilisé`);
    }
    assert.ok(stats.modals >= 2, `formulaires soumis : ${stats.modals}`);
    // Vue d'un salon vocal (rôle propre au salon) explorée à part.
    const voice = await openView(h, 'voice');
    const chan = await h.click(first(h, voice), 'cmd:automatisations:vrpick', { values: [G().voice] });
    assert.match(h.replyText(chan), /Rôle vocal · Salon vocal/);
    const detail = await explore(h, chan, { budget: 30, skip: (a) => own(a) || a.customId === 'cmd:automatisations:go:voice' });
    assert.ok(detail.keys.has('cmd:automatisations:vrset'), 'rôle d\'un salon jamais choisi');

    // Membre sans « Gérer le serveur » : commande et composants refusés, rien ne change.
    assert.ok(h.isError(await h.slash('automatisations', [], { as: 'member' })));
    const admin = await h.slash('automatisations');
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).automations);
    await explore(h, admin, { as: 'member', budget: 30 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).automations), before, 'un membre a modifié la configuration');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('publication automatique : salons d\'annonces, limite de Discord → file d\'attente et log, permission vérifiée', async () => {
  // Bot sans « Administrateur » : les permissions de salon s'appliquent à lui.
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  // Le bot doit pouvoir écrire dans #logs (réservé au staff).
  const { PermissionFlagsBits: PF } = require('discord.js');
  const logsChannel = h.fake.channels.get(G().logs);
  logsChannel.permission_overwrites.push({ id: R().bot, type: 0, allow: String(PF.ViewChannel | PF.SendMessages | PF.EmbedLinks), deny: '0' });
  h.fake.dispatchNow('CHANNEL_UPDATE', logsChannel);
  const svc = h.client.services.automations;
  svc.delayMs = 5;
  svc.crosspostLimit = 2;
  svc.crosspostWindowMs = 300;
  const ann = G().announcements;
  try {
    const view = await openView(h, 'crosspost');
    const set = await h.click(first(h, view), 'cmd:automatisations:cpchannels', { values: [ann, G().general] });
    assert.match(h.replyText(set), /1 salon\(s\) d'annonces/, 'un salon textuel ne peut pas être publié');
    const on = await h.click(first(h, set), 'cmd:automatisations:toggle:crosspost:on:crosspost');
    assert.match(h.replyText(on), /Publication automatique \*\*activée\*\*/);
    assert.deepEqual(h.client.services.config.get(h.guild.id).automations.crosspost, { enabled: true, channels: [ann] });

    const mark = h.fake.calls.length;
    const logMark = h.fake.messageLog.length;
    const msgs = [];
    for (let i = 0; i < 3; i += 1) msgs.push(await h.userMessage({ as: 'admin', channel: 'announcements', content: `Annonce ${i}` }));
    await h.userMessage({ as: 'member', channel: 'general', content: 'pas une annonce' });
    await h.waitFor(() => callsTo(h, 'POST', /\/crosspost$/, mark).length === 2);
    await sleep(30);
    assert.equal(callsTo(h, 'POST', /\/crosspost$/, mark).length, 2, 'limite par salon ignorée');
    assert.equal(svc.queueSize(ann), 1);
    const waitLog = botMessagesIn(h, G().logs, logMark).find((m) => /Publication automatique en attente/.test(m.embeds?.[0]?.title ?? ''));
    assert.ok(waitLog, 'dépassement de la limite non journalisé');
    await h.waitFor(() => callsTo(h, 'POST', /\/crosspost$/, mark).length === 3, { timeout: 1_500 });
    const routes = callsTo(h, 'POST', /\/crosspost$/, mark).map((c) => c.route);
    assert.deepEqual(routes, msgs.map((m) => `/channels/${ann}/messages/${m.id}/crosspost`), 'ordre de publication');
    assert.ok(h.fake.messages.get(msgs[0].id).flags & 1, 'message marqué publié');

    // Message filtré par l'AutoMod : jamais publié (délai réaliste : l'AutoMod passe d'abord).
    svc.crosspostLimit = 10;
    svc.delayMs = 150;
    const markSpam = h.fake.calls.length;
    const spam = await h.userMessage({ as: 'target', channel: 'announcements', content: 'rejoignez discord.gg/abcdef' });
    await sleep(250);
    await h.settle();
    assert.ok(!h.fake.messages.has(spam.id), 'invitation non supprimée par l\'AutoMod');
    assert.equal(callsTo(h, 'POST', /\/crosspost$/, markSpam).length, 0, 'message supprimé publié');

    // Sans « Gérer les messages » : le message d'un autre n'est pas publié, alerte journalisée.
    const annChannel = h.fake.channels.get(ann);
    annChannel.permission_overwrites.push({ id: R().bot, type: 0, allow: '0', deny: String(1n << 13n) });
    h.fake.dispatchNow('CHANNEL_UPDATE', annChannel);
    const markPerm = h.fake.calls.length;
    const logPerm = h.fake.messageLog.length;
    await h.userMessage({ as: 'admin', channel: 'announcements', content: 'Annonce sans permission' });
    await h.waitFor(() => botMessagesIn(h, G().logs, logPerm).some((m) => /impossible/.test(m.embeds?.[0]?.title ?? '')));
    assert.equal(callsTo(h, 'POST', /\/crosspost$/, markPerm).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('fils automatiques : nom {pseudo}/{n}, archivage, mode image/lien, bots et messages filtrés ignorés', async () => {
  const h = await createHarness();
  h.configureAll();
  const svc = h.client.services.automations;
  svc.delayMs = 5;
  const general = G().general;
  const threadCalls = (mark) => callsTo(h, 'POST', new RegExp(`^/channels/${general}/messages/\\d+/threads$`), mark);
  try {
    const view = await openView(h, 'threads');
    const set = await h.click(first(h, view), 'cmd:automatisations:thchannels', { values: [general] });
    const modal = await h.click(first(h, set), 'cmd:automatisations:thname');
    assert.equal(modal.modals.length, 1);
    const bad = await h.submitModal(modal, { template: 'Fil de {membre}' });
    assert.ok(h.isError(bad), 'variable inconnue acceptée');
    const named = await h.submitModal(modal, { template: '{pseudo} · n°{n}' });
    assert.match(h.replyText(named), /Nom des fils/);
    const archived = await h.click(first(h, named), 'cmd:automatisations:tharchive', { values: ['60'] });
    await h.click(first(h, archived), 'cmd:automatisations:toggle:threads:on:threads');
    const cfg = h.client.services.config.get(h.guild.id).automations.autoThreads;
    assert.deepEqual({ ...cfg }, { enabled: true, channels: [general], mode: 'all', nameTemplate: '{pseudo} · n°{n}', archiveMinutes: 60 });

    let mark = h.fake.calls.length;
    const m1 = await h.userMessage({ as: 'member', content: 'Premier sujet' });
    await h.waitFor(() => threadCalls(mark).length === 1);
    const call = threadCalls(mark)[0];
    assert.equal(call.route, `/channels/${general}/messages/${m1.id}/threads`);
    assert.equal(call.body.name, 'Membre · n°1');
    assert.equal(call.body.auto_archive_duration, 60);
    await h.userMessage({ as: 'target', content: 'Deuxième sujet' });
    await h.waitFor(() => threadCalls(mark).length === 2);
    assert.equal(threadCalls(mark)[1].body.name, 'Cible · n°2');

    // Bots et messages filtrés par l'AutoMod : aucun fil (délai réaliste : l'AutoMod passe d'abord).
    svc.delayMs = 150;
    mark = h.fake.calls.length;
    await h.userMessage({ as: 'otherBot', content: 'je suis un bot' });
    const spam = await h.userMessage({ as: 'target', content: 'pub discord.gg/abcdef' });
    await sleep(250);
    await h.settle();
    svc.delayMs = 5;
    assert.ok(!h.fake.messages.has(spam.id));
    assert.equal(threadCalls(mark).length, 0, 'fil ouvert pour un bot ou un message filtré');

    // Mode « image ou lien ».
    const v2 = await openView(h, 'threads');
    await h.click(first(h, v2), 'cmd:automatisations:thmode', { values: ['media'] });
    mark = h.fake.calls.length;
    await h.userMessage({ as: 'member', content: 'juste du texte' });
    const image = { id: '1', filename: 'chat.png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/2/chat.png', proxy_url: 'https://media.discordapp.net/attachments/1/2/chat.png', content_type: 'image/png', width: 10, height: 10 };
    const withLink = await h.userMessage({ as: 'member', content: 'mon chat', extra: { attachments: [image] } });
    await h.waitFor(() => threadCalls(mark).length === 1);
    await sleep(30);
    assert.equal(threadCalls(mark).length, 1);
    assert.equal(threadCalls(mark)[0].route, `/channels/${general}/messages/${withLink.id}/threads`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('rôle vocal : global et par salon, déplacement, déconnexion, rattrapage au démarrage, rôles refusés', async () => {
  const h = await createHarness();
  h.configureAll();
  const svc = h.client.services.automations;
  const temp = R().temp;
  const muted = R().muted;
  try {
    // Refus : rôle sensible, rôle géré par une intégration, rôle déjà porté hors vocal.
    for (const [roleId, re] of [[R().mod, /modération/], [R().bot, /intégration/], [R().gamer, /rôle dédié/], [R().admin, /modération/]]) {
      const view = await openView(h, 'voice');
      const rec = await h.click(first(h, view), 'cmd:automatisations:vrrole', { values: [roleId] });
      assert.ok(h.isError(rec), `rôle ${roleId} accepté`);
      assert.match(h.replyText(rec), re);
    }
    assert.equal(h.client.services.config.get(h.guild.id).automations.voiceRole.roleId, null);

    const view = await openView(h, 'voice');
    const global = await h.click(first(h, view), 'cmd:automatisations:vrrole', { values: [temp] });
    assert.match(h.replyText(global), /Rôle global/);
    const pick = await h.click(first(h, global), 'cmd:automatisations:vrpick', { values: [G().voice] });
    const dup = await h.click(first(h, pick), `cmd:automatisations:vrset:${G().voice}`, { values: [temp] });
    assert.ok(h.isError(dup), 'rôle global réutilisé pour un salon');
    const linked = await h.click(first(h, pick), `cmd:automatisations:vrset:${G().voice}`, { values: [muted] });
    assert.match(h.replyText(linked), /→/);
    await h.click(first(h, linked), 'cmd:automatisations:toggle:voice:on:voice');
    const cfg = h.client.services.config.get(h.guild.id).automations.voiceRole;
    assert.deepEqual({ ...cfg, channels: cfg.channels.map((c) => ({ ...c })) }, { enabled: true, roleId: temp, channels: [{ channelId: G().voice, roleId: muted }] });

    await h.voice('member', 'voice');
    assert.ok(memberRoles(h, 'member').includes(temp) && memberRoles(h, 'member').includes(muted), 'rôles non donnés à la connexion');
    await h.voice('member', 'stage');
    assert.ok(memberRoles(h, 'member').includes(temp), 'rôle global retiré au déplacement');
    assert.ok(!memberRoles(h, 'member').includes(muted), 'rôle du salon conservé après le déplacement');
    await h.voice('member', null);
    assert.ok(!memberRoles(h, 'member').includes(temp), 'rôle global conservé après la déconnexion');
    await h.voice('otherBot', 'voice');
    assert.ok(!memberRoles(h, 'otherBot').includes(temp), 'un bot a reçu le rôle vocal');

    // Rattrapage au démarrage : rôle porté hors vocal retiré, membre déjà en vocal servi.
    svc.stopped = true; // événements ignorés le temps de préparer l'état « avant démarrage »
    const target = h.fake.members.get(IDS.users.target);
    target.roles = [...target.roles, temp];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...target, guild_id: h.guild.id });
    await h.voice('admin', 'voice');
    await h.settle();
    svc.stopped = false;
    assert.ok(memberRoles(h, 'target').includes(temp) && !memberRoles(h, 'admin').includes(temp));
    const ready = require('../../src/events/automations').find((e) => e.name === 'clientReady');
    await ready.execute(h.client);
    await h.settle();
    assert.ok(!memberRoles(h, 'target').includes(temp), 'rôle non retiré au rattrapage');
    assert.ok(memberRoles(h, 'admin').includes(temp) && memberRoles(h, 'admin').includes(muted), 'membre en vocal non servi au rattrapage');

    // Association retirée : son rôle est retiré aux membres qui le portent.
    const v2 = await openView(h, 'voice');
    await h.click(first(h, v2), 'cmd:automatisations:vrdel', { values: [G().voice] });
    await h.waitFor(() => !memberRoles(h, 'admin').includes(muted));
    assert.ok(!memberRoles(h, 'admin').includes(muted));
    assert.ok(memberRoles(h, 'admin').includes(temp));
    // Désactivation : rôle retiré à tous.
    const v3 = await openView(h, 'voice');
    await h.click(first(h, v3), 'cmd:automatisations:toggle:voice:off:voice');
    await h.waitFor(() => !memberRoles(h, 'admin').includes(temp));
    assert.ok(!memberRoles(h, 'admin').includes(temp), 'rôle conservé après désactivation');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('remerciement de boost : message (seul le membre notifié), rôle, log de boost non dupliqué, fin du boost', async () => {
  const h = await createHarness();
  h.configureAll();
  const general = G().general;
  try {
    const view = await openView(h, 'boost');
    const ch = await h.click(first(h, view), 'cmd:automatisations:bochannel', { values: [general] });
    const refused = await h.click(first(h, ch), 'cmd:automatisations:borole', { values: [R().mod] });
    assert.ok(h.isError(refused), 'rôle sensible accepté');
    const role = await h.click(first(h, ch), 'cmd:automatisations:borole', { values: [R().notif] });
    const modal = await h.click(first(h, role), 'cmd:automatisations:bomsg');
    assert.ok(h.isError(await h.submitModal(modal, { message: 'Merci {pseudo}' })), 'variable inconnue acceptée');
    const saved = await h.submitModal(modal, { message: 'Merci {membre} ! {serveur} a {boosts} boosts @everyone' });
    assert.match(h.replyText(saved), /Message enregistré/);
    await h.click(first(h, saved), 'cmd:automatisations:toggle:boost:on:boost');

    // Comme Discord : le boost ajoute le rôle géré « Server Booster » et premium_since.
    const boosterRole = { id: nextId(), name: 'Server Booster', color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position: 1, permissions: '0', managed: true, mentionable: false, flags: 0, tags: { premium_subscriber: null } };
    h.fake.roles.set(boosterRole.id, boosterRole);
    h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: h.guild.id, role: boosterRole });
    const markMsg = h.fake.messageLog.length;
    const markCalls = h.fake.calls.length;
    const raw = h.fake.members.get(IDS.users.target);
    raw.premium_since = new Date().toISOString();
    raw.roles = [...raw.roles, boosterRole.id];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...raw, guild_id: h.guild.id }, 'boost de Cible');
    await h.settle();
    await h.waitFor(() => botMessagesIn(h, general, markMsg).length === 1);
    const thanks = botMessagesIn(h, general, markMsg);
    assert.equal(thanks.length, 1);
    assert.equal(thanks[0].content, `<@${IDS.users.target}>`);
    assert.match(thanks[0].embeds[0].description, new RegExp(`^Merci <@${IDS.users.target}> ! Serveur de test a \\d+ boosts @​everyone$`));
    const post = callsTo(h, 'POST', new RegExp(`^/channels/${general}/messages$`), markCalls).at(-1);
    assert.deepEqual(post.body.allowed_mentions, { parse: [], users: [IDS.users.target] });
    assert.ok(memberRoles(h, 'target').includes(R().notif), 'rôle de booster non donné');
    const boostLogs = botMessagesIn(h, G().logs, markMsg).filter((m) => /Nouveau boost/.test(m.embeds?.[0]?.title ?? ''));
    assert.equal(boostLogs.length, 1, 'log de boost absent ou dupliqué');

    // Même état renvoyé : rien de plus. Fin du boost : rôle retiré.
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...raw, guild_id: h.guild.id, nick: 'Booster' });
    await h.settle();
    assert.equal(botMessagesIn(h, general, markMsg).length, 1);
    raw.premium_since = null;
    raw.roles = raw.roles.filter((r) => r !== boosterRole.id);
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...raw, guild_id: h.guild.id }, 'fin du boost');
    await h.settle();
    await h.waitFor(() => !memberRoles(h, 'target').includes(R().notif));
    assert.ok(!memberRoles(h, 'target').includes(R().notif), 'rôle conservé à la fin du boost');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('présence du bot : statuts par défaut au démarrage, vue en lecture seule', async () => {
  const h = await createHarness();
  try {
    assert.ok(h.client.presenceTimer, 'rotation non démarrée');
    assert.equal(h.client.user.presence.activities[0]?.name, '/help • toutes les commandes');
    const view = await openView(h, 'presence');
    assert.match(h.replyText(view), /Présence du bot/);
    assert.match(JSON.stringify(first(h, view).embeds[0].fields), /PRESENCE_STATUSES/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
  assert.equal(h.client.presenceTimer?._destroyed ?? true, true, 'minuteur non arrêté');
});

/** Serveur RSS local. */
async function rssServer(t) {
  const state = { items: [], hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    if (req.url.startsWith('/redirect')) return res.writeHead(302, { location: 'http://169.254.169.254/latest/' }).end();
    if (!req.url.startsWith('/rss')) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Journal &amp; Co</title><link>https://journal.exemple.fr/</link>${state.items
      .map((it) => `<item><title>${it.title}</title><link>https://journal.exemple.fr/${it.id}</link><guid>${it.id}</guid><pubDate>${new Date(it.date).toUTCString()}</pubDate><description><![CDATA[<p>${it.text ?? 'Résumé'} <img src="https://img.exemple.fr/${it.id}.png"></p>]]></description></item>`)
      .join('')}</channel></rss>`);
    return undefined;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  return { state, url: (path = '/rss') => `http://127.0.0.1:${server.address().port}${path}` };
}

const sub = (name, options = []) => [{ name, type: 1, options }];

test('/flux : ajouter (historique non publié), nouveautés publiées avec mention, liste, test, retrait, refus', async (t) => {
  const srv = await rssServer(t);
  const h = await createHarness();
  h.allowLoopbackFetch();
  h.configureAll();
  const feeds = h.client.services.feeds;
  feeds.networkEnabled = true;
  feeds.allowLoopback = true;
  const ann = G().announcements;
  const auto = h.client.services.automations;
  auto.delayMs = 5;
  h.configure({ automations: { crosspost: { enabled: true, channels: [ann] } } });
  srv.state.items = [{ id: 'a1', title: 'Archive 1', date: Date.UTC(2025, 0, 1) }, { id: 'a2', title: 'Archive 2', date: Date.UTC(2025, 0, 2) }];
  try {
    // Refus : réseau coupé, adresse privée, redirection vers une adresse privée, @pseudo YouTube, @everyone, membre.
    feeds.networkEnabled = false;
    const off = await h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: srv.url() }, { name: 'salon', type: 7, value: ann }]));
    assert.match(h.replyText(off), /désactivée/);
    feeds.networkEnabled = true;
    for (const [url, re] of [['http://169.254.169.254/latest/', /privées ou locales/], [srv.url('/redirect'), /privées ou locales/], ['https://www.youtube.com/@gadget', /identifiant de la chaîne/], ['ftp://exemple.fr/rss', /http/]]) {
      const rec = await h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: url }, { name: 'salon', type: 7, value: ann }]));
      assert.ok(h.isError(rec), url);
      assert.match(h.replyText(rec), re, url);
    }
    const everyone = await h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: srv.url() }, { name: 'salon', type: 7, value: ann }, { name: 'role_mention', type: 8, value: IDS.guild }]));
    assert.match(h.replyText(everyone), /@everyone/);
    assert.ok(h.isError(await h.slash('flux', sub('liste'), { as: 'member' })));
    assert.equal(h.client.repositories.feeds.count(h.guild.id), 0);

    // Ajout : première lecture, rien n'est publié.
    const markMsg = h.fake.messageLog.length;
    const added = await h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: srv.url() }, { name: 'salon', type: 7, value: ann }, { name: 'role_mention', type: 8, value: R().notif }, { name: 'filtre_mot', type: 3, value: 'nouveau' }]));
    assert.match(h.replyText(added), /Flux ajouté/);
    assert.match(h.replyText(added), /2\*\* article\(s\) actuels/);
    assert.equal(botMessagesIn(h, ann, markMsg).length, 0, 'historique publié');
    const row = h.client.repositories.feeds.list(h.guild.id)[0];
    assert.equal(row.title, 'Journal & Co');
    assert.equal(row.filter, 'nouveau');
    assert.ok(botMessagesIn(h, G().logs, markMsg).some((m) => /Flux RSS ajouté/.test(m.embeds?.[0]?.title ?? '')), 'ajout non journalisé');
    const dup = await h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: srv.url() }, { name: 'salon', type: 7, value: ann }]));
    assert.match(h.replyText(dup), /déjà publié/);

    // Nouveautés (une filtrée) : publiées par l'étape du scheduler, rôle mentionné explicitement, puis publiées (crosspost).
    srv.state.items = [{ id: 'n2', title: 'Article sans le mot', date: Date.UTC(2025, 0, 4) }, { id: 'n1', title: 'Nouveau : le bot lit les flux', date: Date.UTC(2025, 0, 3), text: 'Grande <b>nouveauté</b>' }, ...srv.state.items];
    h.fake.label = 'flux : publication';
    const markCalls = h.fake.calls.length;
    assert.equal(await h.client.services.scheduler.tick().then(() => feeds.processDue({ now: Date.now() + 11 * 60_000 })), 1);
    await h.settle();
    const posts = botMessagesIn(h, ann, markMsg);
    assert.equal(posts.length, 1, 'article filtré publié ou nouveauté absente');
    assert.equal(posts[0].content, `<@&${R().notif}>`);
    assert.equal(posts[0].embeds[0].title, 'Nouveau : le bot lit les flux');
    assert.equal(posts[0].embeds[0].url, 'https://journal.exemple.fr/n1');
    assert.equal(posts[0].embeds[0].description, 'Grande nouveauté');
    assert.equal(posts[0].embeds[0].image.url, 'https://img.exemple.fr/n1.png');
    const post = callsTo(h, 'POST', new RegExp(`^/channels/${ann}/messages$`), markCalls).at(-1);
    assert.deepEqual(post.body.allowed_mentions, { parse: [], roles: [R().notif] });
    await h.waitFor(() => callsTo(h, 'POST', new RegExp(`^/channels/${ann}/messages/${posts[0].id}/crosspost$`), markCalls).length === 1);
    assert.equal(callsTo(h, 'POST', /\/crosspost$/, markCalls).length, 1, 'message du flux non publié (crosspost)');
    assert.equal(await feeds.processDue({ now: Date.now() + 22 * 60_000 }), 1);
    await h.settle();
    assert.equal(botMessagesIn(h, ann, markMsg).length, 1, 'article republié (déduplication)');

    // Autocomplétion, test, liste (exploration), retrait.
    const ac = await h.autocomplete('flux', sub('retirer', [{ name: 'flux', type: 3, value: 'journal', focused: true }]));
    assert.deepEqual(ac.autocomplete.map((c) => c.value), [String(row.id)]);
    const tested = await h.slash('flux', sub('tester', [{ name: 'url', type: 3, value: srv.url() }]));
    assert.match(h.replyText(tested), /Lecture réussie/);
    assert.equal(h.messagesOf(tested)[0].embeds.length, 2, 'aperçu absent');
    assert.ok(h.isError(await h.slash('flux', sub('tester'))));
    assert.ok(h.isError(await h.slash('flux', sub('retirer', [{ name: 'flux', type: 3, value: 'inconnu' }]))));
    const list = await h.slash('flux', sub('liste'));
    assert.match(h.replyText(list), /Flux suivis/);
    const stats = await explore(h, list, { budget: 40, skip: (a) => a.customId.startsWith('cmd:flux:del') });
    for (const key of ['pick', 'toggle', 'test', 'confirm', 'list']) assert.ok(stats.keys.has(`cmd:flux:${key}`), `${key} jamais utilisé`);
    const memberList = await h.slash('flux', sub('liste'));
    const before = JSON.stringify(h.client.repositories.feeds.list(h.guild.id));
    await explore(h, memberList, { as: 'member', budget: 15 });
    assert.equal(JSON.stringify(h.client.repositories.feeds.list(h.guild.id)), before, 'un membre a modifié un flux');
    const removed = await h.slash('flux', sub('retirer', [{ name: 'flux', type: 3, value: String(row.id) }]));
    assert.match(h.replyText(removed), /Flux retiré/);
    assert.equal(h.client.repositories.feeds.count(h.guild.id), 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
