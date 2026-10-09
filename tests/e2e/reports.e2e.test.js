'use strict';

/**
 * Bout en bout : menus contextuels (clic droit → Applications) et signalements.
 *  - « Signaler le message » : formulaire, carte du staff (mention de rôle explicite),
 *    log Modération, anti-abus (doublon, délai, soi-même, bot), boutons du staff
 *    (avertir, timeout, supprimer, classer, rejeter) et refus sans permission ;
 *  - menus utilisateur des modérateurs : « Infos du membre », « Sanctions du membre »,
 *    « Note de modération » (formulaire → note enregistrée) ;
 *  - /signalements (tableau de bord) et /help sur un menu contextuel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');

const REPORT = 'Signaler le message';
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const buttonIds = (m) => (m?.components ?? []).flatMap((r) => r.components.map((c) => c.custom_id)).filter(Boolean);
const fieldText = (m) => (m?.embeds?.[0]?.fields ?? []).map((f) => `${f.name}: ${f.value}`).join('\n');
const authoredBy = (h, as, content, files = []) => h.fake.buildMessage({ channelId: IDS.channels.general, body: { content }, files, author: h.fake.users.get(IDS.users[as] ?? as) });
/** Lève les délais de commande sans toucher au délai anti-abus des signalements. */
const clearCommandCooldowns = (h) => {
  for (const key of [...h.client.cooldowns.expiries.keys()]) if (!key.startsWith('report:')) h.client.cooldowns.expiries.delete(key);
};

async function setup() {
  const h = await createHarness();
  h.configureAll();
  h.configure({ reports: { channelId: IDS.channels.staff, pingRoleId: IDS.roles.mod } });
  return h;
}

/** Signale `message` en tant que `as` (menu + formulaire). @returns {{ menu, submit }} */
async function report(h, message, as, raison = 'Insulte envers un membre') {
  const menu = await h.contextMenu(REPORT, message, { as });
  if (!menu.modals.length) return { menu, submit: null };
  const submit = await h.submitModal(menu, { raison });
  return { menu, submit };
}

test('signalement : formulaire, carte du staff, log, anti-abus', async () => {
  const h = await setup();
  try {
    const msg = authoredBy(h, 'target', 'Tu es vraiment nul @everyone', [{ name: 'preuve.png', contentType: 'image/png' }]);
    const mark = h.fake.messageLog.length;
    const { menu, submit } = await report(h, msg, 'member');
    assert.equal(menu.modals[0].custom_id, `cmd:signalements:submit:${IDS.channels.general}:${msg.id}`);
    assert.ok(submit, 'formulaire de signalement non ouvert');
    assert.match(h.replyText(submit), /Signalement envoyé/);
    assert.ok(h.messagesOf(submit).every((m) => m.flags & EPHEMERAL), 'confirmation non éphémère');

    const row = h.client.repositories.reports.get(h.guild.id, 1);
    assert.equal(row.status, 'open');
    assert.equal(row.reporter_id, IDS.users.member);
    assert.equal(row.target_id, IDS.users.target);
    assert.deepEqual(row.attachments, ['preuve.png']);

    const cardMsg = botMessages(h, mark, (m) => m.channel_id === IDS.channels.staff)[0];
    assert.ok(cardMsg, 'carte absente du salon des signalements');
    assert.equal(cardMsg.content, `<@&${IDS.roles.mod}>`);
    const sendCall = h.fake.calls.find((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.staff}/messages`);
    assert.deepEqual(sendCall.body.allowed_mentions, { parse: [], roles: [IDS.roles.mod] }, 'mention de rôle sans allowedMentions explicite');
    assert.match(cardMsg.embeds[0].title, /Signalement #1/);
    assert.match(fieldText(cardMsg), new RegExp(`<@${IDS.users.member}>`), 'signaleur absent de la carte');
    assert.match(fieldText(cardMsg), /preuve\.png/);
    assert.match(fieldText(cardMsg), /Insulte envers un membre/);
    assert.ok(buttonIds(cardMsg).includes('cmd:signalements:warn:1'));
    assert.ok(botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && /Nouveau signalement/.test(m.embeds?.[0]?.title ?? '')).length, 'log Modération absent');

    // Anti-abus : délai entre deux signalements, doublon, soi-même, bot.
    clearCommandCooldowns(h);
    const other = authoredBy(h, 'target', 'Deuxième message');
    const soon = await h.contextMenu(REPORT, other, { as: 'member', keepCooldowns: true });
    assert.ok(h.isError(soon) && /Vous venez d'envoyer un signalement/.test(h.replyText(soon)), `délai ignoré : ${h.replyText(soon)}`);
    assert.equal(soon.modals.length, 0);
    const dup = await h.contextMenu(REPORT, msg, { as: 'member' });
    assert.ok(h.isError(dup) && /déjà signalé/.test(h.replyText(dup)), `doublon accepté : ${h.replyText(dup)}`);
    const own = await h.contextMenu(REPORT, authoredBy(h, 'member', 'Mon message'), { as: 'member' });
    assert.ok(h.isError(own) && /propre message/.test(h.replyText(own)));
    const bot = await h.contextMenu(REPORT, authoredBy(h, 'otherBot', 'bip'), { as: 'member' });
    assert.ok(h.isError(bot) && /bot/.test(h.replyText(bot)));

    // Anonymat : carte sans signaleur quand l'affichage est désactivé.
    h.configure({ reports: { showReporter: false } });
    const mark2 = h.fake.messageLog.length;
    await report(h, other, 'admin', '');
    const anon = botMessages(h, mark2, (m) => m.channel_id === IDS.channels.staff)[0];
    assert.ok(anon, 'second signalement non publié');
    assert.match(fieldText(anon), /Anonyme/);
    assert.doesNotMatch(fieldText(anon), new RegExp(IDS.users.admin), 'signaleur visible malgré l\'anonymat');
    assert.match(fieldText(anon), /Aucune raison fournie/);
    assert.equal(h.client.repositories.reports.counts(h.guild.id).open, 2);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('signalement : boutons du staff (refus sans permission, avertir, timeout, supprimer, classer, rejeter)', async () => {
  const h = await setup();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    const msg = authoredBy(h, 'target', 'Spam spam spam');
    const mark = h.fake.messageLog.length;
    await report(h, msg, 'member');
    const cardMsg = botMessages(h, mark, (m) => m.channel_id === IDS.channels.staff)[0];
    assert.ok(cardMsg);

    // Un membre sans permission : tout est refusé, rien ne change.
    for (const id of buttonIds(cardMsg).filter((b) => b.startsWith('cmd:signalements:'))) {
      const rec = await h.click(cardMsg, id, { as: 'member' });
      assert.ok(h.isError(rec), `${id} accepté pour un membre`);
    }
    assert.ok(h.message(msg.id), 'message supprimé par un membre');
    assert.equal(h.client.repositories.reports.get(h.guild.id, 1).status, 'open');
    // La personne signalée (même modératrice) ne traite pas son propre signalement.
    const concerned = await h.click(cardMsg, 'cmd:signalements:resolve:1:dismissed', { as: 'target' });
    assert.ok(h.isError(concerned));

    const warn = await h.click(cardMsg, 'cmd:signalements:warn:1', { as: 'mod' });
    assert.ok(!h.isError(warn), h.replyText(warn));
    const sanctions = h.client.repositories.sanctions.listPage(h.guild.id, IDS.users.target, { limit: 5 });
    assert.ok(sanctions.some((s) => s.type === 'warn' && /signalement #1/.test(s.reason)), 'avertissement non enregistré');
    let card = h.message(cardMsg.id);
    assert.ok(!buttonIds(card).includes('cmd:signalements:warn:1'), 'bouton Avertir encore présent');
    assert.match(card.embeds[0].description, /Traité/);
    assert.match(fieldText(card), /Membre averti/);

    await h.click(card, 'cmd:signalements:mute:1', { as: 'mod' });
    assert.ok(h.fake.members.get(IDS.users.target).communication_disabled_until, 'timeout non appliqué');
    card = h.message(cardMsg.id);
    await h.click(card, 'cmd:signalements:del:1', { as: 'mod' });
    assert.ok(!h.message(msg.id), 'message signalé non supprimé');
    card = h.message(cardMsg.id);
    assert.deepEqual(buttonIds(card).filter((b) => b.startsWith('cmd:signalements:')), [], `boutons restants : ${buttonIds(card)}`);
    const row = h.client.repositories.reports.get(h.guild.id, 1);
    assert.equal(row.status, 'handled');
    assert.equal(row.handled_by, IDS.users.mod);
    assert.deepEqual(row.actions.map((a) => a.type), ['warn', 'timeout', 'delete']);

    // Second signalement : rejeté par un modérateur, double clic sans effet.
    const msg2 = authoredBy(h, 'target', 'Encore un message');
    const mark2 = h.fake.messageLog.length;
    await report(h, msg2, 'admin');
    const card2 = botMessages(h, mark2, (m) => m.channel_id === IDS.channels.staff)[0];
    await Promise.all([h.click(card2, 'cmd:signalements:resolve:2:dismissed', { as: 'mod' }), h.click(card2, 'cmd:signalements:resolve:2:handled', { as: 'admin' })]);
    await h.settle();
    const row2 = h.client.repositories.reports.get(h.guild.id, 2);
    assert.ok(['dismissed', 'handled'].includes(row2.status));
    if (row2.status === 'dismissed') {
      assert.deepEqual(buttonIds(h.message(card2.id)).filter((b) => b.startsWith('cmd:signalements:')), [], 'boutons d\'action sur un signalement rejeté');
    }
    // Exploration de la carte par un membre : aucune action possible.
    const msg3 = authoredBy(h, 'target', 'Troisième');
    const mark3 = h.fake.messageLog.length;
    await report(h, msg3, 'owner');
    const card3 = botMessages(h, mark3, (m) => m.channel_id === IDS.channels.staff)[0];
    const before = JSON.stringify(h.client.repositories.reports.get(h.guild.id, 3));
    await explore(h, { messages: [card3.id], followUps: [], modals: [], msgMark: h.fake.messageLog.length }, { as: 'member', budget: 15 });
    assert.equal(JSON.stringify(h.client.repositories.reports.get(h.guild.id, 3)), before);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('menus utilisateur des modérateurs : infos, sanctions, note ; refusés aux membres', async () => {
  const h = await setup();
  try {
    const infos = await h.contextMenu('Infos du membre', 'target', { as: 'mod' });
    assert.ok(!h.isError(infos), h.replyText(infos));
    assert.ok(h.messagesOf(infos).every((m) => m.flags & EPHEMERAL));
    assert.ok(h.messagesOf(infos)[0].components.some((r) => r.components.some((c) => c.custom_id === `cmd:sanctions:history:${IDS.users.target}`)));

    const hist = await h.contextMenu('Sanctions du membre', 'target', { as: 'mod' });
    assert.match(h.replyText(hist), /Historique de modération/);

    const note = await h.contextMenu('Note de modération', 'target', { as: 'mod' });
    assert.equal(note.modals[0].custom_id, `cmd:sanctions:noteusersubmit:${IDS.users.target}`);
    const sub = await h.submitModal(note, { note: 'Averti oralement en vocal.' });
    assert.match(h.replyText(sub), /Notes de modération/);
    assert.ok(h.messagesOf(sub).every((m) => m.flags & EPHEMERAL));
    assert.equal(h.client.repositories.modNotes.count(h.guild.id, IDS.users.target), 1);
    await explore(h, hist, { as: 'mod', budget: 10 });
    const notes = h.client.repositories.modNotes.count(h.guild.id, IDS.users.target);

    for (const name of ['Infos du membre', 'Sanctions du membre', 'Note de modération']) {
      const rec = await h.contextMenu(name, 'target', { as: 'member' });
      assert.ok(h.isError(rec), `« ${name} » accepté pour un membre`);
      assert.equal(rec.modals.length, 0);
    }
    assert.equal(h.client.repositories.modNotes.count(h.guild.id, IDS.users.target), notes);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/signalements : tableau de bord, désactivation, refus sans permission ; /help sur un menu', async () => {
  const h = await setup();
  try {
    const msg = authoredBy(h, 'target', 'À signaler');
    await report(h, msg, 'member');
    const dash = await h.slash('signalements');
    assert.match(h.replyText(dash), /Signalements · Tableau de bord/);
    assert.match(h.replyText(dash), /#1/, 'signalement ouvert absent de la liste');
    const denied = await h.slash('signalements', [], { as: 'member' });
    assert.ok(h.isError(denied));

    const dashMsg = h.message(dash.original);
    await h.click(dashMsg, 'cmd:signalements:role', { values: [IDS.guild] });
    assert.equal(h.client.services.config.get(h.guild.id).reports.pingRoleId, IDS.roles.mod, '@everyone accepté comme rôle à mentionner');
    await h.click(h.message(dash.original), 'cmd:signalements:toggle:off');
    assert.equal(h.client.services.config.get(h.guild.id).reports.enabled, false);
    const off = await h.contextMenu(REPORT, authoredBy(h, 'target', 'Autre'), { as: 'member' });
    assert.ok(h.isError(off) && /désactivés/.test(h.replyText(off)));
    await h.click(h.message(dash.original), 'cmd:signalements:toggle:on');
    await h.click(h.message(dash.original), 'cmd:signalements:channel', { values: [] });
    assert.equal(h.client.services.config.get(h.guild.id).reports.channelId, null);
    await explore(h, dash, { budget: 30 });

    // Sans salon des signalements ni salon de logs Modération : refus clair, pas de formulaire.
    h.configure({ reports: { channelId: null }, logChannels: { moderation: null } });
    const unset = await h.contextMenu(REPORT, authoredBy(h, 'target', 'Encore'), { as: 'member' });
    assert.ok(h.isError(unset) && /pas encore configurés/.test(h.replyText(unset)));
    assert.equal(unset.modals.length, 0);

    const help = await h.slash('help', [{ name: 'commande', type: 3, value: 'signaler le message' }]);
    assert.match(h.replyText(help), /Signaler le message/);
    const ac = await h.autocomplete('help', [{ name: 'commande', type: 3, value: 'membre', focused: true }]);
    assert.ok(ac.autocomplete.some((c) => c.value === 'Infos du membre'), 'menu contextuel absent de l\'autocomplétion de /help');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
