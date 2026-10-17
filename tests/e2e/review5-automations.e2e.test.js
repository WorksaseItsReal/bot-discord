'use strict';

/**
 * Bout en bout — revue n° 5, flux RSS et automatisations (régressions) :
 *  - DNS rebinding : /flux tester ne lit plus un service interne (adresse revalidée à la connexion) ;
 *  - rôle vocal : connexions / déconnexions rapides avec latence REST, rattrapages (serveur
 *    redevenu disponible, reprise de session, étape périodique) ;
 *  - fils automatiques bornés ; file de publication (configuration revérifiée, quota exact) ;
 *  - /flux ajouter et salon du remerciement de boost : droits de l'auteur dans le salon ;
 *  - mention d'un flux retirée quand son auteur n'a plus le droit de la faire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const { PermissionFlagsBits: PF } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { nextId } = require('./lib/ids');

const G = () => IDS.channels;
const R = () => IDS.roles;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sub = (name, options = []) => [{ name, type: 1, options }];
const callsTo = (h, method, re, mark = 0) => h.fake.calls.slice(mark).filter((c) => c.method === method && re.test(c.route));
const memberRoles = (h, as) => h.fake.members.get(IDS.users[as] ?? as)?.roles ?? [];
const first = (h, rec) => h.messagesOf(rec)[0];

/** Serveur HTTP local (le « service interne » ou un flux RSS). */
async function localServer(t, body) {
  const state = { hits: 0, body };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    res.end(typeof state.body === 'function' ? state.body() : state.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  return { state, port: server.address().port, url: (path = '/rss') => `http://127.0.0.1:${server.address().port}${path}` };
}

test('DNS rebinding : /flux tester ne lit plus un service interne (résolution revalidée à la connexion)', async (t) => {
  const internal = await localServer(t, '<rss version="2.0"><channel><title>Console interne</title><item><title>DB_PASSWORD=hunter2</title><guid>1</guid></item></channel></rss>');
  // DNS à TTL 0 (rbndr.us, 1u.ms…) : IP publique à la vérification, puis 127.0.0.1.
  const host = 'rebind.attaquant.exemple';
  const answers = [];
  let n = 0;
  const answer = () => {
    const address = n++ % 2 === 0 ? '93.184.216.34' : '127.0.0.1';
    answers.push(address);
    return address;
  };
  const realLookup = dns.lookup;
  const realPromise = dns.promises.lookup;
  dns.lookup = function lookup(name, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (name !== host) return realLookup.call(dns, name, opts, cb);
    const address = answer();
    return opts?.all ? process.nextTick(cb, null, [{ address, family: 4 }]) : process.nextTick(cb, null, address, 4);
  };
  dns.promises.lookup = async (name, opts) => {
    if (name !== host) return realPromise(name, opts);
    const address = answer();
    return opts?.all ? [{ address, family: 4 }] : { address, family: 4 };
  };
  t.after(() => {
    dns.lookup = realLookup;
    dns.promises.lookup = realPromise;
  });
  const h = await createHarness();
  h.configureAll();
  const feeds = h.client.services.feeds;
  feeds.networkEnabled = true; // configuration de production : allowLoopback reste false
  feeds.netOptions = { allowedPorts: [internal.port] }; // port du serveur de test (sinon refusé d'office)
  try {
    assert.equal(feeds.allowLoopback, false);
    const rec = await h.slash('flux', sub('tester', [{ name: 'url', type: 3, value: `http://${host}:${internal.port}/admin` }]));
    assert.ok(h.isError(rec), `service interne lu : ${h.replyText(rec).slice(0, 200)}`);
    assert.match(h.replyText(rec), /adresse privée ou locale/);
    assert.doesNotMatch(h.replyText(rec), /hunter2|Console interne/);
    assert.equal(internal.state.hits, 0, 'le service interne a reçu la requête');
    assert.deepEqual(answers.slice(0, 2), ['93.184.216.34', '127.0.0.1'], 'résolution de connexion non vérifiée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('rôle vocal : connexion puis déconnexion rapides (latence REST) — plus de rôle collé ni manquant', async () => {
  const h = await createHarness();
  h.configureAll();
  const temp = R().temp;
  h.configure({ automations: { voiceRole: { enabled: true, roleId: temp } } });
  const inVoice = () => Boolean(h.client.guilds.cache.get(h.guild.id).voiceStates.cache.get(IDS.users.member)?.channelId);
  try {
    h.fake.latency = 40;
    // Connexion, puis déconnexion pendant le PUT du rôle.
    h.fake.setVoice(IDS.users.member, G().voice);
    await sleep(1);
    h.fake.setVoice(IDS.users.member, null);
    await h.settle();
    await sleep(200);
    await h.settle();
    assert.equal(inVoice(), false);
    assert.ok(!memberRoles(h, 'member').includes(temp), 'rôle vocal resté après une déconnexion rapide');
    // Déconnexion, puis reconnexion pendant le DELETE du rôle.
    h.fake.latency = 0;
    await h.voice('member', 'voice');
    assert.ok(memberRoles(h, 'member').includes(temp));
    h.fake.latency = 40;
    h.fake.setVoice(IDS.users.member, null);
    await sleep(1);
    h.fake.setVoice(IDS.users.member, G().voice);
    await h.settle();
    await sleep(200);
    await h.settle();
    assert.equal(inVoice(), true);
    assert.ok(memberRoles(h, 'member').includes(temp), 'rôle vocal manquant après une reconnexion rapide');
    h.fake.latency = 0;
    await h.voice('member', null);
    assert.ok(!memberRoles(h, 'member').includes(temp));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    h.fake.latency = 0;
    await h.close();
  }
});

test('rôle vocal : rattrapage quand le serveur redevient disponible, à la reprise de session et toutes les 15 min', async () => {
  const h = await createHarness();
  h.configureAll();
  const svc = h.client.services.automations;
  const temp = R().temp;
  h.configure({ automations: { voiceRole: { enabled: true, roleId: temp } } });
  const guild = h.client.guilds.cache.get(h.guild.id);
  /** Événements vocaux « manqués » (coupure) : rôle porté hors vocal, membre en vocal sans rôle. */
  const drift = async () => {
    svc.stopped = true;
    const target = h.fake.members.get(IDS.users.target);
    if (!target.roles.includes(temp)) target.roles = [...target.roles, temp];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...target, guild_id: h.guild.id });
    await h.voice('admin', 'voice');
    await h.settle();
    svc.stopped = false;
    assert.ok(memberRoles(h, 'target').includes(temp) && !memberRoles(h, 'admin').includes(temp));
  };
  const fixed = () => !memberRoles(h, 'target').includes(temp) && memberRoles(h, 'admin').includes(temp);
  const leave = async () => {
    svc.stopped = true;
    await h.voice('admin', null);
    svc.stopped = false;
    const admin = h.fake.members.get(IDS.users.admin);
    admin.roles = admin.roles.filter((r) => r !== temp);
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...admin, guild_id: h.guild.id });
    await h.settle();
  };
  try {
    await drift();
    h.client.emit('guildAvailable', guild);
    await h.waitFor(fixed);
    assert.ok(fixed(), 'serveur redevenu disponible : rôles non rattrapés');

    await leave();
    await drift();
    svc.voiceRequestedAt.clear(); // une demande par minute et par serveur au plus
    h.client.emit('shardResume', 0, 0);
    await h.waitFor(fixed);
    assert.ok(fixed(), 'reprise de session : rôles non rattrapés');

    await leave();
    await drift();
    assert.equal(await svc.processDue({ now: Date.now() + 60_000 }), 0, 'rattrapage périodique trop fréquent');
    assert.equal(await svc.processDue({ now: Date.now() + 16 * 60_000 }), 1);
    await h.settle();
    assert.ok(fixed(), 'étape périodique : rôles non rattrapés');
    assert.equal(await svc.processDue({ now: Date.now() + 17 * 60_000 }), 0, 'serveur rattrapé deux fois de suite');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('fils automatiques bornés : un fil par membre et par salon toutes les 30 s, 5 créations en attente au plus par salon', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ automod: { enabled: false }, automations: { autoThreads: { enabled: true, channels: [G().general] } } });
  const svc = h.client.services.automations;
  svc.delayMs = 5;
  const general = G().general;
  const threads = (mark) => callsTo(h, 'POST', new RegExp(`^/channels/${general}/messages/\\d+/threads$`), mark);
  const post = (author, content) => {
    const msg = h.fake.buildMessage({ channelId: general, body: { content }, author, extra: {} });
    const member = h.fake.members.get(author.id);
    h.fake.dispatchNow('MESSAGE_CREATE', { ...msg, channel_type: 0, ...(member ? { member: { ...member, user: undefined } } : {}) });
  };
  try {
    // Spam d'un membre : un seul fil (et un seul minuteur), pas un par message.
    let mark = h.fake.calls.length;
    const spammer = h.fake.users.get(IDS.users.member);
    for (let i = 0; i < 50; i += 1) post(spammer, `spam ${i}`);
    assert.ok(svc.timers.size <= 1, `${svc.timers.size} minuteurs pour un spam`);
    await h.settle();
    await sleep(50);
    await h.settle();
    assert.equal(threads(mark).length, 1, 'un fil par message de spam');
    // Plusieurs membres pendant que Discord est lent : 5 créations en attente au plus.
    h.fake.latency = 150;
    mark = h.fake.calls.length;
    const authors = Array.from({ length: 8 }, (_, i) => ({ id: nextId(), username: `auteur${i}`, global_name: `Auteur ${i}`, discriminator: '0', avatar: null, bot: false }));
    for (const a of authors) post(a, 'Nouveau sujet');
    await sleep(60);
    assert.ok(svc.threadPending.get(general) <= 5, `${svc.threadPending.get(general)} créations en attente`);
    await h.settle({ timeout: 3_000 });
    await sleep(200);
    assert.equal(threads(mark).length, 5, 'plus de 5 créations de fil en attente dans un salon');
    assert.equal(svc.threadPending.get(general) ?? 0, 0, 'places non rendues');
    // Places rendues : un nouveau membre obtient son fil ; le spammeur, de nouveau après 30 s.
    h.fake.latency = 0;
    mark = h.fake.calls.length;
    post({ id: nextId(), username: 'tard', global_name: 'Tard', discriminator: '0', avatar: null, bot: false }, 'Encore un sujet');
    post(spammer, 'encore du spam');
    await h.settle();
    await sleep(50);
    await h.settle();
    assert.equal(threads(mark).length, 1);
    svc.threadCooldowns.clear(); // 30 s écoulées
    mark = h.fake.calls.length;
    post(spammer, 'un vrai sujet');
    await h.settle();
    await sleep(50);
    await h.settle();
    assert.equal(threads(mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    h.fake.latency = 0;
    await h.close();
  }
});

test('file de publication : vidée quand la publication est désactivée ou le salon retiré ; seuls les envois réels comptent', async () => {
  const h = await createHarness();
  h.configureAll();
  const svc = h.client.services.automations;
  svc.delayMs = 5;
  svc.crosspostLimit = 1;
  svc.crosspostWindowMs = 300;
  const ann = G().announcements;
  const crossposts = (mark) => callsTo(h, 'POST', /\/crosspost$/, mark);
  h.configure({ automations: { crosspost: { enabled: true, channels: [ann] } } });
  try {
    // Désactivation depuis le tableau de bord : les messages en attente ne partent plus.
    let mark = h.fake.calls.length;
    for (let i = 0; i < 3; i += 1) await h.userMessage({ as: 'admin', channel: 'announcements', content: `Annonce ${i}` });
    await h.waitFor(() => crossposts(mark).length === 1);
    assert.equal(svc.queueSize(ann), 2);
    const home = await h.slash('automatisations');
    await h.click(first(h, home), 'cmd:automatisations:toggle:crosspost:off:home');
    assert.equal(svc.queueSize(ann), 0, 'file non vidée à la désactivation');
    await sleep(500);
    assert.equal(crossposts(mark).length, 1, 'message publié après la désactivation');

    // Configuration changée ailleurs (sans le tableau de bord) : revérifiée à l'envoi.
    await sleep(350); // fenêtre écoulée
    h.configure({ automations: { crosspost: { enabled: true, channels: [ann] } } });
    mark = h.fake.calls.length;
    for (let i = 0; i < 2; i += 1) await h.userMessage({ as: 'admin', channel: 'announcements', content: `Autre ${i}` });
    await h.waitFor(() => crossposts(mark).length === 1);
    h.configure({ automations: { crosspost: { channels: [] } } });
    await sleep(500);
    assert.equal(crossposts(mark).length, 1, 'message publié dans un salon retiré de la configuration');
    assert.equal(svc.queueSize(ann), 0);

    // Message supprimé pendant son attente : ignoré SANS consommer le quota.
    await sleep(350);
    h.configure({ automations: { crosspost: { enabled: true, channels: [ann] } } });
    mark = h.fake.calls.length;
    const a = await h.userMessage({ as: 'admin', channel: 'announcements', content: 'A' });
    await h.waitFor(() => crossposts(mark).length === 1);
    const b = await h.userMessage({ as: 'admin', channel: 'announcements', content: 'B' });
    const c = await h.userMessage({ as: 'admin', channel: 'announcements', content: 'C' });
    await h.deleteUserMessage(b.id);
    const start = Date.now();
    await h.waitFor(() => crossposts(mark).length === 2, { timeout: 1_500 });
    const routes = crossposts(mark).map((x) => x.route);
    assert.deepEqual(routes, [`/channels/${ann}/messages/${a.id}/crosspost`, `/channels/${ann}/messages/${c.id}/crosspost`]);
    assert.ok(Date.now() - start < 550, `C a attendu une fenêtre de plus (${Date.now() - start} ms) : B, ignoré, a compté`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/flux ajouter et salon du remerciement de boost : l\'auteur doit voir et écrire dans le salon ; « Mentionner @everyone » lue dans le salon', async (t) => {
  const srv = await localServer(t, '<rss version="2.0"><channel><title>Journal</title><item><title>a</title><guid>a</guid></item></channel></rss>');
  const h = await createHarness();
  h.configureAll();
  const feeds = h.client.services.feeds;
  feeds.networkEnabled = true;
  feeds.allowLoopback = true;
  // « Joueur » (porté par member) : Gérer le serveur et Mentionner @everyone, mais pas l'accès à #staff.
  const gamer = h.fake.roles.get(R().gamer);
  gamer.permissions = String(PF.ManageGuild | PF.MentionEveryone);
  h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role: gamer });
  // … et « Mentionner @everyone » retirée dans #annonces.
  const annChannel = h.fake.channels.get(G().announcements);
  annChannel.permission_overwrites.push({ id: R().gamer, type: 0, allow: '0', deny: String(PF.MentionEveryone) });
  h.fake.dispatchNow('CHANNEL_UPDATE', annChannel);
  await h.settle();
  const add = (salon, extra = []) => h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: srv.url() }, { name: 'salon', type: 7, value: salon }, ...extra]), { as: 'member' });
  try {
    const hidden = await add(G().staff);
    assert.ok(h.isError(hidden), 'flux ajouté dans un salon que l\'auteur ne voit pas');
    assert.match(h.replyText(hidden), /Vous ne pouvez pas écrire/);
    const noPing = await add(G().announcements, [{ name: 'role_mention', type: 8, value: R().member }]);
    assert.ok(h.isError(noPing), 'mention d\'un rôle non mentionnable acceptée alors que la permission est retirée dans ce salon');
    assert.match(h.replyText(noPing), /pas mentionnable/);
    assert.equal(h.client.repositories.feeds.count(h.guild.id), 0);
    // Témoin : salon accessible, rôle non mentionnable, permission présente dans ce salon.
    const ok = await add(G().general, [{ name: 'role_mention', type: 8, value: R().member }]);
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(h.client.repositories.feeds.count(h.guild.id), 1);

    // Remerciement de boost : même règle.
    const view = await h.slash('automatisations', [], { as: 'member' });
    const boost = await h.click(first(h, view), 'cmd:automatisations:nav', { values: ['boost'], as: 'member' });
    const refused = await h.click(first(h, boost), 'cmd:automatisations:bochannel', { values: [G().staff], as: 'member' });
    assert.ok(h.isError(refused), 'salon du remerciement fermé à l\'auteur accepté');
    assert.equal(h.client.services.config.get(h.guild.id).automations.boost.channelId, null);
    const accepted = await h.click(first(h, boost), 'cmd:automatisations:bochannel', { values: [G().general], as: 'member' });
    assert.ok(!h.isError(accepted));
    assert.equal(h.client.services.config.get(h.guild.id).automations.boost.channelId, G().general);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('flux : mention d\'un rôle non mentionnable retirée (et journalisée une fois) quand son auteur est rétrogradé', async (t) => {
  let items = [{ id: 'a1', t: 'Ancien' }];
  const srv = await localServer(t, () => `<rss><channel><title>Flux de l'admin</title>${items.map((i) => `<item><guid>${i.id}</guid><title>${i.t}</title></item>`).join('')}</channel></rss>`);
  const h = await createHarness();
  h.configureAll();
  const feeds = h.client.services.feeds;
  feeds.networkEnabled = true;
  feeds.allowLoopback = true;
  const role = R().member; // « Membre » : non mentionnable, porté par tout le monde
  try {
    const rec = await h.slash('flux', sub('ajouter', [{ name: 'url', type: 3, value: srv.url() }, { name: 'salon', type: 7, value: G().general }, { name: 'role_mention', type: 8, value: role }]));
    assert.ok(!h.isError(rec), h.replyText(rec));
    // Tant que l'auteur (Administrateur) en a le droit : mentionné.
    items = [{ id: 'n1', t: 'Premier' }, ...items];
    let mark = h.fake.calls.length;
    await feeds.processDue({ now: Date.now() + 11 * 60_000 });
    let post = callsTo(h, 'POST', new RegExp(`^/channels/${G().general}/messages$`), mark).find((c) => c.body?.embeds?.[0]?.title === 'Premier');
    assert.deepEqual(post.body.allowed_mentions, { parse: [], roles: [role] });
    // Auteur rétrogradé : plus de mention.
    const admin = h.fake.members.get(IDS.users.admin);
    admin.roles = admin.roles.filter((r) => r !== R().admin);
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...admin, guild_id: h.guild.id });
    await h.settle();
    const logMark = h.fake.messageLog.length;
    for (const [k, title] of [[22, 'Deuxième'], [33, 'Troisième']]) {
      items = [{ id: title, t: title }, ...items];
      mark = h.fake.calls.length;
      await feeds.processDue({ now: Date.now() + k * 60_000 });
      post = callsTo(h, 'POST', new RegExp(`^/channels/${G().general}/messages$`), mark).find((c) => c.body?.embeds?.[0]?.title === title);
      assert.ok(post, `${title} non publié`);
      assert.equal(post.body.content ?? '', '', `${title} : rôle encore mentionné`);
      assert.deepEqual(post.body.allowed_mentions, { parse: [] });
    }
    const warnings = h.fake.messageLog.slice(logMark).map((id) => h.message(id)).filter((m) => m?.channel_id === G().logs && /sans mention/.test(m.embeds?.[0]?.title ?? ''));
    assert.equal(warnings.length, 1, 'mention retirée non journalisée, ou journalisée à chaque article');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
