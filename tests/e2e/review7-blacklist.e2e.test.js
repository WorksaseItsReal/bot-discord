'use strict';

/**
 * Revue n° 7, lot fx7-blacklist (bout en bout : vrai discord.js, faux Discord) :
 *  - S35 : le blrank ne retire plus (ni ne bloque) un rôle RESTRICTIF — rôle Muted, rôle « non
 *    vérifié » de la vérification en mode retrait — : /mute, mute réappliqué au retour, verrou ;
 *  - S36 : le menu de rôles refuse l'ajout à un membre du blrank ; le plafond « boucle » (3 retraits
 *    par 10 min) ne vaut plus que pour un AUTRE bot (ou un auteur inconnu) ;
 *  - S37 : un membre hors cache (ancien membre partiel) qui gagne un rôle le perd quand même.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');

const blr = (sub, options = []) => [{ name: 'blrank', type: 2, options: [{ name: sub, type: 1, options }] }];
const opt = (name, type, value) => ({ name, type, value });
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const logged = (h, mark, re) => botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && titled(re)(m));
const calls = (h, mark, method, re) => h.fake.calls.slice(mark).filter((c) => c.method === method && re.test(c.route));
const rolesOf = (h, userId) => h.fake.members.get(userId)?.roles ?? [];
const mutedId = (h) => h.client.services.moderation.mutedRole(h.guild)?.id;
const fieldsText = (h, rec) => h.messagesOf(rec).flatMap((m) => (m.embeds ?? []).flatMap((e) => (e.fields ?? []).map((f) => `${f.name}\n${f.value}`))).join('\n');

async function blrankAdd(h, userId) {
  const add = await h.slash('secur', blr('ajouter', [opt('membre', 6, userId), opt('raison', 3, 'abus de rôles')]), { as: 'owner' });
  assert.ok(!h.isError(add), h.replyText(add));
  assert.ok(h.client.services.blacklist.isRankBlocked(h.guild.id, userId));
}

/* ------------------------------------------------------------------ */
/* S35 — rôles restrictifs                                              */
/* ------------------------------------------------------------------ */

test('S35 A : /mute d\'un membre du blrank — rôle Muted gardé, sanction active en base, aucun log « Rôle retiré (blrank) »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    await blrankAdd(h, IDS.users.target);
    const mark = h.fake.messageLog.length;
    const mute = await h.slash('mute', [opt('membre', 6, IDS.users.target), opt('duree', 3, '1d')], { as: 'mod' });
    await h.settle();
    assert.ok(!h.isError(mute), h.replyText(mute));
    assert.ok(rolesOf(h, IDS.users.target).includes(mutedId(h)), 'rôle Muted retiré par le blrank');
    assert.ok(h.client.repositories.sanctions.activeMute(h.guild.id, IDS.users.target), 'sanction mute close en base');
    assert.equal(logged(h, mark, /Rôle retiré \(blrank\)/).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S35 B : mute posé avant le blrank — au retour du membre, le rôle Muted est remis et reste ; le mute reste actif', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const u = h.addUser('Recidiviste', { ageDays: 400 });
    await h.memberJoin(u);
    const mute = await h.slash('mute', [opt('membre', 6, u.id)], { as: 'mod' });
    assert.ok(!h.isError(mute), h.replyText(mute));
    await blrankAdd(h, u.id);
    await h.memberLeave(u.id);
    await h.memberJoin(u);
    await h.settle();
    assert.ok(rolesOf(h, u.id).includes(mutedId(h)), 'Muted remis puis retiré par le blrank');
    assert.ok(h.client.repositories.sanctions.activeMute(h.guild.id, u.id), 'mute permanent clos en base');
    // Les rôles d'arrivée (privilèges) restent bloqués.
    assert.equal(rolesOf(h, u.id).includes(IDS.roles.member), false, 'rôle d\'arrivée donné à un membre du blrank');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S35 C : vérification en mode « retrait » — un arrivant du blrank est verrouillé ; le verrou posé à la main reste', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ welcome: { verification: { enabled: true, roleId: IDS.roles.temp, mode: 'remove' } } });
    const newcomer = h.addUser('Nouveau', { ageDays: 400 });
    h.client.repositories.securityBlacklist.add({ guildId: h.guild.id, userId: newcomer.id, kind: 'rank', authorId: IDS.users.owner, createdAt: Date.now() });
    await h.memberJoin(newcomer);
    await h.settle();
    assert.ok(rolesOf(h, newcomer.id).includes(IDS.roles.temp), 'arrivant du blrank non verrouillé (accès complet)');
    const m = await h.guild.members.fetch(newcomer.id);
    assert.doesNotThrow(() => h.client.services.welcome.assertCanVerify(m), 'considéré comme déjà vérifié');

    // Verrou retiré puis reposé à la main par un humain : le blrank ne l'enlève pas.
    await h.asHuman('owner').removeRole(newcomer.id, IDS.roles.temp);
    await h.asHuman('owner').addRole(newcomer.id, IDS.roles.temp);
    await h.settle();
    assert.ok(rolesOf(h, newcomer.id).includes(IDS.roles.temp), 'verrou manuel retiré par le blrank');

    // Un rôle ordinaire reste refusé.
    await h.asHuman('owner').addRole(newcomer.id, IDS.roles.notif);
    await h.settle();
    assert.equal(rolesOf(h, newcomer.id).includes(IDS.roles.notif), false, 'rôle ordinaire laissé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* S36 — menu de rôles, plafond « boucle »                              */
/* ------------------------------------------------------------------ */

async function publishMenu(h) {
  const roles = [];
  for (const n of ['Lecteurs', 'Joueurs', 'Annonces', 'Musique']) roles.push((await h.guild.roles.create({ name: n, permissions: [] })).id);
  await h.settle();
  const mark = h.fake.messageLog.length;
  const pub = await h.slash('rolemenu', [opt('titre', 3, 'Rôles'), ...roles.map((r, i) => opt(`role${i + 1}`, 8, r))], { as: 'admin' });
  assert.ok(!h.isError(pub), h.replyText(pub));
  const [menu] = botMessages(h, mark, (m) => (m.components ?? []).some((r) => r.components?.some((c) => c.custom_id?.startsWith('rolemenu:'))));
  assert.ok(menu, 'menu non publié');
  return { roles, menu, menuId: menu.components[0].components[0].custom_id };
}

test('S36 A : menu de rôles — un membre du blrank ne reçoit AUCUN des 4 rôles (refus explicite, aucun PUT) ; il peut encore en abandonner un', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const { roles, menu, menuId } = await publishMenu(h);
    // Un rôle du menu déjà porté AVANT l'entrée au blrank.
    const first = await h.click(menu, menuId, { as: 'target', values: [roles[0]] });
    assert.ok(!h.isError(first), h.replyText(first));
    assert.ok(rolesOf(h, IDS.users.target).includes(roles[0]));
    await blrankAdd(h, IDS.users.target);

    const cm = h.fake.calls.length;
    const rec = await h.click(menu, menuId, { as: 'target', values: roles.slice(1) });
    await h.settle();
    assert.equal(calls(h, cm, 'PUT', new RegExp(`/members/${IDS.users.target}/roles/`)).length, 0, 'ajout envoyé à Discord');
    assert.equal(roles.slice(1).filter((r) => rolesOf(h, IDS.users.target).includes(r)).length, 0, 'rôle du menu gardé par un membre du blrank');
    assert.match(h.replyText(rec), /Aucun rôle modifié/);
    assert.match(fieldsText(h, rec), /Refusés[\s\S]*ne pouvez pas recevoir de nouveau rôle/);

    // Abandon d'un rôle : toujours possible.
    const drop = await h.click(menu, menuId, { as: 'target', values: [roles[0]] });
    assert.ok(!h.isError(drop), h.replyText(drop));
    assert.equal(rolesOf(h, IDS.users.target).includes(roles[0]), false, 'abandon refusé');
    assert.match(fieldsText(h, drop), /Retirés/);

    // Clics répétés : le rôle ne reste jamais.
    for (let i = 0; i < 4; i += 1) await h.click(menu, menuId, { as: 'target', values: [roles[1]] });
    await h.settle();
    assert.equal(rolesOf(h, IDS.users.target).includes(roles[1]), false, 'rôle gardé après 4 clics');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S36 B : un humain qui insiste (5 ajouts en 10 min) voit chaque rôle retiré, sans carte « boucle »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    await blrankAdd(h, IDS.users.member);
    const mark = h.fake.messageLog.length;
    for (let i = 0; i < 5; i += 1) {
      await h.asHuman('admin').addRole('member', IDS.roles.notif);
      await h.settle();
      assert.equal(rolesOf(h, IDS.users.member).includes(IDS.roles.notif), false, `rôle laissé au ${i + 1}ᵉ ajout`);
    }
    assert.equal(logged(h, mark, /Rôle retiré \(blrank\)/).length, 5);
    assert.equal(logged(h, mark, /Boucle d'attribution/).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S36 C : rôle ajouté par le bot lui-même hors applyRoles (/role add) — retiré à chaque fois, sans plafond', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    await blrankAdd(h, IDS.users.member);
    const mark = h.fake.messageLog.length;
    for (let i = 0; i < 4; i += 1) {
      await h.slash('role', [{ name: 'add', type: 1, options: [opt('membre', 6, IDS.users.member), opt('role', 8, IDS.roles.notif)] }], { as: 'admin' });
      await h.settle();
      assert.equal(rolesOf(h, IDS.users.member).includes(IDS.roles.notif), false, `rôle laissé au ${i + 1}ᵉ ajout`);
    }
    assert.equal(logged(h, mark, /Boucle d'attribution/).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S36 D : un AUTRE bot qui rend le rôle en boucle — 3 retraits puis carte « boucle » (plafond conservé)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    await blrankAdd(h, IDS.users.member);
    // L'autre bot reçoit le droit de gérer les rôles (rôle Admin donné par le propriétaire).
    await h.asHuman('owner').addRole('otherBot', IDS.roles.admin);
    await h.settle();
    const mark = h.fake.messageLog.length;
    for (let i = 0; i < 3; i += 1) {
      await h.asHuman('otherBot').addRole('member', IDS.roles.notif);
      await h.settle();
      assert.equal(rolesOf(h, IDS.users.member).includes(IDS.roles.notif), false, `rôle laissé au ${i + 1}ᵉ ajout`);
    }
    const cm = h.fake.calls.length;
    await h.asHuman('otherBot').addRole('member', IDS.roles.notif);
    await h.settle();
    assert.ok(rolesOf(h, IDS.users.member).includes(IDS.roles.notif), 'plafond « boucle » non appliqué à un autre bot');
    assert.equal(calls(h, cm, 'DELETE', new RegExp(`/members/${IDS.users.member}/roles/`)).length, 0);
    assert.equal(logged(h, mark, /Boucle d'attribution/).length, 1);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* S37 — membre hors cache                                              */
/* ------------------------------------------------------------------ */

test('S37 : membre du blrank hors cache (ancien membre partiel) — le rôle ajouté par un humain est retiré, avec log et auteur', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    await blrankAdd(h, IDS.users.member);
    // Redémarrage simulé : membre absent du cache (serveur au-delà du large_threshold).
    h.guild.members.cache.delete(IDS.users.member);
    const mark = h.fake.messageLog.length;
    await h.asHuman('admin').addRole('member', IDS.roles.notif);
    await h.settle();
    assert.equal(rolesOf(h, IDS.users.member).includes(IDS.roles.notif), false, 'rôle laissé à un membre hors cache');
    assert.ok(rolesOf(h, IDS.users.member).includes(IDS.roles.gamer), 'rôle déjà porté retiré');
    const [log] = logged(h, mark, /Rôle retiré \(blrank\)/);
    assert.ok(log, 'log blrank absent');
    assert.match(log.embeds[0].fields.find((f) => /Rôle donné par/.test(f.name)).value, new RegExp(IDS.users.admin));

    // Mise à jour suivante (membre en cache) : comportement inchangé.
    await h.asHuman('admin').addRole('member', IDS.roles.temp);
    await h.settle();
    assert.equal(rolesOf(h, IDS.users.member).includes(IDS.roles.temp), false);

    // Hors cache, mise à jour SANS rôle ajouté récemment (renommage) : rien n'est retiré.
    h.guild.members.cache.delete(IDS.users.member);
    const cm = h.fake.calls.length;
    await h.asHuman('admin').perform('PATCH', `/guilds/${h.guild.id}/members/${IDS.users.member}`, { nick: 'renomme' });
    await h.settle();
    assert.ok(rolesOf(h, IDS.users.member).includes(IDS.roles.gamer));
    assert.ok(rolesOf(h, IDS.users.member).includes(IDS.roles.member));
    assert.equal(calls(h, cm, 'DELETE', new RegExp(`/members/${IDS.users.member}/roles/`)).length, 0, 'rôle déjà porté retiré');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
