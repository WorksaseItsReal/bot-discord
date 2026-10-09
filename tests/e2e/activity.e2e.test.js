'use strict';

/**
 * Bout en bout : statistiques du serveur (/statistiques) et membres inactifs (/activite)
 * sur le vrai discord.js. Messages, fils, vocal, arrivées et départs passent par les
 * événements réels de la passerelle ; les actions groupées par les vraies routes REST.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { rawMember } = require('./lib/fixtures');
const { DAY } = require('./lib/ids');
const activite = require('../../src/commands/moderation/activite');
const { dayKey, addDays } = require('../../src/utils/activity');

const sub = (name, options = []) => [{ name, type: 1, options }];
const today = () => dayKey(Date.now());

/** Membre ajouté sans événement d'arrivée (ni accueil, ni AntiRaid), arrivé il y a `joinedDaysAgo` jours. */
function addSleeper(h, name, { joinedDaysAgo = 100, roles = [] } = {}) {
  const user = h.addUser(name, { ageDays: 500 });
  const raw = rawMember(user, roles, joinedDaysAgo);
  h.fake.members.set(user.id, raw);
  h.guild.members._add(JSON.parse(JSON.stringify(raw)));
  return user.id;
}

/** Bouton d'un message dont le customId commence par `prefix`. */
function buttonStarting(message, prefix) {
  return (message?.components ?? []).flatMap((r) => r.components ?? []).find((c) => c.custom_id?.startsWith(prefix)) ?? null;
}

const dmMessages = (h, mark = 0) => h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.route) && h.fake.dms.has(c.route.split('/')[2]));

test('collecte réelle : messages, fils, bots, salons ignorés, vocal, arrivées et départs ; écriture par lots et à l\'arrêt', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ logs: { ignoredChannels: [IDS.channels.staff] } });
  const svc = h.client.services.activity;
  const repo = h.client.repositories.activity;
  const G = h.guild.id;
  let closed = false;
  try {
    assert.ok(repo.getSince(G), 'début de collecte enregistré au démarrage (clientReady)');
    await h.userMessage({ as: 'member', content: 'Bonjour tout le monde' });
    await h.userMessage({ as: 'member', content: 'Deuxième message' });
    await h.userMessage({ as: 'target', channel: 'rules', content: 'Lu et approuvé' });
    await h.userMessage({ as: 'member', channel: 'thread', content: 'Dans un fil' });
    await h.userMessage({ as: 'otherBot', content: 'Je suis un bot' });
    await h.userMessage({ as: 'mod', channel: 'staff', content: 'Salon ignoré des logs' });

    // Écriture par lots : rien en base avant le vidage.
    assert.equal(repo.totals(G, today()).messages, 0, 'écriture à chaque message');
    svc.flush();
    const channels = Object.fromEntries(repo.topChannels(G, today()).map((c) => [c.channel_id, c.messages]));
    assert.deepEqual(channels, { [IDS.channels.general]: 3, [IDS.channels.rules]: 1 }, 'fil compté pour son salon, bot et salon ignoré exclus');
    assert.equal(repo.hourly(G, today()).reduce((n, r) => n + r.messages, 0), 4);
    assert.equal(repo.lastActive(G).has(IDS.users.mod), false);
    assert.equal(repo.lastActive(G).has(IDS.users.otherBot), false);

    // Vocal : 5 minutes dans un salon (horloge du service avancée), puis départ.
    let offset = 0;
    svc.clock = () => Date.now() + offset;
    await h.voice('member', 'voice');
    offset += 5 * 60_000;
    await h.voice('member', null);
    svc.flush();
    const voice = repo.topVoiceChannels(G, today());
    assert.equal(voice[0]?.channel_id, IDS.channels.voice);
    assert.ok(voice[0].voice >= 299 && voice[0].voice <= 301, `${voice[0].voice} s de vocal`);

    // Arrivées et départs (le bot qui arrive n'est pas compté).
    const newcomer = h.addUser('Nouvelle');
    await h.memberJoin(newcomer);
    await h.memberLeave(newcomer.id);
    await h.memberJoin(h.addUser('Robot', { bot: true }));
    svc.flush();
    assert.deepEqual(repo.flows(G, today()).map((f) => [f.joins, f.leaves]), [[1, 1]]);

    // Collecte coupée : plus rien n'est compté.
    h.configure({ stats: { enabled: false } });
    await h.userMessage({ as: 'member', content: 'Hors collecte' });
    svc.flush();
    assert.equal(repo.totals(G, today()).messages, 4);
    h.configure({ stats: { enabled: true } });

    // Arrêt du bot : le tampon est écrit avant la fermeture de la base.
    await h.userMessage({ as: 'target', content: 'Dernier message avant l\'arrêt' });
    const stop = svc.stop.bind(svc);
    let atStop = null;
    svc.stop = async () => {
      await stop();
      atStop = repo.totals(G, today()).messages;
    };
    assert.equal(h.problemCount(), 0, h.formatProblems());
    closed = true;
    await h.close();
    assert.equal(atStop, 5, 'tampon perdu à l\'arrêt');
  } finally {
    if (!closed) await h.close();
  }
});

test('/statistiques : chaque vue et période, réglages ; lecture réservée puis publique ; statistiques d\'un membre', async () => {
  const h = await createHarness();
  h.configureAll();
  const repo = h.client.repositories.activity;
  const G = h.guild.id;
  // 40 jours d'historique : messages, vocal, heures, arrivées et départs.
  const messages = [];
  const hours = [];
  const flows = [];
  for (let i = 0; i < 40; i += 1) {
    const day = addDays(today(), -i);
    messages.push({ guildId: G, day, channelId: IDS.channels.general, userId: IDS.users.member, count: (i % 7) + 1 });
    messages.push({ guildId: G, day, channelId: IDS.channels.rules, userId: IDS.users.target, count: (i % 3) + 1 });
    hours.push({ guildId: G, day, hour: (i * 5) % 24, count: (i % 7) + (i % 3) + 2 });
    flows.push({ guildId: G, day, joins: i % 4, leaves: i % 2 });
  }
  repo.applyBatch({ messages, hours, flows, voice: [{ guildId: G, day: today(), channelId: IDS.channels.voice, userId: IDS.users.member, seconds: 3_900 }] });
  try {
    const rec = await h.slash('statistiques', sub('serveur'));
    const first = h.messagesOf(rec)[0];
    assert.match(first.embeds[0].description, /\*\*7 j\*\* `[▁▂▃▄▅▆▇█]{7}`/);
    assert.match(first.embeds[0].description, /\*\*30 j\*\* `[▁▂▃▄▅▆▇█]{30}`/);
    const stats = await explore(h, rec, { budget: 200 });
    for (const view of ['serveur', 'salons', 'membres', 'heures', 'croissance', 'reglages']) assert.ok(stats.navChosen.has(`cmd:statistiques:nav=${view}`), `vue ${view} jamais ouverte`);
    for (const key of ['go', 'retention', 'collect', 'access', 'wipe']) assert.ok(stats.keys.has(`cmd:statistiques:${key}`), `${key} jamais utilisé`);

    // Période conservée en changeant de vue (l'exploration a pu tout effacer : données remises,
    // vues en cache oubliées puisqu'elles sont écrites directement en base).
    repo.applyBatch({ messages, hours, flows });
    h.client.services.activity.forgetViews(G);
    const fresh = await h.slash('statistiques', sub('serveur', [{ name: 'vue', type: 3, value: 'heures' }, { name: 'periode', type: 4, value: 7 }]));
    const hoursMsg = h.messagesOf(fresh)[0];
    assert.match(hoursMsg.embeds[0].description, /```\n00 h │/);
    const nav = await h.click(hoursMsg, 'cmd:statistiques:nav', { values: ['salons'] });
    assert.match(h.messagesOf(nav)[0].embeds[0].footer.text, /Période : 7 jours/);
    const growth = await h.click(h.messagesOf(nav)[0], 'cmd:statistiques:nav', { values: ['croissance'] });
    assert.match(h.replyText(growth), /Membres\*\* `[▁▂▃▄▅▆▇█]+`/);

    // Réglages : conservation, lecture publique.
    const settings = await h.slash('statistiques', sub('reglages'));
    const retention = await h.click(h.messagesOf(settings)[0], 'cmd:statistiques:retention', { values: ['60'] });
    assert.equal(h.client.services.config.get(G).stats.retentionDays, 60);

    // Membre sans « Gérer le serveur » : réservé (sauf ses propres statistiques).
    assert.ok(h.isError(await h.slash('statistiques', sub('serveur'), { as: 'member' })));
    assert.ok(h.isError(await h.slash('statistiques', sub('reglages'), { as: 'member' })));
    assert.ok(h.isError(await h.slash('statistiques', sub('membre', [{ name: 'membre', type: 6, value: IDS.users.target }]), { as: 'member' })));
    const own = await h.slash('statistiques', sub('membre'), { as: 'member' });
    assert.ok(!h.isError(own));
    assert.match(h.replyText(own), /Messages par jour\*\* `[▁▂▃▄▅▆▇█]{30}`/);
    const before = JSON.stringify(h.client.services.config.get(G).stats);
    await explore(h, retention, { as: 'member', budget: 25 });
    await explore(h, own, { as: 'member', budget: 15 });
    assert.equal(JSON.stringify(h.client.services.config.get(G).stats), before, 'un membre a modifié les réglages');

    // Lecture publique : tout le monde, sans la vue des réglages.
    const publicRec = await h.click(h.messagesOf(retention)[0], 'cmd:statistiques:access:on');
    assert.equal(h.client.services.config.get(G).stats.public, true);
    assert.ok(buttonStarting(h.messagesOf(publicRec)[0], 'cmd:statistiques:access:off'));
    const open = await h.slash('statistiques', sub('serveur'), { as: 'member' });
    assert.ok(!h.isError(open));
    const options = h.findComponent(h.messagesOf(open)[0], 'cmd:statistiques:nav').options.map((o) => o.value);
    assert.ok(!options.includes('reglages'));
    const other = await h.slash('statistiques', sub('membre', [{ name: 'membre', type: 6, value: IDS.users.member }]), { as: 'target' });
    assert.match(h.replyText(other), /Salons favoris|Messages par jour/);
    await explore(h, open, { as: 'member', budget: 30 });
    // Forcer la vue des réglages reste refusé.
    assert.ok(h.isError(await h.click(h.messagesOf(open)[0], 'cmd:statistiques:nav', { values: ['reglages'], as: 'member' })));
    assert.equal(h.client.services.config.get(G).stats.public, true);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/activite : collecte trop récente refusée ; liste, exclusions, rôle, MP (1/semaine), expulsion (confirmation forte, 50 max, hiérarchie)', async () => {
  const h = await createHarness();
  h.configureAll();
  const repo = h.client.repositories.activity;
  const config = h.client.services.config;
  const G = h.guild.id;
  const delay = activite.timing.dmDelayMs;
  activite.timing.dmDelayMs = 0;
  try {
    // Collecte qui vient de démarrer : liste affichée, actions refusées.
    const early = await h.slash('activite', [{ name: 'jours', type: 4, value: 30 }]);
    const earlyMsg = h.messagesOf(early)[0];
    assert.match(h.replyText(early), /tout le monde paraît inactif/);
    assert.ok(h.findComponent(earlyMsg, 'cmd:activite:act:30:kick').disabled, 'expulsion proposée trop tôt');
    const forced = await h.click(earlyMsg, 'cmd:activite:act:30:kick');
    assert.ok(h.isError(forced));
    assert.match(h.replyText(forced), /collecte tourne depuis/);
    assert.ok(h.isError(await h.slash('activite', [{ name: 'jours', type: 4, value: 120 }])), 'au-delà de la conservation');

    // 60 jours de collecte ; 55 dormeurs, un dormeur « admin » (protégé), un staff (exclu), un actif.
    repo.setSince(G, Date.now() - 60 * DAY);
    const sleepers = Array.from({ length: 55 }, (_, i) => addSleeper(h, `Dormeur${i}`));
    const peer = addSleeper(h, 'Pair', { roles: [IDS.roles.admin] });
    const staff = addSleeper(h, 'Equipe', { roles: [IDS.roles.mod] });
    const newbie = addSleeper(h, 'Recent', { joinedDaysAgo: 5 });
    repo.applyBatch({ messages: [
      { guildId: G, day: today(), channelId: IDS.channels.general, userId: IDS.users.member, count: 2 },
      { guildId: G, day: addDays(today(), -45), channelId: IDS.channels.general, userId: sleepers[0], count: 9 },
    ] });

    const rec = await h.slash('activite', [{ name: 'jours', type: 4, value: 30 }]);
    let msg = h.messagesOf(rec)[0];
    assert.match(h.replyText(rec), /Membres inactifs depuis 30 jours/);
    assert.ok(!h.findComponent(msg, 'cmd:activite:act:30:kick').disabled);
    const excl = await h.click(msg, 'cmd:activite:excl:30', { values: [IDS.roles.mod] });
    assert.deepEqual(config.get(G).stats.inactivity.excludedRoles, [IDS.roles.mod]);
    msg = h.messagesOf(excl)[0];
    const count = Number(/\*\*(\d+)\*\* membre\(s\) sans message/.exec(msg.embeds[0].description)[1]);
    // 55 dormeurs + pair + propriétaire + admin + cible (le staff, l'actif, le nouveau et les bots exclus).
    assert.equal(count, 59);
    assert.ok(!JSON.stringify(msg.embeds).includes(newbie));
    const page2 = await h.click(msg, buttonStarting(msg, 'cmd:activite:page:30:1:n').custom_id);
    assert.match(h.messagesOf(page2)[0].embeds[0].footer.text, /Page 2\/6/);

    // Rôle à permission sensible : refusé.
    const pick = await h.click(msg, 'cmd:activite:act:30:give');
    const pickMsg = h.messagesOf(pick)[0];
    assert.ok(h.isError(await h.click(pickMsg, 'cmd:activite:role:30:give', { values: [IDS.roles.mod] })));
    // Donner « Joueur » : confirmation puis exécution.
    const confirmGive = await h.click(pickMsg, 'cmd:activite:role:30:give', { values: [IDS.roles.gamer] });
    assert.match(h.replyText(confirmGive), /Donner <@&\d+> à \*\*58\*\* membre/);
    const runGive = buttonStarting(h.messagesOf(confirmGive)[0], 'cmd:activite:run:30:give:');
    const gave = await h.click(h.messagesOf(confirmGive)[0], runGive.custom_id);
    assert.match(h.replyText(gave), /terminé/);
    const hasGamer = (id) => h.fake.members.get(id)?.roles.includes(IDS.roles.gamer);
    assert.ok(sleepers.every(hasGamer), 'rôle non donné à tous les dormeurs');
    assert.ok(!hasGamer(IDS.users.admin), 'l\'auteur de l\'action a reçu le rôle');
    assert.ok(!hasGamer(staff));
    assert.equal(config.get(G).stats.inactivity.roleId, IDS.roles.gamer);
    // Retirer « Joueur » : le membre actif le garde.
    const pickTake = await h.click(h.messagesOf(gave)[0], 'cmd:activite:page:30:0:b');
    const take = await h.click(h.messagesOf(pickTake)[0], 'cmd:activite:act:30:take');
    const confirmTake = await h.click(h.messagesOf(take)[0], 'cmd:activite:role:30:take', { values: [IDS.roles.gamer] });
    await h.click(h.messagesOf(confirmTake)[0], buttonStarting(h.messagesOf(confirmTake)[0], 'cmd:activite:run:30:take:').custom_id);
    assert.ok(!sleepers.some(hasGamer));
    assert.ok(hasGamer(IDS.users.member), 'rôle retiré à un membre actif');

    // MP : 25 par exécution, jamais deux fois la même semaine.
    let list = h.messagesOf(await h.slash('activite', [{ name: 'jours', type: 4, value: 30 }]))[0];
    let mark = h.fake.calls.length;
    const sent = [];
    for (let run = 0; run < 3; run += 1) {
      const open = await h.click(list, 'cmd:activite:act:30:dm');
      assert.equal(open.modals.length, 1);
      const preview = await h.submitModal(open, { message: 'Coucou {membre} ! {serveur} vous attend depuis {jours} jours.' });
      const previewMsg = h.messagesOf(preview)[0];
      assert.equal(previewMsg.embeds.length, 2, 'aperçu du MP absent');
      const done = await h.click(previewMsg, 'cmd:activite:run:30:dm');
      sent.push(dmMessages(h, mark).length);
      mark = h.fake.calls.length;
      list = h.messagesOf(await h.click(h.messagesOf(done)[0], 'cmd:activite:page:30:0:b'))[0];
    }
    // 59 inactifs moins l'auteur : 25 + 25 + 8.
    assert.deepEqual(sent, [25, 25, 8]);
    const last = await h.submitModal(await h.click(list, 'cmd:activite:act:30:dm'), { message: 'Encore vous ? {membre}' });
    assert.ok(h.findComponent(h.messagesOf(last)[0], 'cmd:activite:run:30:dm').disabled, 'MP proposé à des membres déjà contactés');
    assert.match(h.replyText(last), /déjà reçu un MP ces 7 derniers jours/);
    assert.match(config.get(G).stats.inactivity.dmMessage, /Encore vous/);

    // Expulsion : confirmation forte, 50 au plus, propriétaire / auteur / rôle égal protégés.
    const kickView = await h.click(h.messagesOf(last)[0], 'cmd:activite:page:30:0:b');
    const ask = await h.click(h.messagesOf(kickView)[0], 'cmd:activite:act:30:kick');
    assert.match(h.replyText(ask), /Expulser 50 membre\(s\) \?/);
    // Le bouton porte le jeton de la liste affichée (l'expulsion porte exactement sur elle).
    const kickformId = (h.messagesOf(ask)[0].components ?? []).flatMap((r) => r.components ?? []).map((c) => c.custom_id).find((id) => id?.startsWith('cmd:activite:kickform:30:'));
    assert.ok(kickformId, 'bouton « Expulser… » absent');
    const form = await h.click(h.messagesOf(ask)[0], kickformId);
    const wrong = await h.submitModal(form, { confirmation: 'oui', raison: '' });
    assert.ok(h.isError(wrong));
    assert.equal(sleepers.filter((id) => h.fake.members.has(id)).length, 55, 'expulsion sans confirmation');
    const form2 = await h.click(h.messagesOf(ask)[0], kickformId);
    const logMark = h.fake.messageLog.length;
    const kicked = await h.submitModal(form2, { confirmation: 'expulser', raison: 'Ménage de rentrée' });
    assert.match(h.replyText(kicked), /\*\*50\*\* membre\(s\) traité\(s\)/);
    const remaining = [...sleepers, IDS.users.target].filter((id) => h.fake.members.has(id));
    assert.equal(remaining.length, 6);
    for (const id of [IDS.users.owner, IDS.users.admin, peer, staff, IDS.users.member, newbie]) assert.ok(h.fake.members.has(id), `${id} expulsé à tort`);
    const logged = h.fake.messageLog.slice(logMark).map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs && /Membres inactifs/.test(m.embeds?.[0]?.title ?? ''));
    assert.equal(logged.length, 1, 'action groupée non journalisée');
    assert.match(logged[0].embeds[0].fields.map((f) => f.value).join(' '), /Ménage de rentrée/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    activite.timing.dmDelayMs = delay;
    await h.close();
  }
});

test('/activite : refusée sans « Gérer le serveur » ; les composants d\'un administrateur ne changent rien pour un membre', async () => {
  const h = await createHarness();
  h.configureAll();
  const G = h.guild.id;
  try {
    h.client.repositories.activity.setSince(G, Date.now() - 60 * DAY);
    addSleeper(h, 'Dormeur');
    assert.ok(h.isError(await h.slash('activite', [], { as: 'member' })));
    const rec = await h.slash('activite');
    const stats = await explore(h, rec, { budget: 60, skip: (a) => a.customId.startsWith('cmd:activite:kickform') });
    assert.ok(stats.modals >= 1, 'formulaire de MP non exploré');
    const fresh = await h.slash('activite');
    const state = () => JSON.stringify({ cfg: h.client.services.config.get(G).stats, members: [...h.fake.members.values()].map((m) => [m.user.id, m.roles]) });
    const before = state();
    const dms = dmMessages(h).length;
    await explore(h, fresh, { as: 'member', budget: 40 });
    assert.equal(state(), before, 'un membre a modifié la configuration ou les membres');
    assert.equal(dmMessages(h).length, dms, 'un membre a envoyé des MP');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
