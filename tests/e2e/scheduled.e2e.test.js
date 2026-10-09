'use strict';

/**
 * Bout en bout : fonctionnalités planifiées (rôles temporaires, annonces programmées,
 * anniversaires) sur le vrai discord.js — commandes, chaque bouton / formulaire,
 * refus sans permission, événement réel (retour d'un membre) et échéances traitées
 * par le vrai SchedulerService.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { localParts } = require('../../src/utils/calendar');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const findButton = (m, prefix) => buttonsOf(m).find((c) => c.custom_id?.startsWith(prefix));
const hasRole = (h, userId, roleId) => h.fake.members.get(userId)?.roles.includes(roleId);
const logTitles = (h, mark) => botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs).map((m) => m.embeds?.[0]?.title ?? '');

async function setup() {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 2;
  return h;
}

test('rôles temporaires : attribution, liste, prolongation, retrait, retour du membre, échéance', async () => {
  const h = await setup();
  const repo = h.client.repositories.tempRoles;
  try {
    // Refus : sans permission, rôle sensible, durée invalide.
    const denied = await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '1h')]), { as: 'member' });
    assert.ok(h.isError(denied), 'un membre sans « Gérer les rôles » a attribué un rôle');
    const sensitive = await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.mod), opt('duree', 3, '1h')]));
    assert.ok(h.isError(sensitive) && /modération/.test(h.replyText(sensitive)), h.replyText(sensitive));
    const tooLong = await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '2w400d')]));
    assert.ok(h.isError(tooLong));
    assert.equal(repo.count(h.guild.id), 0);

    let mark = h.fake.messageLog.length;
    const grant = await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '2h'), opt('raison', 3, 'Animation du week-end')]));
    assert.ok(!h.isError(grant), h.replyText(grant));
    assert.ok(hasRole(h, IDS.users.target, IDS.roles.gamer), 'rôle non ajouté');
    const [row] = repo.activeByMember(h.guild.id, IDS.users.target);
    assert.ok(row && row.expires_at > Date.now() + 3_500_000);
    assert.ok(logTitles(h, mark).some((t) => /attribué/.test(t)), 'attribution non journalisée');

    // Carte : « Prolonger » (formulaire) puis liste éphémère.
    const card = h.message(grant.original);
    const extend = await h.click(card, findButton(card, 'cmd:role:textend:').custom_id);
    assert.equal(extend.modals.length, 1);
    await h.submitModal(extend, { duree: '1d' });
    assert.ok(repo.get(h.guild.id, row.id).expires_at >= row.expires_at + 86_400_000 - 1000, 'prolongation non enregistrée');

    const list = await h.slash('role', sub('temporaires', [opt('membre', 6, IDS.users.target)]));
    assert.match(h.replyText(list), new RegExp(`#${row.id}`));
    const listMsg = h.message(list.original);
    const refused = await h.click(listMsg, findButton(listMsg, 'cmd:role:tremove:').custom_id, { as: 'member' });
    assert.ok(h.isError(refused) || refused.ackType != null);
    assert.ok(hasRole(h, IDS.users.target, IDS.roles.gamer), 'un membre a retiré le rôle temporaire');

    // Départ puis retour avant l'échéance : le rôle est rendu (nouveau fichier d'événement).
    mark = h.fake.messageLog.length;
    await h.memberLeave(IDS.users.target);
    await h.memberJoin(h.users.target);
    assert.ok(hasRole(h, IDS.users.target, IDS.roles.gamer), 'rôle temporaire non réappliqué au retour');
    assert.ok(logTitles(h, mark).some((t) => /réappliqués/.test(t)));

    // Échéance traitée par le vrai scheduler.
    mark = h.fake.messageLog.length;
    h.client.database.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, row.id);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.ok(!hasRole(h, IDS.users.target, IDS.roles.gamer), 'rôle non retiré à l\'échéance');
    assert.equal(repo.get(h.guild.id, row.id).end_reason, 'expired');
    assert.ok(logTitles(h, mark).some((t) => /expiré/.test(t)));

    // « Retirer maintenant » depuis la liste ; membre parti à l'échéance → ligne close.
    await h.slash('role', sub('temporaire', [opt('membre', 6, IDS.users.member), opt('role', 8, IDS.roles.notif), opt('duree', 3, '3h')]));
    const all = await h.slash('role', sub('temporaires'));
    const allMsg = h.message(all.original);
    await h.click(allMsg, findButton(allMsg, 'cmd:role:tremove:').custom_id);
    assert.ok(!hasRole(h, IDS.users.member, IDS.roles.notif), '« Retirer maintenant » sans effet');
    const visitor = h.addUser('Visiteur');
    await h.memberJoin(visitor);
    await h.slash('role', sub('temporaire', [opt('membre', 6, visitor.id), opt('role', 8, IDS.roles.notif), opt('duree', 3, '1h')]));
    await h.memberLeave(visitor.id);
    const visitorRow = repo.activeByMember(h.guild.id, visitor.id)[0];
    h.client.database.db.prepare('UPDATE temp_roles SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, visitorRow.id);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.equal(repo.get(h.guild.id, visitorRow.id).end_reason, 'left');

    // Pagination (4 par page) puis exploration automatique des composants de la liste.
    h.configure({ antiraid: { enabled: false } }); // six arrivées d'affilée : pas une vague de raid
    for (let i = 0; i < 6; i += 1) {
      const u = h.addUser(`Temp${i}`);
      await h.memberJoin(u);
      await h.slash('role', sub('temporaire', [opt('membre', 6, u.id), opt('role', 8, IDS.roles.gamer), opt('duree', 3, `${i + 1}d`)]));
    }
    const paged = await h.slash('role', sub('temporaires'));
    const page1 = h.message(paged.original);
    assert.ok(page1.components.length <= 5);
    const next = buttonsOf(page1).find((c) => c.custom_id === 'cmd:role:tlist:all:1');
    assert.ok(next && !next.disabled, 'pas de page suivante');
    const page2 = await h.click(page1, next.custom_id);
    assert.match(h.replyText(page2), /Rôles temporaires/);
    await explore(h, await h.slash('role', sub('temporaires')), { budget: 30 });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('annonces programmées : formulaire, aperçu, programmation, liste, envoi, échéance, salon supprimé', async () => {
  const h = await setup();
  const repo = h.client.repositories.announcements;
  try {
    const denied = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h')]), { as: 'member' });
    assert.ok(h.isError(denied) && !denied.modals?.length, 'un membre sans « Gérer le serveur » a programmé une annonce');
    const past = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '01/01/2020 10h')]));
    assert.ok(h.isError(past));

    // Formulaire → aperçu → « Annuler ».
    const cancelled = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+1h')]));
    const preview0 = await h.submitModal(cancelled, { titre: 'À annuler', message: 'Rien', couleur: '', image: '' });
    const p0 = h.message(preview0.original);
    await h.click(p0, findButton(p0, 'cmd:annonce:cancel:').custom_id);
    assert.equal(repo.count(h.guild.id), 0);

    // Formulaire → aperçu → « Programmer ».
    const rec = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h'), opt('repetition', 3, 'daily'), opt('role', 8, IDS.roles.notif)]));
    assert.equal(rec.modals.length, 1, 'formulaire non ouvert');
    const badColor = await h.submitModal(rec, { titre: 'Soirée', message: 'Venez', couleur: 'rouge', image: '' });
    assert.ok(h.isError(badColor));
    const rec2 = await h.slash('annonce', sub('programmer', [opt('salon', 7, IDS.channels.general), opt('date', 3, '+2h'), opt('repetition', 3, 'daily'), opt('role', 8, IDS.roles.notif)]));
    const preview = await h.submitModal(rec2, { titre: 'Soirée jeux', message: 'Rendez-vous à 21 h dans le vocal !', couleur: '#ff8800', image: 'https://example.com/banniere.png' });
    const pm = h.message(preview.original);
    assert.ok(pm.flags & 64, 'aperçu non éphémère');
    assert.equal(pm.embeds.length, 2);
    await h.click(pm, findButton(pm, 'cmd:annonce:confirm:').custom_id);
    const [row] = repo.list(h.guild.id);
    assert.equal(row.status, 'scheduled');
    assert.equal(row.repeat, 'daily');

    // Liste → « Envoyer maintenant » : mention de rôle avec allowedMentions explicite.
    const list = await h.slash('annonce', sub('liste'));
    const lm = h.message(list.original);
    let mark = h.fake.messageLog.length;
    await h.click(lm, findButton(lm, 'cmd:annonce:asend:').custom_id);
    const sent = botMessages(h, mark, (m) => m.channel_id === IDS.channels.general);
    assert.equal(sent.length, 1, 'annonce non publiée');
    assert.equal(sent[0].content, `<@&${IDS.roles.notif}>`);
    const call = h.fake.calls.filter((c) => c.route === `/channels/${IDS.channels.general}/messages` && c.method === 'POST').at(-1);
    assert.deepEqual(call.body.allowed_mentions, { parse: [], roles: [IDS.roles.notif] });
    assert.equal(repo.get(h.guild.id, row.id).next_run, row.next_run, '« Envoyer maintenant » a décalé l\'échéance');

    // Échéance par le scheduler : publiée et reprogrammée le lendemain.
    h.client.database.db.prepare('UPDATE scheduled_announcements SET next_run = ?, anchor_at = ? WHERE id = ?').run(Date.now() - 1000, Date.now() - 1000, row.id);
    mark = h.fake.messageLog.length;
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.equal(botMessages(h, mark, (m) => m.channel_id === IDS.channels.general).length, 1);
    const after = repo.get(h.guild.id, row.id);
    assert.equal(after.status, 'scheduled');
    assert.ok(after.next_run > Date.now() + 23 * 3_600_000);

    // Salon supprimé → annonce désactivée, avertissement et log.
    h.client.database.db.prepare('UPDATE scheduled_announcements SET next_run = ?, channel_id = ? WHERE id = ?').run(Date.now() - 1000, '999999999999999999', row.id);
    mark = h.fake.messageLog.length;
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.equal(repo.get(h.guild.id, row.id).status, 'disabled');
    assert.ok(h.warnLogs().some((l) => /désactivée/.test(l)), 'pas d\'avertissement');
    assert.ok(logTitles(h, mark).some((t) => /désactivée/.test(t)));

    // Liste : « Supprimer », puis exploration automatique.
    const list2 = await h.slash('annonce', sub('liste'));
    const l2 = h.message(list2.original);
    await h.click(l2, findButton(l2, 'cmd:annonce:adelete:').custom_id);
    assert.equal(repo.count(h.guild.id), 0);
    await explore(h, await h.slash('annonce', sub('liste')), { budget: 10 });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('anniversaires : configuration, définition, message du jour unique, rôle 24 h, liste, refus', async () => {
  const h = await setup();
  const repo = h.client.repositories.birthdays;
  try {
    const denied = await h.slash('anniversaire', sub('config'), { as: 'member' });
    assert.ok(h.isError(denied), 'un membre a ouvert la configuration');

    const dash = await h.slash('anniversaire', sub('config'));
    let msg = h.message(dash.original);
    await h.click(msg, 'cmd:anniversaire:ctoggle:on');
    await h.click(h.message(dash.original), 'cmd:anniversaire:cchannel', { values: [IDS.channels.general] });
    const badRole = await h.click(h.message(dash.original), 'cmd:anniversaire:crole', { values: [IDS.roles.mod] });
    assert.ok(h.isError(badRole), 'rôle sensible accepté');
    await h.click(h.message(dash.original), 'cmd:anniversaire:crole', { values: [IDS.roles.notif] });
    const time = await h.click(h.message(dash.original), 'cmd:anniversaire:ctime');
    const badTz = await h.submitModal(time, { fuseau: 'Lune/Base', heure: '0' });
    assert.ok(h.isError(badTz));
    const time2 = await h.click(h.message(dash.original), 'cmd:anniversaire:ctime');
    await h.submitModal(time2, { fuseau: 'europe/paris', heure: '0' });
    const message = await h.click(h.message(dash.original), 'cmd:anniversaire:cmessage');
    await h.submitModal(message, { message: 'Bon anniversaire {membre} !\nTu as {age} ans.' });
    const cfg = h.client.services.config.get(h.guild.id).birthdays;
    assert.deepEqual([cfg.enabled, cfg.channelId, cfg.roleId, cfg.timeZone, cfg.hour], [true, IDS.channels.general, IDS.roles.notif, 'Europe/Paris', 0]);
    await explore(h, dash, { budget: 25 });
    h.configure({ birthdays: { enabled: true, channelId: IDS.channels.general, roleId: IDS.roles.notif, hour: 0, message: 'Bon anniversaire {membre} !\nTu as {age} ans.' } });

    const today = localParts(Date.now(), 'Europe/Paris');
    const day = today.month === 2 && today.day === 29 ? 28 : today.day;
    const invalid = await h.slash('anniversaire', sub('definir', [opt('jour', 4, 31), opt('mois', 4, 2)]), { as: 'member' });
    assert.ok(h.isError(invalid));
    const set = await h.slash('anniversaire', sub('definir', [opt('jour', 4, day), opt('mois', 4, today.month), opt('annee', 4, 2000)]), { as: 'member' });
    assert.ok(!h.isError(set), h.replyText(set));
    await h.slash('anniversaire', sub('definir', [opt('jour', 4, day), opt('mois', 4, today.month), opt('annee', 4, 1990), opt('afficher_age', 5, true)]), { as: 'mod' });
    const leaver = h.addUser('Partant');
    await h.memberJoin(leaver);
    await h.slash('anniversaire', sub('definir', [opt('jour', 4, day), opt('mois', 4, today.month)]), { as: leaver.id });
    await h.memberLeave(leaver.id);

    let mark = h.fake.messageLog.length;
    await h.client.services.scheduler.tick();
    await h.settle();
    const wishes = botMessages(h, mark, (m) => m.channel_id === IDS.channels.general);
    assert.equal(wishes.length, 2, `messages : ${wishes.map((m) => m.content).join(', ')}`);
    const forMember = wishes.find((m) => m.content === `<@${IDS.users.member}>`);
    const forMod = wishes.find((m) => m.content === `<@${IDS.users.mod}>`);
    assert.ok(forMember && forMod, 'membres présents non fêtés');
    assert.ok(!/ans\./.test(forMember.embeds[0].description), 'âge affiché sans accord');
    assert.match(forMod.embeds[0].description, new RegExp(`${today.year - 1990} ans`));
    assert.ok(!wishes.some((m) => m.content?.includes(leaver.id)), 'membre parti fêté');
    assert.ok(hasRole(h, IDS.users.member, IDS.roles.notif), 'rôle d\'anniversaire non donné');

    mark = h.fake.messageLog.length;
    h.client.services.birthdays.invalidate(h.guild.id);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.equal(botMessages(h, mark, (m) => m.channel_id === IDS.channels.general).length, 0, 'second message le même jour');

    h.client.database.db.prepare('UPDATE birthdays SET role_until = ? WHERE user_id = ?').run(Date.now() - 1000, IDS.users.member);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.ok(!hasRole(h, IDS.users.member, IDS.roles.notif), 'rôle non retiré après 24 h');

    const list = await h.slash('anniversaire', sub('liste'), { as: 'target' });
    const text = h.replyText(list);
    assert.ok(text.includes(IDS.users.member) && !text.includes(leaver.id), text);
    const removed = await h.slash('anniversaire', sub('retirer'), { as: 'member' });
    assert.ok(!h.isError(removed));
    assert.equal(repo.get(h.guild.id, IDS.users.member), null);
    assert.ok(h.isError(await h.slash('anniversaire', sub('retirer'), { as: 'member' })));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
