'use strict';

/**
 * ADM1 — Niveaux de permissions (/permissions), bout en bout sur le vrai discord.js.
 * Règle non négociable : un niveau ne permet JAMAIS d'utiliser une commande qui protège une
 * action sensible sans la permission Discord qu'elle déclare (contrôle de 0.6.0 conservé) ; les
 * niveaux RESTREIGNENT (mode strict) ou DÉLÈGUENT le seul palier « courant ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore, newStats, missingNavViews } = require('./lib/explore');
const { nextId } = require('./lib/ids');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const perm = (h, name, options, as = 'owner') => h.slash('permissions', sub(name, options), { as });
const level = (h, n, action, roleId, as = 'owner') => perm(h, 'niveau', [opt('numero', 4, n), opt('action', 3, action), opt('role', 8, roleId)], as);
const assign = (h, name, n, as = 'owner') => perm(h, 'commande', [opt('nom', 3, name), opt('niveau', 4, n)], as);
const banCalls = (h, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'PUT' && /^\/guilds\/\d+\/bans\/\d+$/.test(c.route));
const logs = (h, mark, re) => h.fake.messageLog.slice(mark).map((id) => h.message(id))
  .filter((m) => m && m.channel_id === IDS.channels.logs && m.author?.id === h.client.user.id && (m.embeds ?? []).some((e) => re.test(e.title ?? '')));
const button = (message, prefix) => (message?.components ?? []).flatMap((r) => r.components ?? []).find((c) => c.custom_id?.startsWith(prefix));
const ok = (h, rec, label) => assert.ok(!h.isError(rec), `${label} : ${h.replyText(rec)}`);
const denied = (h, rec, re, label) => {
  assert.ok(h.isError(rec), `${label} aurait dû être refusé : ${h.replyText(rec)}`);
  if (re) assert.match(h.replyText(rec), re, label);
};

async function fresh(h, name) {
  const user = h.addUser(name, { ageDays: 300 });
  await h.memberJoin(user, { label: `préparation : ${name}` });
  return user.id;
}

/** Message du panneau (réponse éphémère d'une interaction). */
const panel = (h, rec) => h.messagesOf(rec)[0];

test('RÈGLE NON NÉGOCIABLE : un membre de niveau 3 sans « Bannir des membres » ne peut toujours pas bannir (attribution, mode strict, owner de sécurité, bouton)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false } });
    // Carte de bannissement d'un modérateur (bouton « Débannir ») AVANT toute configuration.
    const banned = await fresh(h, 'Banni');
    const cardRec = await h.slash('ban', [opt('membre', 6, banned)], { as: 'mod' });
    ok(h, cardRec, '/ban du modérateur');
    const card = h.messagesOf(cardRec).find((m) => button(m, 'cmd:unban:revoke:'));
    assert.ok(card, 'carte de bannissement sans bouton « Débannir »');

    // Le propriétaire met « Joueur » (porté par le membre) au niveau 3 et y attribue les sanctions.
    ok(h, await level(h, 3, 'ajouter', IDS.roles.gamer), 'niveau 3 ← Joueur');
    for (const name of ['ban', 'tempban', 'softban', 'unban', 'kick', 'timeout', 'warn']) {
      const rec = await assign(h, name, 3);
      ok(h, rec, `commande ${name} 3`);
      assert.match(h.replyText(rec), /restriction|jamais/, `/${name} : présentée comme restriction`);
    }
    assert.equal(h.client.services.permissions.rankOf(h.member('member')), 3);

    for (const strict of [false, true]) {
      h.configure({ permissions: { strict } });
      const mark = h.fake.calls.length;
      denied(h, await h.slash('ban', [opt('membre', 6, IDS.users.target)], { as: 'member' }), /Bannir des membres/, `/ban (strict ${strict})`);
      denied(h, await h.slash('tempban', [opt('membre', 6, IDS.users.target), opt('duree', 3, '1d')], { as: 'member' }), /Bannir des membres/, '/tempban');
      denied(h, await h.slash('softban', [opt('membre', 6, IDS.users.target)], { as: 'member' }), /Bannir des membres/, '/softban');
      denied(h, await h.slash('kick', [opt('membre', 6, IDS.users.target)], { as: 'member' }), /Expulser/, '/kick');
      denied(h, await h.slash('timeout', [opt('membre', 6, IDS.users.target), opt('duree', 3, '10m')], { as: 'member' }), null, '/timeout');
      denied(h, await h.slash('warn', [opt('membre', 6, IDS.users.target)], { as: 'member' }), null, '/warn');
      denied(h, await h.click(card, button(card, 'cmd:unban:revoke:').custom_id, { as: 'member' }), /Bannir des membres/, 'bouton Débannir');
      assert.equal(banCalls(h, mark).length, 0, 'aucun bannissement');
      assert.equal(h.fake.calls.slice(mark).filter((c) => c.method === 'DELETE' && /\/bans\//.test(c.route)).length, 0, 'aucun débannissement');
      assert.ok(h.fake.members.has(IDS.users.target), 'cible toujours présente');
    }

    // Même owner de sécurité (rang 4), sans la permission native : refusé.
    h.configure({ secur: { owners: [IDS.users.member] } });
    assert.equal(h.client.services.permissions.rankOf(h.member('member')), 4);
    const mark = h.fake.calls.length;
    denied(h, await h.slash('ban', [opt('membre', 6, IDS.users.target)], { as: 'member' }), /Bannir des membres/, '/ban par un owner de sécurité sans la permission');
    assert.equal(banCalls(h, mark).length, 0);
    assert.ok(h.fake.bans.has(banned), 'le bannissement du modérateur est intact');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('attribution : le propriétaire fait « commande ban 2 » ; l\'administrateur est refusé sur ban et kick, accepté sur « clear 1 » ; un log par changement', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const mark = h.fake.messageLog.length;
    ok(h, await assign(h, 'ban', 2, 'owner'), 'propriétaire : commande ban 2');
    denied(h, await assign(h, 'ban', 3, 'admin'), /propriétaire du serveur/, 'admin : commande ban 3');
    denied(h, await assign(h, 'ban', 0, 'admin'), /propriétaire du serveur/, 'admin : retirer ban');
    denied(h, await assign(h, 'kick', 1, 'admin'), /owners de sécurité/, 'admin : commande kick 1');
    ok(h, await assign(h, 'clear', 1, 'admin'), 'admin : commande clear 1');
    ok(h, await assign(h, 'clear', 1, 'admin'), 'admin : commande clear 1 (sans changement)');
    denied(h, await perm(h, 'commande', [opt('nom', 3, 'Signaler le message'), opt('niveau', 4, 1)], 'admin'), /introuvable|ne peut pas/, 'menu contextuel');
    denied(h, await assign(h, 'permissions', 1, 'admin'), /ne peut pas être attribuée/, '/permissions elle-même');
    denied(h, await assign(h, 'clear', 1, 'member'), /Administrateur/, 'membre');
    assert.deepEqual(h.client.services.permissions.settings(h.guild.id).commands, { ban: 2, clear: 1 });
    const lines = logs(h, mark, /Permissions par niveaux modifiées/);
    assert.equal(lines.length, 2, `${lines.length} log(s) « permissions »`);
    assert.match(lines[0].embeds[0].description, /\/ban \(restriction\) : aucun → niveau 2/);
    assert.match(lines[1].embeds[0].description, /\/clear \(délégation\) : aucun → niveau 1/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('délégation du palier courant : /clear et /slowmode (bouton compris) par un niveau 2 sans la permission, log permissionUse ; salon invisible, /antiraid et commandes non déléguées refusés ; rang relu', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    ok(h, await level(h, 2, 'ajouter', IDS.roles.gamer, 'admin'), 'niveau 2 ← Joueur');
    ok(h, await assign(h, 'clear', 1, 'admin'), 'clear 1');
    ok(h, await assign(h, 'slowmode', 2, 'admin'), 'slowmode 2');
    const memberPerms = BigInt(h.permissionsIn(IDS.users.member, IDS.channels.general));
    assert.equal(memberPerms & (P.ManageMessages | P.ManageChannels), 0n, 'le membre n\'a ni Gérer les messages ni Gérer les salons');

    for (let i = 0; i < 3; i += 1) await h.userMessage({ as: 'target', channel: 'general', content: `message ${i}` });
    let mark = h.fake.messageLog.length;
    let calls = h.fake.calls.length;
    const clear = await h.slash('clear', [opt('nombre', 4, 2)], { as: 'member' });
    ok(h, clear, '/clear délégué');
    assert.ok(h.fake.calls.slice(calls).some((c) => (c.method === 'POST' && /bulk-delete$/.test(c.route)) || (c.method === 'DELETE' && /\/messages\/\d+$/.test(c.route))), 'messages non supprimés');
    const uses = logs(h, mark, /Commande exécutée par délégation/);
    assert.equal(uses.length, 1, 'log permissionUse');
    assert.match(uses[0].embeds[0].description, /\/clear/);
    assert.match(uses[0].embeds[0].description, /Gérer les messages/);

    calls = h.fake.calls.length;
    const slow = await h.slash('slowmode', [opt('duree', 3, '10s')], { as: 'member' });
    ok(h, slow, '/slowmode délégué');
    assert.ok(h.fake.calls.slice(calls).some((c) => c.method === 'PATCH' && c.route === `/channels/${IDS.channels.general}` && c.body?.rate_limit_per_user === 10));
    const slowCard = h.messagesOf(slow).find((m) => button(m, 'cmd:slowmode:set:'));
    calls = h.fake.calls.length;
    ok(h, await h.click(slowCard, button(slowCard, 'cmd:slowmode:set:').custom_id, { as: 'member' }), 'bouton « Désactiver » (délégation de /slowmode)');
    assert.ok(h.fake.calls.slice(calls).some((c) => c.method === 'PATCH' && c.body?.rate_limit_per_user === 0));
    // Salon que le membre ne voit pas : refusé malgré la délégation.
    denied(h, await h.slash('slowmode', [opt('duree', 3, '10s'), opt('salon', 7, IDS.channels.staff)], { as: 'member' }), /Gérer les salons/, '/slowmode salon invisible');
    // Hors délégation : refus natifs.
    denied(h, await h.slash('antiraid', [], { as: 'member' }), /Administrateur/, '/antiraid');
    denied(h, await h.slash('embed', sub('send', [opt('titre', 3, 'x')]), { as: 'member' }), /Gérer les messages/, '/embed non attribuée');
    denied(h, await h.slash('clear', [opt('nombre', 4, 1)], { as: 'target' }), /Gérer les messages/, '/clear sans niveau');
    // Le bouton « Désactiver » cliqué par un membre sans niveau : refusé.
    const slow2 = await h.slash('slowmode', [opt('duree', 3, '5s')], { as: 'member' });
    const card2 = h.messagesOf(slow2).find((m) => button(m, 'cmd:slowmode:set:'));
    denied(h, await h.click(card2, button(card2, 'cmd:slowmode:set:').custom_id, { as: 'target' }), /Gérer les salons/, 'bouton sans niveau');

    // Rôle retiré du niveau : la délégation disparaît aussitôt (rang relu à chaque appel).
    ok(h, await level(h, 2, 'retirer', IDS.roles.gamer, 'admin'), 'niveau 2 − Joueur');
    mark = h.fake.messageLog.length;
    denied(h, await h.slash('clear', [opt('nombre', 4, 1)], { as: 'member' }), /Gérer les messages/, '/clear après retrait');
    denied(h, await h.click(card2, button(card2, 'cmd:slowmode:set:').custom_id, { as: 'member' }), /Gérer les salons/, 'bouton après retrait');
    assert.equal(logs(h, mark, /Commande exécutée par délégation/).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('cibles protégées : un modérateur ne sanctionne pas un niveau 1 ; un administrateur ne bannit pas un owner de sécurité, le propriétaire si', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false } });
    ok(h, await level(h, 1, 'ajouter', IDS.roles.gamer, 'admin'), 'niveau 1 ← Joueur');
    let mark = h.fake.calls.length;
    denied(h, await h.slash('warn', [opt('membre', 6, IDS.users.member)], { as: 'mod' }), /niveau de permissions \(1\) est supérieur au vôtre \(0\)/, '/warn d\'un niveau 1');
    denied(h, await h.slash('ban', [opt('membre', 6, IDS.users.member)], { as: 'mod' }), /niveau de permissions/, '/ban d\'un niveau 1');
    assert.equal(banCalls(h, mark).length, 0);
    ok(h, await h.slash('warn', [opt('membre', 6, IDS.users.member)], { as: 'admin' }), '/warn par un administrateur (rang 3)');

    h.configure({ secur: { owners: [IDS.users.target] } });
    mark = h.fake.calls.length;
    denied(h, await h.slash('ban', [opt('membre', 6, IDS.users.target)], { as: 'admin' }), /owner de sécurité/, '/ban d\'un owner par un administrateur');
    assert.equal(banCalls(h, mark).length, 0);
    ok(h, await h.slash('ban', [opt('membre', 6, IDS.users.target)], { as: 'owner' }), '/ban d\'un owner par le propriétaire');
    assert.equal(banCalls(h, mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('mode strict : modérateur refusé (commande et bouton), administrateur accepté ; désactivé, comportement d\'avant', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false } });
    // Carte d'un ban fait avant le mode strict (bouton « Débannir »).
    const first = await fresh(h, 'Premier');
    const cardRec = await h.slash('ban', [opt('membre', 6, first)], { as: 'mod' });
    const card = h.messagesOf(cardRec).find((m) => button(m, 'cmd:unban:revoke:'));
    ok(h, await assign(h, 'ban', 2, 'owner'), 'ban 2');
    ok(h, await assign(h, 'unban', 2, 'owner'), 'unban 2');
    // Activation depuis le panneau.
    const home = await perm(h, 'panneau', [], 'owner');
    const view = await h.click(panel(h, home), 'cmd:permissions:nav', { as: 'owner', values: ['strict'] });
    const strictMsg = h.message(view.componentMessageId ?? panel(h, home).id);
    ok(h, await h.click(strictMsg, 'cmd:permissions:strict:on', { as: 'owner' }), 'mode strict activé');
    assert.equal(h.client.services.permissions.settings(h.guild.id).strict, true);

    const second = await fresh(h, 'Second');
    let mark = h.fake.calls.length;
    denied(h, await h.slash('ban', [opt('membre', 6, second)], { as: 'mod' }), /réservée au \*\*niveau 2\*\*/, '/ban du modérateur en mode strict');
    denied(h, await h.click(card, button(card, 'cmd:unban:revoke:').custom_id, { as: 'mod' }), /niveau 2/, 'bouton Débannir en mode strict');
    assert.equal(banCalls(h, mark).length, 0);
    assert.ok(h.fake.bans.has(first));
    ok(h, await h.slash('ban', [opt('membre', 6, second)], { as: 'admin' }), '/ban de l\'administrateur en mode strict');
    assert.equal(banCalls(h, mark).length, 1);

    h.configure({ permissions: { strict: false } });
    const third = await fresh(h, 'Troisième');
    mark = h.fake.calls.length;
    ok(h, await h.slash('ban', [opt('membre', 6, third)], { as: 'mod' }), '/ban du modérateur sans mode strict');
    assert.equal(banCalls(h, mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('rôles protégés : /rolemenu et la boutique refusent un rôle de niveau et un rôle de whitelist ; un menu existant ne le donne plus ; /permissions niveau refuse un rôle de menu', async () => {
  const h = await createHarness();
  try {
    // Menu de rôles publié AVANT : « Joueur » y est proposé.
    const menuRec = await h.slash('rolemenu', [opt('titre', 3, 'Rôles'), opt('role1', 8, IDS.roles.notif), opt('role2', 8, IDS.roles.gamer)], { as: 'admin' });
    ok(h, menuRec, '/rolemenu initial');
    denied(h, await level(h, 1, 'ajouter', IDS.roles.gamer, 'admin'), /menu de rôles/, 'niveau ← rôle d\'un menu de rôles');
    // Configuration ancienne (forcée) : le menu ne donne plus le rôle de niveau.
    h.configure({ permissions: { levels: { l1: { roles: [IDS.roles.gamer] } } }, whitelist: { roles: [IDS.roles.temp] } });
    const menuMsg = [...h.fake.messages.values()].find((m) => (m.components ?? []).some((r) => r.components?.some((c) => c.custom_id?.startsWith('rolemenu:'))));
    const menuId = menuMsg.components[0].components[0].custom_id;
    const calls = h.fake.calls.length;
    await h.click(menuMsg, menuId, { as: 'target', values: [IDS.roles.gamer] });
    assert.equal(h.fake.calls.slice(calls).filter((c) => c.method === 'PUT' && c.route.endsWith(`/roles/${IDS.roles.gamer}`)).length, 0, 'rôle de niveau donné par un menu');
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.gamer));

    for (const roleId of [IDS.roles.gamer, IDS.roles.temp]) {
      denied(h, await h.slash('rolemenu', [opt('titre', 3, 'Nouveau'), opt('role1', 8, roleId)], { as: 'admin' }), /rôle de niveau|whitelist/, `/rolemenu ${roleId}`);
    }
    const eco = await h.slash('economie', [], { as: 'admin' });
    const shop = await h.click(panel(h, eco), 'cmd:economie:nav', { as: 'admin', values: ['shop'] });
    const shopMsg = h.message(shop.componentMessageId ?? panel(h, eco).id);
    for (const roleId of [IDS.roles.gamer, IDS.roles.temp]) {
      denied(h, await h.click(shopMsg, 'cmd:economie:itemrole', { as: 'admin', values: [roleId] }), /ne peut pas être vendu/, `boutique ${roleId}`);
    }
    assert.equal(h.client.repositories.economy.listItems(h.guild.id).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('panneau : exploration (propriétaire et administrateur), toutes les vues ; membre refusé sans modification ; double clic → une seule ligne de log', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    ok(h, await level(h, 1, 'ajouter', IDS.roles.gamer, 'owner'), 'niveau 1 ← Joueur');
    const stats = newStats();
    for (const as of ['owner', 'admin']) {
      const rec = await perm(h, 'panneau', [], as);
      ok(h, rec, `panneau (${as})`);
      assert.ok(panel(h, rec).flags & EPHEMERAL, 'panneau public');
      await explore(h, rec, { as, stats, budget: 150 });
    }
    const missing = missingNavViews(stats).filter((k) => k.startsWith('cmd:permissions:'));
    assert.deepEqual(missing, [], `vues jamais ouvertes : ${missing.join(', ')}`);
    assert.ok(stats.modals >= 1, 'formulaire de nom jamais soumis');
    for (const key of ['cmd:permissions:roles', 'cmd:permissions:pick', 'cmd:permissions:set', 'cmd:permissions:strict', 'cmd:permissions:rename', 'cmd:permissions:recheck']) {
      assert.ok([...stats.keys].some((k) => k.startsWith(key)), `${key} jamais exploré`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());

    // Membre : chaque composant du panneau d'un administrateur est refusé, rien ne change.
    const adminRec = await perm(h, 'panneau', [], 'admin');
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).permissions);
    await explore(h, adminRec, { as: 'member', budget: 40 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).permissions), before, 'un membre a modifié les niveaux');
    assert.ok(h.sent.slice(-5).every((r) => h.isError(r) || r.modals?.length), 'composant accepté pour un membre');

    // Double clic (même message, deux clics simultanés) : un seul changement, un seul log.
    h.configure({ permissions: { strict: false } });
    const home = await perm(h, 'panneau', [], 'admin');
    const nav = await h.click(panel(h, home), 'cmd:permissions:nav', { as: 'admin', values: ['strict'] });
    const snapshot = JSON.parse(JSON.stringify(h.message(nav.componentMessageId ?? panel(h, home).id)));
    let mark = h.fake.messageLog.length;
    await Promise.all([h.click(snapshot, 'cmd:permissions:strict:on', { as: 'admin' }), h.click(snapshot, 'cmd:permissions:strict:on', { as: 'admin' })]);
    await h.settle();
    assert.equal(logs(h, mark, /Permissions par niveaux modifiées/).length, 1, 'double clic : plusieurs logs');
    const l2 = await h.click(snapshot, 'cmd:permissions:nav', { as: 'admin', values: ['l2'] });
    const l2msg = JSON.parse(JSON.stringify(h.message(l2.componentMessageId ?? snapshot.id)));
    mark = h.fake.messageLog.length;
    await Promise.all([h.click(l2msg, 'cmd:permissions:roles:2', { as: 'admin', values: [IDS.roles.temp] }), h.click(l2msg, 'cmd:permissions:roles:2', { as: 'admin', values: [IDS.roles.temp] })]);
    await h.settle();
    assert.equal(logs(h, mark, /Permissions par niveaux modifiées/).length, 1, 'double sélection : plusieurs logs');
    assert.deepEqual(h.client.services.permissions.settings(h.guild.id).levels[2].roles, [IDS.roles.temp]);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('vérifications : commande déléguée masquée par Discord signalée, visible reconnue ; lecture des surcharges en échec tolérée', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    ok(h, await level(h, 1, 'ajouter', IDS.roles.gamer, 'admin'), 'niveau 1 ← Joueur');
    ok(h, await assign(h, 'clear', 1, 'admin'), 'clear 1');
    ok(h, await assign(h, 'slowmode', 1, 'admin'), 'slowmode 1');
    const app = h.client.application.id;
    const registered = (name, perms) => ({ id: nextId(), application_id: app, name, description: 'Commande', type: 1, version: '1', default_member_permissions: String(perms), contexts: [0], integration_types: [0] });
    const clearCmd = registered('clear', P.ManageMessages);
    h.fake.commands = [clearCmd, registered('slowmode', P.ManageChannels)];
    h.fake.commandPermissions = [{ id: clearCmd.id, application_id: app, guild_id: h.guild.id, permissions: [{ id: IDS.roles.gamer, type: 1, permission: true }] }];

    const home = await perm(h, 'panneau', [], 'admin');
    const checks = await h.click(panel(h, home), 'cmd:permissions:nav', { as: 'admin', values: ['checks'] });
    const text = h.replyText({ messages: [checks.componentMessageId ?? panel(h, home).id] });
    assert.match(text, /\*\*\/clear\*\* \(niveau 1\) : visible/);
    assert.match(text, /\*\*\/slowmode\*\* \(niveau 1\) : \*\*masquée par Discord\*\*/);
    assert.ok(h.fake.calls.some((c) => c.method === 'GET' && /\/commands\/permissions$/.test(c.route)));
    const homeAgain = await perm(h, 'panneau', [], 'admin');
    assert.match(h.replyText(homeAgain), /1\*\* commande\(s\) déléguée\(s\) masquée\(s\)/);

    // Échec de lecture (Missing Access) : vérification ignorée, aucune erreur.
    h.client.services.permissions.overrides.clear();
    h.fake.inject({ method: 'GET', route: /\/commands\/permissions$/ }, { status: 403, code: 50001, message: 'Missing Access' });
    const home2 = await perm(h, 'panneau', [], 'admin');
    const failed = await h.click(panel(h, home2), 'cmd:permissions:nav', { as: 'admin', values: ['checks'] });
    assert.match(h.replyText({ messages: [failed.componentMessageId ?? panel(h, home2).id] }), /Lecture des surcharges impossible/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/permissions verifier : rang et source, commandes déléguées utilisables, commandes bloquées par le mode strict', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    ok(h, await level(h, 2, 'ajouter', IDS.roles.gamer, 'owner'), 'niveau 2 ← Joueur');
    ok(h, await assign(h, 'clear', 1, 'owner'), 'clear 1');
    ok(h, await assign(h, 'ban', 3, 'owner'), 'ban 3');
    h.configure({ permissions: { strict: true } });
    const m = await perm(h, 'verifier', [opt('membre', 6, IDS.users.member)], 'admin');
    ok(h, m, 'verifier membre');
    const embed = h.messagesOf(m)[0].embeds[0];
    assert.match(embed.description, /rang 2/);
    assert.match(embed.description, new RegExp(`<@&${IDS.roles.gamer}>`));
    assert.match(embed.fields.find((f) => /déléguées/.test(f.name)).value, /\/clear \(niveau 1\)/);
    const mod = await perm(h, 'verifier', [opt('membre', 6, IDS.users.mod)], 'admin');
    assert.match(h.messagesOf(mod)[0].embeds[0].fields.find((f) => /mode strict/.test(f.name)).value, /\/ban \(niveau 3\)/);
    const owner = await perm(h, 'verifier', [opt('membre', 6, IDS.users.owner)], 'admin');
    assert.match(h.messagesOf(owner)[0].embeds[0].description, /rang 5/);
    denied(h, await perm(h, 'verifier', [opt('membre', 6, IDS.users.member)], 'member'), /Administrateur/, 'membre');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
