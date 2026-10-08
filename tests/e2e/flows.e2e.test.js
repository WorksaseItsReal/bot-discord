'use strict';

/**
 * Bout en bout : parcours complets à plusieurs utilisateurs (tickets, giveaways,
 * suggestions, menus de rôles, ModMail, vérification, niveaux, échéances), avec
 * clics simultanés (double clic) et une latence REST simulée pour faire apparaître
 * les courses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, sleep } = require('./harness');
const { explore } = require('./lib/explore');
const { freshMember } = require('./lib/overrides');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const hasButton = (prefix) => (m) => (m.components ?? []).some((r) => r.components.some((c) => c.custom_id?.startsWith(prefix)));
/** Exploration d'un message isolé (panneau publié dans un salon). */
const exploreMessage = (h, message, opts) => explore(h, { messages: [message.id], followUps: [], modals: [], msgMark: h.fake.messageLog.length }, opts);

async function setup() {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 3;
  return h;
}

test('tickets : panneau, double clic d\'ouverture, prise en charge concurrente, commandes, fermeture', async () => {
  const h = await setup();
  try {
    h.configure({ tickets: { panelChannelId: IDS.channels.general } });
    const dash = await h.slash('tickets');
    await h.click(h.message(dash.original), 'cmd:tickets:publish');
    const panel = botMessages(h, 0, hasButton('ticket:create'))[0];
    assert.ok(panel, 'panneau de tickets non publié');

    let mark = h.fake.messageLog.length;
    await Promise.all([h.click(panel, 'ticket:create', { as: 'member' }), h.click(panel, 'ticket:create', { as: 'member' })]);
    await h.settle();
    const tickets = [...h.fake.channels.values()].filter((c) => c.name?.startsWith('ticket-'));
    assert.equal(tickets.length, 1, 'un double clic a ouvert deux tickets');
    const ticket = tickets[0];
    assert.ok(ticket.permission_overwrites.some((o) => o.id === IDS.users.member && o.type === 1), 'l\'auteur n\'a pas accès à son ticket');
    assert.ok(!ticket.permission_overwrites.some((o) => o.id === IDS.users.target), 'un autre membre a accès au ticket');

    const welcome = botMessages(h, mark, hasButton('ticket:claim'))[0];
    assert.ok(welcome, 'carte d\'accueil du ticket absente');
    const claims = await Promise.all([h.click(welcome, 'ticket:claim', { as: 'mod' }), h.click(welcome, 'ticket:claim', { as: 'admin' })]);
    assert.ok(claims.every((r) => r.ackType != null));
    assert.ok(h.client.repositories.tickets.getByChannel(ticket.id).claimed_by, 'prise en charge non enregistrée');

    const inTicket = { as: 'mod', channel: ticket.id };
    await h.slash('ticket', sub('add', [opt('membre', 6, IDS.users.target)]), inTicket);
    assert.ok(h.fake.channels.get(ticket.id).permission_overwrites.some((o) => o.id === IDS.users.target), '/ticket add sans effet');
    await h.slash('ticket', sub('remove', [opt('membre', 6, IDS.users.target)]), inTicket);
    await h.slash('ticket', sub('rename', [opt('nom', 3, 'support urgent')]), inTicket);
    const transcript = await h.slash('ticket', sub('transcript'), inTicket);
    assert.ok(h.fake.calls.some((c) => c.label === transcript.label && c.files.length), `transcript sans fichier : ${h.replyText(transcript)}`);

    const close = await h.click(h.message(welcome.id), 'ticket:close', { as: 'member' });
    const confirm = h.message(close.original);
    mark = h.fake.messageLog.length;
    await Promise.all([h.click(confirm, 'ticket:closeconfirm', { as: 'member' }), h.click(confirm, 'ticket:closeconfirm', { as: 'member' })]);
    await sleep(5_300); // délai de fermeture du bot (5 s)
    await h.settle();
    assert.ok(!h.fake.channels.has(ticket.id), 'ticket non supprimé après fermeture');
    assert.ok(h.fake.calls.some((c) => c.route === `/channels/${IDS.channels.logs}/messages` && c.files.length), 'transcript non archivé dans le salon des logs');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('giveaway : participations simultanées, fin, reroll, échéance par le scheduler', async () => {
  const h = await setup();
  try {
    let mark = h.fake.messageLog.length;
    await h.slash('giveaway', sub('create', [opt('recompense', 3, 'Nitro'), opt('duree', 3, '1h'), opt('gagnants', 4, 2)]));
    const gw = botMessages(h, mark, hasButton('giveaway:enter:'))[0];
    assert.ok(gw, 'message de giveaway absent');
    const enter = gw.components[0].components[0].custom_id;
    await Promise.all(['member', 'member', 'target', 'mod'].map((as) => h.click(gw, enter, { as })));
    await h.client.services.giveaways.flush();
    await h.settle();
    assert.equal(h.client.repositories.giveaways.countEntries(1), 3, 'participations en double ou perdues');
    await exploreMessage(h, h.message(gw.id), { as: 'target', budget: 10 });
    await h.slash('giveaway', sub('end', [opt('id', 4, 1)]));
    await h.slash('giveaway', sub('reroll', [opt('id', 4, 1), opt('gagnants', 4, 1)]));

    // Second giveaway terminé par le scheduler (échéance dépassée).
    mark = h.fake.messageLog.length;
    await h.slash('giveaway', sub('create', [opt('recompense', 3, 'Rôle VIP'), opt('duree', 3, '1h'), opt('gagnants', 4, 1)]));
    const gw2 = botMessages(h, mark, hasButton('giveaway:enter:'))[0];
    await h.click(gw2, gw2.components[0].components[0].custom_id, { as: 'member' });
    h.client.database.db.prepare('UPDATE giveaways SET ends_at = ? WHERE id = 2').run(Date.now() - 1000);
    mark = h.fake.messageLog.length;
    await h.client.services.scheduler.tick();
    await h.client.services.giveaways.flush();
    await h.settle();
    assert.ok(botMessages(h, mark).some((m) => m.content?.includes(IDS.users.member)), 'gagnant non annoncé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('suggestions et menus de rôles : votes et choix simultanés', async () => {
  const h = await setup();
  try {
    let mark = h.fake.messageLog.length;
    await h.slash('suggestion', sub('create', [opt('contenu', 3, 'Ajouter un salon musique')]), { as: 'member' });
    const sg = botMessages(h, mark, hasButton('suggestion:'))[0];
    assert.ok(sg, 'carte de suggestion absente');
    const [up, down] = sg.components.flatMap((r) => r.components.map((c) => c.custom_id));
    await Promise.all([h.click(sg, up, { as: 'target' }), h.click(sg, up, { as: 'target' }), h.click(sg, down, { as: 'mod' }), h.click(sg, up, { as: 'admin' })]);
    await h.settle();
    await h.slash('suggestion', sub('approve', [opt('id', 4, 1), opt('raison', 3, 'Validé')]));

    mark = h.fake.messageLog.length;
    await h.slash('rolemenu', [opt('titre', 3, 'Rôles'), opt('role1', 8, IDS.roles.notif), opt('role2', 8, IDS.roles.gamer)]);
    const rm = botMessages(h, mark, hasButton('rolemenu:'))[0];
    const menu = rm.components[0].components[0].custom_id;
    await h.click(rm, menu, { as: 'target', values: [IDS.roles.gamer] });
    assert.ok(h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.gamer), 'rôle du menu non donné');
    await h.click(rm, menu, { as: 'target', values: [IDS.roles.gamer] });
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.gamer), 'rôle du menu non retiré au second choix');
    await Promise.all([h.click(rm, menu, { as: 'target', values: [IDS.roles.notif] }), h.click(rm, menu, { as: 'target', values: [IDS.roles.notif] })]);
    await h.click(rm, menu, { as: 'target', values: [] });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('ModMail : réponse du staff, boutons, fermeture', async () => {
  const h = await setup();
  try {
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Bonjour, j\'ai un souci' });
    const channel = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    const dm = h.dmChannel('target');
    let mark = h.fake.messageLog.length;
    await h.slash('modmail', sub('reply', [opt('message', 3, 'Nous regardons')]), { as: 'mod', channel: channel.id });
    assert.ok(botMessages(h, mark, (m) => m.channel_id === dm.id).length, 'réponse non relayée en MP');
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Merci !' });
    const card = botMessages(h, 0, (m) => m.channel_id === channel.id && m.components?.length)[0];
    await exploreMessage(h, card, { as: 'mod', budget: 6, skip: (a) => /close/.test(a.customId) });
    mark = h.fake.messageLog.length;
    await h.slash('modmail', sub('close'), { as: 'mod', channel: channel.id });
    await h.settle();
    assert.ok(botMessages(h, mark, (m) => m.channel_id === dm.id).length, 'membre non prévenu de la fermeture');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('vérification : panneau publié, question anti-robot, rôle donné', async () => {
  const h = await setup();
  try {
    h.configure({ welcome: { verification: { enabled: true, roleId: IDS.roles.notif, channelId: IDS.channels.rules, captcha: true } } });
    const dash = await h.slash('bienvenue');
    const nav = await h.click(h.message(dash.original), 'cmd:bienvenue:nav', { values: ['verify'] });
    await h.click(h.message(nav.componentMessageId), 'cmd:bienvenue:publish');
    const panel = botMessages(h, 0, hasButton('cmd:bienvenue:verify'))[0];
    assert.ok(panel, 'panneau de vérification non publié');
    const newcomer = h.addUser('Arrivant', { ageDays: 500 });
    await h.memberJoin(newcomer);
    const wrong = await h.click(panel, 'cmd:bienvenue:verify', { as: newcomer.id });
    const refused = await h.submitModal(wrong, { answer: 'faux' }, { as: newcomer.id });
    assert.ok(h.isError(refused), 'mauvaise réponse acceptée');
    const open = await h.click(panel, 'cmd:bienvenue:verify', { as: newcomer.id });
    const { answer } = h.client.services.welcome.challenges.get(`${h.guild.id}:${newcomer.id}`);
    await h.submitModal(open, { answer }, { as: newcomer.id });
    assert.ok(h.fake.members.get(newcomer.id).roles.includes(IDS.roles.notif), 'rôle vérifié non donné');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('niveaux, paliers d\'avertissements et échéances (tempban, mute, rappel)', async () => {
  const h = await setup();
  h.configure({ moderation: { confirmDangerous: false, mutedRoleId: IDS.roles.muted }, automod: { enabled: false } });
  try {
    h.client.services.levels.grantDelayMs = 0; // gain d'XP différé de 2 s par le bot
    for (let i = 0; i < 10; i += 1) await h.userMessage({ as: 'target', content: `message numéro ${i} pour gagner de l'xp` });
    assert.ok(await h.waitFor(() => h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.notif)), 'récompense de niveau non donnée');
    await h.slash('rang', [], { as: 'target' });
    await h.slash('classement', [], { as: 'target' });

    for (let i = 0; i < 3; i += 1) {
      h.client.cooldowns.expiries.clear();
      await h.slash('warn', [opt('membre', 6, IDS.users.member), opt('raison', 3, `avertissement ${i}`)], { as: 'mod' });
    }
    await h.settle();
    assert.ok(h.fake.members.get(IDS.users.member).roles.includes(IDS.roles.muted) || h.fake.members.get(IDS.users.member).communication_disabled_until, 'palier de 3 avertissements non appliqué');

    const victim = await freshMember(h, 'Victime');
    await h.slash('tempban', [opt('membre', 6, victim), opt('duree', 3, '1h')]);
    assert.ok(h.fake.bans.has(victim));
    h.client.cooldowns.expiries.clear();
    await h.slash('mute', [opt('membre', 6, IDS.users.target), opt('duree', 3, '1h')]);
    assert.ok(h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.muted));
    await h.slash('reminder', sub('create', [opt('duree', 3, '10m'), opt('message', 3, 'Rappel test')]), { as: 'member' });
    const db = h.client.database.db;
    db.prepare('UPDATE sanctions SET expires_at = ? WHERE expires_at IS NOT NULL').run(Date.now() - 1000);
    db.prepare('UPDATE reminders SET remind_at = ?').run(Date.now() - 1000);
    const mark = h.fake.messageLog.length;
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.ok(!h.fake.bans.has(victim), 'tempban non levé à échéance');
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.muted), 'mute non levé à échéance');
    assert.ok(botMessages(h, mark).some((m) => (m.embeds ?? []).some((e) => e.description?.includes('Rappel test'))), 'rappel non délivré');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
