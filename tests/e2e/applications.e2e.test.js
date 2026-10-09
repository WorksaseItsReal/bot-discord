'use strict';

/**
 * Bout en bout : candidatures (/candidatures, /candidature) sur le vrai discord.js.
 * Tableau de bord, panneau public, formulaire Discord, carte du staff (ping de rôle,
 * réponses en embed), acceptation (double clic → une seule décision, rôle, MP), refus
 * (motif, MP), entretien (ticket puis fil privé), retrait, délai, refus sans permission.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');

const C = () => IDS.channels;
const opt = (name, type, value) => ({ name, type, value });

/** Messages publiés par le bot dans un salon depuis `mark` (position dans messageLog). */
function botMessagesIn(h, channelId, mark = 0) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}

/** Messages privés reçus par un utilisateur depuis `mark`. */
function dmsOf(h, as, mark = 0) {
  const dm = h.dmChannel(as);
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === dm.id);
}

const buttonIds = (msg) => (msg?.components ?? []).flatMap((r) => r.components ?? []).map((c) => c.custom_id).filter(Boolean);
const embedText = (msg) => (msg?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');

/** Crée un formulaire par le tableau de bord et renvoie { id, view } (vue du formulaire). */
async function createForm(h, values) {
  const home = await h.slash('candidatures');
  const add = await h.click(h.messagesOf(home)[0], 'cmd:candidatures:create');
  assert.equal(add.modals.length, 1, 'formulaire de création non ouvert');
  const done = await h.submitModal(add, values);
  assert.match(h.replyText(done), /Formulaire \*\*.+\*\* créé/, h.replyText(done));
  const form = h.client.services.applications.forms(h.guild.id).find((f) => f.name === values.name);
  return { id: form.id, view: h.messagesOf(done)[0] };
}

/** Règle le formulaire comme un administrateur : réception, rôle, ping, panneau, ouverture, publication. */
async function setupForm(h, id, view) {
  let rec = await h.click(view, `cmd:candidatures:review:${id}`, { values: [C().staff] });
  rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:roles:${id}`, { values: [IDS.roles.notif] });
  assert.ok(!h.isError(rec), h.replyText(rec));
  rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:ping:${id}`, { values: [IDS.roles.mod] });
  rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:panelch:${id}`, { values: [C().general] });
  rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:toggle:${id}:on`);
  assert.match(h.replyText(rec), /Candidatures \*\*ouvertes\*\*/, h.replyText(rec));
  const mark = h.fake.messageLog.length;
  rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:publish:${id}`);
  assert.match(h.replyText(rec), /Panneau publié/, h.replyText(rec));
  const panel = botMessagesIn(h, C().general, mark)[0];
  assert.ok(panel, 'panneau non publié');
  assert.deepEqual(buttonIds(panel), [`cmd:candidature:apply:${id}`]);
  return { panel, view: h.messagesOf(rec)[0] };
}

/** Un membre postule depuis le panneau. Renvoie l'interaction d'envoi. */
async function apply(h, panel, as, answers) {
  const open = await h.click(panel, buttonIds(panel)[0], { as });
  if (!open.modals.length) return open;
  return h.submitModal(open, answers, { as });
}

test('/candidatures : chaque vue, bouton, menu et formulaire ; refus sans permission', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const { id, view } = await createForm(h, { name: 'Recrutement modération', description: 'Rejoignez l\'équipe !', questions: 'Quel âge avez-vous ?\n+ Pourquoi vous ?', cooldown: '0' });
    const form = h.client.services.applications.form(h.guild.id, id);
    assert.deepEqual(form.questions, [{ label: 'Quel âge avez-vous ?', long: false }, { label: 'Pourquoi vous ?', long: true }]);
    assert.equal(form.open, false, 'un nouveau formulaire doit être fermé');
    await setupForm(h, id, view);

    // Exploration complète du tableau de bord (sans suppression, explorée à part).
    const rec = await h.slash('candidatures');
    assert.match(h.replyText(rec), /Candidatures · Tableau de bord/);
    const stats = await explore(h, rec, { budget: 200, skip: (a) => a.customId.startsWith('cmd:candidatures:delete') });
    for (const v of ['home', 'pending']) assert.ok(stats.navChosen.has(`cmd:candidatures:nav=${v}`), `vue ${v} jamais ouverte`);
    assert.ok(stats.modals >= 1, `formulaires soumis : ${stats.modals}`);
    for (const key of ['pick', 'create', 'review', 'roles', 'ping', 'panelch', 'toggle', 'publish', 'edit']) assert.ok(stats.keys.has(`cmd:candidatures:${key}`), `${key} jamais utilisé : ${[...stats.keys].join(', ')}`);

    // Rôle interdit (permissions de modération) et rôle au-dessus du relecteur : refusés.
    const fresh = await h.click(h.messagesOf(await h.slash('candidatures'))[0], 'cmd:candidatures:pick', { values: [String(id)] });
    const bad = await h.click(h.messagesOf(fresh)[0], `cmd:candidatures:roles:${id}`, { values: [IDS.roles.mod] });
    assert.ok(h.isError(bad), 'rôle de modération accepté');
    assert.match(h.replyText(bad), /permissions de modération/);

    // Suppression : refusée tant qu'une candidature est en attente, puis acceptée.
    const svc = h.client.services.applications;
    svc.updateForm(h.guild.id, id, { open: true, reviewChannelId: C().staff });
    const panel = svc.forms(h.guild.id).find((f) => f.id === id);
    await svc.submit(h.guild, h.client.users.cache.get(IDS.users.member) ?? await h.client.users.fetch(IDS.users.member), panel, ['20', 'Motivé']);
    const confirm = await h.click(h.messagesOf(fresh)[0], `cmd:candidatures:go:confirmDel.${id}`);
    const refused = await h.click(h.messagesOf(confirm)[0], `cmd:candidatures:delete:${id}`);
    assert.ok(h.isError(refused), 'formulaire supprimé malgré une candidature en attente');
    const pending = h.client.repositories.applications.listPending(h.guild.id)[0];
    h.client.repositories.applications.decide(h.guild.id, pending.id, { status: 'rejected', reviewerId: IDS.users.admin });
    const panelMsg = svc.form(h.guild.id, id).panel_message_id;
    const fresh2 = await h.click(h.messagesOf(await h.slash('candidatures'))[0], 'cmd:candidatures:pick', { values: [String(id)] });
    const confirm2 = await h.click(h.messagesOf(fresh2)[0], `cmd:candidatures:go:confirmDel.${id}`);
    const deleted = await h.click(h.messagesOf(confirm2)[0], `cmd:candidatures:delete:${id}`);
    assert.match(h.replyText(deleted), /supprimé/);
    assert.ok(!svc.forms(h.guild.id).some((f) => f.id === id), 'formulaire non supprimé');
    assert.ok(!h.fake.messages.has(panelMsg), 'panneau du formulaire supprimé non retiré');

    // Membre sans « Gérer le serveur » : commande et composants refusés, rien ne change.
    await createForm(h, { name: 'Équipe événements', description: '', questions: 'Vos disponibilités ?', cooldown: '7d' });
    assert.ok(h.isError(await h.slash('candidatures', [], { as: 'member' })));
    const admin = await h.slash('candidatures');
    const before = JSON.stringify(svc.forms(h.guild.id));
    await explore(h, admin, { as: 'member', budget: 30 });
    assert.equal(JSON.stringify(svc.forms(h.guild.id)), before, 'un membre a modifié un formulaire');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('candidature : panneau, formulaire, carte du staff, accepter (double clic), refuser, entretien, retrait, délai', async () => {
  const h = await createHarness();
  h.configureAll();
  const repo = () => h.client.repositories.applications;
  try {
    const { id, view } = await createForm(h, { name: 'Recrutement', description: 'Nous recrutons !', questions: 'Quel âge avez-vous ?\n+ Pourquoi nous rejoindre ?', cooldown: '0' });
    const { panel } = await setupForm(h, id, view);

    // Le membre postule : carte dans le salon de réception, rôle pingué explicitement, réponses en embed.
    let mark = h.fake.messageLog.length;
    let calls = h.fake.calls.length;
    const sent = await apply(h, panel, 'member', { q0: '25 ans', q1: 'Je suis motivé @everyone <@&' + IDS.roles.admin + '>' });
    assert.match(h.replyText(sent), /Candidature envoyée/, h.replyText(sent));
    const card = botMessagesIn(h, C().staff, mark)[0];
    assert.ok(card, 'carte de candidature absente du salon de réception');
    assert.equal(card.content, `<@&${IDS.roles.mod}>`, 'les réponses ne doivent jamais être dans le contenu');
    const post = h.fake.calls.slice(calls).find((c) => c.method === 'POST' && c.route === `/channels/${C().staff}/messages`);
    assert.deepEqual(post.body.allowed_mentions, { parse: [], roles: [IDS.roles.mod] });
    assert.match(embedText(card), /Je suis motivé/);
    assert.match(embedText(card), /Quel âge avez-vous \?/);
    const app = repo().listPending(h.guild.id)[0];
    assert.equal(app.user_id, IDS.users.member);
    assert.deepEqual(buttonIds(card).slice(0, 3), [`cmd:candidatures:accept:${app.id}`, `cmd:candidatures:reject:${app.id}`, `cmd:candidatures:interview:${app.id}`]);

    // Une seule candidature en attente par membre et par formulaire.
    const again = await h.click(panel, `cmd:candidature:apply:${id}`, { as: 'member' });
    assert.ok(h.isError(again) && !again.modals.length, 'deuxième candidature en attente acceptée');
    assert.match(h.replyText(again), /déjà une candidature/);

    // Un membre sans permission ne peut pas accepter.
    const denied = await h.click(card, `cmd:candidatures:accept:${app.id}`, { as: 'member' });
    assert.ok(h.isError(denied));
    assert.equal(repo().getApplication(h.guild.id, app.id).status, 'pending');

    // Double clic sur « Accepter » (deux relecteurs) : une seule décision, un seul MP, rôle donné.
    mark = h.fake.messageLog.length;
    calls = h.fake.calls.length;
    const [a1, a2] = await Promise.all([h.click(card, `cmd:candidatures:accept:${app.id}`), h.click(card, `cmd:candidatures:accept:${app.id}`, { as: 'owner' })]);
    assert.equal([a1, a2].filter((r) => h.isError(r)).length, 1, 'les deux clics ont abouti (ou aucun)');
    const accepted = repo().getApplication(h.guild.id, app.id);
    assert.equal(accepted.status, 'accepted');
    assert.ok(h.fake.members.get(IDS.users.member).roles.includes(IDS.roles.notif), 'rôle non donné');
    const roleCalls = h.fake.calls.slice(calls).filter((c) => c.method === 'PUT' && c.route.endsWith(`/roles/${IDS.roles.notif}`));
    assert.equal(roleCalls.length, 1, `rôle donné ${roleCalls.length} fois`);
    const dms = dmsOf(h, 'member', mark);
    assert.equal(dms.length, 1, `MP envoyés : ${dms.length}`);
    assert.match(embedText(dms[0]), /Candidature acceptée/);
    const updated = h.message(card.id);
    assert.match(embedText(updated), /Acceptée/);
    assert.ok(!buttonIds(updated).some((b) => b.includes(':accept:')), 'bouton Accepter encore présent');

    // Refus d'une autre candidature : motif dans le MP et sur la carte.
    mark = h.fake.messageLog.length;
    await apply(h, panel, 'target', { q0: '17', q1: 'Pour aider' });
    const card2 = botMessagesIn(h, C().staff, mark)[0];
    const app2 = repo().listPending(h.guild.id)[0];
    const reject = await h.click(card2, `cmd:candidatures:reject:${app2.id}`);
    assert.equal(reject.modals.length, 1);
    const rejected = await h.submitModal(reject, { motif: 'Âge minimum : 18 ans.' });
    assert.ok(!h.isError(rejected), h.replyText(rejected));
    const r2 = repo().getApplication(h.guild.id, app2.id);
    assert.equal(r2.status, 'rejected');
    assert.equal(r2.reason, 'Âge minimum : 18 ans.');
    assert.match(embedText(dmsOf(h, 'target', mark)[0]), /Âge minimum/);
    assert.match(embedText(h.message(card2.id)), /Motif du refus/);
    // Une décision déjà prise ne peut pas être changée (ancienne carte).
    const late = await h.click(card2, `cmd:candidatures:accept:${app2.id}`);
    assert.ok(h.isError(late));
    assert.equal(repo().getApplication(h.guild.id, app2.id).status, 'rejected');

    // Entretien : tickets configurés → ticket créé pour le candidat.
    const user3 = h.addUser('Candidat');
    await h.memberJoin(user3);
    mark = h.fake.messageLog.length;
    await apply(h, panel, user3.id, { q0: '30', q1: 'Expérience' });
    const card3 = botMessagesIn(h, C().staff, mark)[0];
    const app3 = repo().listPending(h.guild.id).find((a) => a.user_id === user3.id);
    const channelsBefore = new Set(h.fake.channels.keys());
    const interview = await h.click(card3, `cmd:candidatures:interview:${app3.id}`);
    assert.match(h.replyText(interview), /Ticket d'entretien ouvert/, h.replyText(interview));
    const ticketId = [...h.fake.channels.keys()].find((k) => !channelsBefore.has(k));
    assert.ok(h.client.repositories.tickets.getByChannel(ticketId), 'aucun ticket créé');
    assert.equal(repo().getApplication(h.guild.id, app3.id).interview_channel_id, ticketId);
    assert.ok(!buttonIds(h.message(card3.id)).some((b) => b.includes(':interview:')), 'bouton Entretien encore présent');
    const again3 = await h.click(card3, `cmd:candidatures:interview:${app3.id}`);
    assert.ok(h.isError(again3), 'second entretien ouvert');

    // Sans tickets configurés : fil privé dans le salon du panneau.
    h.configure({ tickets: { categoryId: null, supportRoleIds: [], supportRoleId: null } });
    const user4 = h.addUser('Postulant');
    await h.memberJoin(user4);
    mark = h.fake.messageLog.length;
    await apply(h, panel, user4.id, { q0: '22', q1: 'Pourquoi pas' });
    const card4 = botMessagesIn(h, C().staff, mark)[0];
    const app4 = repo().listPending(h.guild.id).find((a) => a.user_id === user4.id);
    calls = h.fake.calls.length;
    const thread = await h.click(card4, `cmd:candidatures:interview:${app4.id}`);
    assert.match(h.replyText(thread), /Fil privé d'entretien ouvert/, h.replyText(thread));
    const create = h.fake.calls.slice(calls).find((c) => c.method === 'POST' && c.route === `/channels/${C().general}/threads`);
    assert.equal(create?.body?.type, 12, 'fil non privé');
    const members = h.fake.calls.slice(calls).filter((c) => c.method === 'PUT' && /thread-members/.test(c.route)).map((c) => c.route.split('/').pop());
    assert.ok(members.includes(user4.id) && members.includes(IDS.users.admin), `membres du fil : ${members}`);

    // Retrait par le candidat (/candidature statut → bouton), carte mise à jour.
    const st = await h.slash('candidature', [{ name: 'statut', type: 1, options: [] }], { as: user4.id });
    assert.match(h.replyText(st), /Mes candidatures/);
    const withdraw = await h.click(h.messagesOf(st)[0], `cmd:candidature:withdraw:${app4.id}`, { as: user4.id });
    assert.match(h.replyText(withdraw), /retirée/);
    assert.equal(repo().getApplication(h.guild.id, app4.id).status, 'withdrawn');
    assert.match(embedText(h.message(card4.id)), /Retirée/);
    // Retirer la candidature d'un autre : refusé.
    const other = await h.slash('candidature', [{ name: 'retirer', type: 1, options: [opt('candidature', 4, app3.id)] }], { as: 'member' });
    assert.ok(h.isError(other));
    assert.equal(repo().getApplication(h.guild.id, app3.id).status, 'pending');
    const own = await h.slash('candidature', [{ name: 'retirer', type: 1, options: [opt('candidature', 4, app3.id)] }], { as: user3.id });
    assert.match(h.replyText(own), /retirée/);

    // Délai entre deux candidatures : le membre accepté doit patienter.
    h.client.services.applications.updateForm(h.guild.id, id, { cooldownMs: 3_600_000 });
    const cooldown = await h.click(panel, `cmd:candidature:apply:${id}`, { as: 'member' });
    assert.ok(h.isError(cooldown) && !cooldown.modals.length);
    assert.match(h.replyText(cooldown), /postulé récemment/);

    // Formulaire fermé : refus clair.
    h.client.services.applications.updateForm(h.guild.id, id, { open: false, cooldownMs: 0 });
    const closed = await h.click(panel, `cmd:candidature:apply:${id}`, { as: user4.id });
    assert.match(h.replyText(closed), /fermées/);

    // Journal : décisions dans les logs de modération.
    const logs = botMessagesIn(h, C().logs).map(embedText).join('\n');
    assert.match(logs, /Candidature acceptée · #/);
    assert.match(logs, /Candidature refusée · #/);
    assert.match(logs, /Entretien ouvert · #/);
    assert.match(logs, /Candidature retirée · #/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
