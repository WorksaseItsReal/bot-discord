'use strict';

/**
 * Bout en bout : économie (/eco, /economie) sur le vrai discord.js — tableau de bord
 * (chaque vue, bouton, menu, formulaire), refus sans permission, gains et délais,
 * virements (taxe, confirmation), jeux, boutique (objet, rôle, stock, double clic,
 * remboursement), gestion des soldes et logs « Serveur ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore, leavesOf, runLeaf } = require('./lib/explore');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const findButton = (m, prefix) => buttonsOf(m).find((c) => c.custom_id?.startsWith(prefix));
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const logTitles = (h, mark) => botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs).map((m) => m.embeds?.[0]?.title ?? '');
const hasRole = (h, userId, roleId) => h.fake.members.get(userId)?.roles.includes(roleId);
const snapshot = (m) => JSON.parse(JSON.stringify(m));

async function setup({ enabled = true } = {}) {
  const h = await createHarness();
  h.configureAll();
  if (enabled) h.configure({ economy: { enabled: true, games: { coinflip: true, slots: true, cooldownSeconds: 0 } } });
  return h;
}

const balance = (h, as) => h.client.services.economy.account(h.guild.id, IDS.users[as] ?? as).balance;
const eco = (h, name, options = [], ctx = {}) => h.slash('eco', sub(name, options), { as: 'member', ...ctx });

test('/economie : chaque vue, bouton, menu et formulaire ; refus sans permission', async () => {
  const h = await setup({ enabled: false });
  try {
    const rec = await h.slash('economie');
    assert.match(h.replyText(rec), /Économie · Tableau de bord/);
    const stats = await explore(h, rec, { budget: 300, skip: (a) => /cmd:economie:(reset|itemdelete)/.test(a.customId) });
    assert.ok(stats.modals >= 6, `formulaires soumis : ${stats.modals}`);
    for (const view of ['home', 'gains', 'rules', 'shop', 'manage', 'stats']) assert.ok(stats.navChosen.has(`cmd:economie:nav=${view}`), `vue ${view} jamais ouverte`);
    for (const key of ['toggle', 'currency', 'daily', 'work', 'transfers', 'games', 'game', 'itemadd', 'itemrole', 'member']) {
      assert.ok(stats.keys.has(`cmd:economie:${key}`), `${key} jamais utilisé`);
    }

    // Vue d'un article (créé par le formulaire) et d'un membre : explorées à leur tour.
    const shop = await h.click(h.messagesOf(await h.slash('economie'))[0], 'cmd:economie:nav', { values: ['shop'] });
    const add = await h.click(h.messagesOf(shop)[0], 'cmd:economie:itemadd');
    const created = await h.submitModal(add, { name: 'Badge doré', price: '250', description: 'Un badge qui brille.', stock: '3', emoji: '🏅' });
    assert.match(h.replyText(created), /Article ajouté/);
    const detail = await explore(h, created, { budget: 40, skip: (a) => a.customId.startsWith('cmd:economie:itemdelete') });
    assert.ok(detail.keys.has('cmd:economie:itemedit'), 'modification jamais ouverte');
    const manage = await h.click(h.messagesOf(await h.slash('economie'))[0], 'cmd:economie:nav', { values: ['manage'] });
    const member = await h.click(h.messagesOf(manage)[0], 'cmd:economie:member', { values: [IDS.users.member] });
    const memberStats = await explore(h, member, { budget: 40, skip: (a) => /cmd:economie:reset/.test(a.customId) });
    assert.ok(memberStats.keys.has('cmd:economie:adjust'), 'ajustement jamais ouvert');

    // Membre sans « Gérer le serveur » : commande et composants refusés, rien ne change.
    const denied = await h.slash('economie', [], { as: 'member' });
    assert.ok(h.isError(denied));
    const admin = await h.slash('economie');
    const configBefore = JSON.stringify(h.client.services.config.get(h.guild.id).economy);
    const itemsBefore = JSON.stringify(h.client.services.economy.listItems(h.guild.id));
    const supplyBefore = h.client.services.economy.stats(h.guild.id).supply;
    await explore(h, admin, { as: 'member', budget: 40 });
    await explore(h, member, { as: 'member', budget: 20 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).economy), configBefore, 'un membre a modifié la configuration');
    assert.equal(JSON.stringify(h.client.services.economy.listItems(h.guild.id)), itemsBefore, 'un membre a modifié la boutique');
    assert.equal(h.client.services.economy.stats(h.guild.id).supply, supplyBefore, 'un membre a modifié un solde');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/eco : désactivée par défaut, puis chaque sous-commande explorée (membre)', async () => {
  const h = await setup({ enabled: false });
  try {
    const off = await eco(h, 'solde');
    assert.ok(h.isError(off) && /pas activée/.test(h.replyText(off)), h.replyText(off));

    // Activation par le tableau de bord (journalisée).
    const mark = h.fake.messageLog.length;
    const dash = await h.slash('economie');
    const on = await h.click(h.messagesOf(dash)[0], 'cmd:economie:toggle:on');
    assert.match(h.replyText(on), /Économie \*\*activée\*\*/);
    assert.equal(h.client.services.config.get(h.guild.id).economy.enabled, true);
    assert.ok(logTitles(h, mark).some((t) => /Économie activée/.test(t)), 'activation non journalisée');
    h.configure({ economy: { games: { cooldownSeconds: 0 } } });
    h.client.services.economy.adminAdjust(h.guild.id, IDS.users.member, 'give', 5000, IDS.users.admin);

    // Chaque sous-commande, puis ses composants.
    const command = h.client.commands.get('eco');
    for (const leaf of leavesOf(command.data.toJSON())) {
      const overrides = { membre: IDS.users.target, mise: 10, montant: 5 };
      const rec = await runLeaf(h, 'eco', leaf, { as: 'member', overrides });
      assert.ok(rec.ackType != null, `/eco ${leaf.path.join(' ')} non acquittée`);
      await explore(h, rec, { as: 'member', budget: 25 });
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/eco : gains, série, délais, virements (taxe, confirmation), jeux, historique, classement', async () => {
  const h = await setup();
  const svc = h.client.services.economy;
  const repo = h.client.repositories.economy;
  try {
    // Quotidien : une fois par 24 h ; série prolongée sous 48 h.
    const daily = await eco(h, 'quotidien');
    assert.ok(!h.isError(daily), h.replyText(daily));
    assert.equal(balance(h, 'member'), 100);
    const again = await eco(h, 'quotidien');
    assert.ok(h.isError(again) && /déjà récupéré/.test(h.replyText(again)));
    repo.setDaily(h.guild.id, IDS.users.member, Date.now() - 30 * 3_600_000, 3);
    const streak = await eco(h, 'quotidien');
    assert.match(h.replyText(streak), /Série : \*\*4\*\*/);
    assert.equal(balance(h, 'member'), 100 + 100 + 30, 'bonus de série (3 jours × 10)');

    // Hebdo et travail (gain borné, délai).
    await eco(h, 'hebdo');
    assert.equal(balance(h, 'member'), 730);
    assert.ok(h.isError(await eco(h, 'hebdo')));
    await eco(h, 'travail');
    const afterWork = balance(h, 'member');
    assert.ok(afterWork >= 750 && afterWork <= 810, `travail : ${afterWork}`);
    const tired = await eco(h, 'travail');
    assert.ok(h.isError(tired) && /fatigué/.test(h.replyText(tired)));

    // Solde (soi, un autre membre, un bot).
    const own = await eco(h, 'solde');
    assert.match(h.replyText(own), /Solde · /);
    assert.ok(!h.isError(await eco(h, 'solde', [opt('membre', 6, IDS.users.target)])));
    assert.ok(h.isError(await eco(h, 'solde', [opt('membre', 6, IDS.users.otherBot)])));

    // Virements : refus (soi, bot, solde insuffisant), puis virement direct.
    assert.ok(h.isError(await eco(h, 'payer', [opt('membre', 6, IDS.users.member), opt('montant', 4, 10)])));
    assert.ok(h.isError(await eco(h, 'payer', [opt('membre', 6, IDS.users.otherBot), opt('montant', 4, 10)])));
    const poor = await eco(h, 'payer', [opt('membre', 6, IDS.users.member), opt('montant', 4, 10)], { as: 'target' });
    assert.ok(h.isError(poor), 'virement sans solde accepté');
    const before = balance(h, 'member');
    const paid = await eco(h, 'payer', [opt('membre', 6, IDS.users.target), opt('montant', 4, 50)]);
    assert.match(h.replyText(paid), /Virement effectué/);
    assert.equal(balance(h, 'member'), before - 50);
    assert.equal(balance(h, 'target'), 50);

    // Taxe de 10 % et confirmation au-delà de 100 : annulation, puis confirmation.
    h.configure({ economy: { transfers: { taxPercent: 10, confirmAbove: 100 } } });
    const cancelled = await eco(h, 'payer', [opt('membre', 6, IDS.users.target), opt('montant', 4, 200)]);
    assert.match(h.replyText(cancelled), /Confirmation requise/);
    await h.confirm(cancelled, { cancel: true });
    assert.equal(balance(h, 'target'), 50, 'virement annulé exécuté');
    const big = await eco(h, 'payer', [opt('membre', 6, IDS.users.target), opt('montant', 4, 200)]);
    await h.confirm(big);
    await h.settle();
    assert.equal(balance(h, 'target'), 50 + 180, 'taxe non prélevée');
    assert.equal(balance(h, 'member'), before - 250);
    const announced = botMessages(h, 0, (m) => (m.embeds?.[0]?.title ?? '').includes('Virement effectué') && !(m.flags & 64));
    assert.ok(announced.length >= 2, 'virement confirmé non annoncé publiquement');

    // Jeux : mise plafonnée, solde insuffisant, délai, jeu désactivé, rejouer (auteur seulement).
    h.configure({ economy: { limits: { maxBet: 100 }, games: { cooldownSeconds: 60 } } });
    assert.ok(h.isError(await eco(h, 'pile-ou-face', [opt('mise', 4, 101)])), 'mise au-delà du plafond acceptée');
    assert.ok(h.isError(await eco(h, 'machine-a-sous', [opt('mise', 4, 100)], { as: 'owner' })), 'mise sans solde acceptée');
    const b0 = balance(h, 'member');
    const flip = await eco(h, 'pile-ou-face', [opt('mise', 4, 20), opt('choix', 3, 'face')]);
    assert.match(h.replyText(flip), /tombe sur \*\*(PILE|FACE)\*\*/);
    assert.match(h.replyText(flip), /espérance négative/);
    assert.ok([b0 - 20, b0 + 20].includes(balance(h, 'member')), `pile ou face : ${b0} → ${balance(h, 'member')}`);
    const wait = await eco(h, 'machine-a-sous', [opt('mise', 4, 20)]);
    assert.ok(h.isError(wait) && /Doucement/.test(h.replyText(wait)), 'délai entre deux parties ignoré');
    h.configure({ economy: { games: { cooldownSeconds: 0, coinflip: false } } });
    assert.ok(h.isError(await eco(h, 'pile-ou-face', [opt('mise', 4, 5)])), 'jeu désactivé accepté');
    const slots = await eco(h, 'machine-a-sous', [opt('mise', 4, 20)]);
    assert.match(h.replyText(slots), /\[ .+ \| .+ \| .+ \]/);
    const card = h.message(slots.original);
    const replay = findButton(card, 'cmd:eco:replay:slots:20:');
    const stolen = await h.click(card, replay.custom_id, { as: 'target' });
    assert.ok(h.isError(stolen), 'un autre membre a rejoué la partie');
    const b1 = balance(h, 'member');
    const replayed = await h.click(card, replay.custom_id, { as: 'member' });
    assert.ok(!h.isError(replayed), h.replyText(replayed));
    assert.equal(repo.history(h.guild.id, IDS.users.member, 1)[0].kind, 'slots');
    assert.equal(repo.history(h.guild.id, IDS.users.member, 1)[0].balance_after, balance(h, 'member'));
    assert.ok(balance(h, 'member') >= b1 - 20);

    // Historique (éphémère) et classement public paginé.
    const history = await eco(h, 'historique');
    assert.match(h.replyText(history), /Vos dernières transactions/);
    assert.match(h.messagesOf(history)[0].embeds[0].description, /Virement envoyé/);
    const board = await eco(h, 'classement');
    assert.match(h.replyText(board), /Les plus riches/);
    const me = await h.click(h.message(board.original), `cmd:eco:topme:${IDS.users.member}`, { as: 'target' });
    assert.match(h.replyText(me), /#2/);
    // Aucun solde négatif, historique cohérent avec le solde.
    for (const as of ['member', 'target']) {
      const acc = svc.account(h.guild.id, IDS.users[as]);
      assert.ok(acc.balance >= 0);
      assert.equal(repo.history(h.guild.id, IDS.users[as], 1)[0].balance_after, acc.balance);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('boutique : objet, rôle (hiérarchie, permissions), stock, double clic, remboursement, gestion et logs', async () => {
  const h = await setup();
  const svc = h.client.services.economy;
  try {
    const mark = h.fake.messageLog.length;
    const open = async () => h.messagesOf(await h.slash('economie'))[0];
    const shopPanel = async () => h.messagesOf(await h.click(await open(), 'cmd:economie:nav', { values: ['shop'] }))[0];
    // Objet (stock 1) créé par le formulaire.
    const add = await h.click(await shopPanel(), 'cmd:economie:itemadd');
    await h.submitModal(add, { name: 'Ticket VIP', price: '100', description: 'Accès au salon VIP.', stock: '1', emoji: '🎟️' });
    // Rôles : sensible et administrateur refusés, rôle simple accepté.
    const panel = await shopPanel();
    for (const role of [IDS.roles.mod, IDS.roles.admin]) {
      const refused = await h.click(panel, 'cmd:economie:itemrole', { values: [role] });
      assert.ok(h.isError(refused) && /modération ou d'administration/.test(h.replyText(refused)), h.replyText(refused));
      assert.equal(refused.modals.length, 0);
    }
    const pick = await h.click(panel, 'cmd:economie:itemrole', { values: [IDS.roles.notif] });
    assert.equal(pick.modals.length, 1);
    await h.submitModal(pick, { name: 'Notifications', price: '50', description: '', stock: '', emoji: '' });
    const items = svc.listItems(h.guild.id);
    assert.deepEqual(items.map((i) => [i.name, i.kind, i.price, i.stock]), [['Notifications', 'role', 50, null], ['Ticket VIP', 'item', 100, 1]]);
    const [roleItem, ticket] = items;
    assert.equal(roleItem.role_id, IDS.roles.notif);

    // Solde donné par le tableau de bord (journalisé).
    const manage = await h.click(await open(), 'cmd:economie:nav', { values: ['manage'] });
    const member = await h.click(h.messagesOf(manage)[0], 'cmd:economie:member', { values: [IDS.users.target] });
    const give = await h.click(h.messagesOf(member)[0], `cmd:economie:adjust:give:${IDS.users.target}`);
    const given = await h.submitModal(give, { amount: '1 000' });
    assert.match(h.replyText(given), /0 → \*\*1/);
    assert.equal(balance(h, 'target'), 1000);

    // Boutique côté membre : double clic sur « Acheter » → un seul achat.
    const view = await eco(h, 'boutique', [], { as: 'target' });
    const msg = snapshot(h.messagesOf(view)[0]);
    const buyTicket = findButton(msg, `cmd:eco:buy:${ticket.id}:`);
    assert.ok(buyTicket && !buyTicket.disabled, 'bouton d\'achat absent');
    const clicks = await Promise.all([h.click(msg, buyTicket.custom_id, { as: 'target' }), h.click(msg, buyTicket.custom_id, { as: 'target' })]);
    assert.equal(clicks.filter((c) => h.isError(c)).length, 1, 'double clic : deux achats ou aucun');
    assert.equal(balance(h, 'target'), 900);
    assert.equal(svc.getItem(h.guild.id, ticket.id).stock, 0);
    assert.deepEqual(svc.inventory(h.guild.id, IDS.users.target).map((r) => [r.name, r.quantity]), [['Ticket VIP', 1]]);
    // Rupture de stock : bouton désactivé ; vieux bouton refusé.
    const refreshed = await eco(h, 'boutique', [], { as: 'target' });
    assert.equal(findButton(h.messagesOf(refreshed)[0], `cmd:eco:buy:${ticket.id}:`).disabled, true);
    const stale = await h.click(msg, buyTicket.custom_id, { as: 'target' });
    assert.ok(h.isError(stale));
    assert.equal(balance(h, 'target'), 900);

    // Rôle : attribué par Discord, débit unique.
    const roleButton = findButton(h.messagesOf(refreshed)[0], `cmd:eco:buy:${roleItem.id}:`);
    const bought = await h.click(h.messagesOf(refreshed)[0], roleButton.custom_id, { as: 'target' });
    assert.ok(!h.isError(bought), h.replyText(bought));
    assert.match(h.replyText(bought), /obtenu/);
    assert.ok(hasRole(h, IDS.users.target, IDS.roles.notif), 'rôle acheté non attribué');
    assert.equal(balance(h, 'target'), 850);
    const owned = await eco(h, 'boutique', [], { as: 'target' });
    assert.equal(findButton(h.messagesOf(owned)[0], `cmd:eco:buy:${roleItem.id}:`).disabled, true, 'rôle déjà possédé encore achetable');

    // Discord refuse le rôle : achat remboursé (stock et solde rendus).
    svc.adminAdjust(h.guild.id, IDS.users.member, 'give', 500, IDS.users.admin);
    h.fake.inject({ method: 'PUT', route: new RegExp(`/members/${IDS.users.member}/roles/${IDS.roles.notif}$`) }, { status: 403, code: 50013 });
    const memberShop = await eco(h, 'boutique');
    const refused = await h.click(h.messagesOf(memberShop)[0], findButton(h.messagesOf(memberShop)[0], `cmd:eco:buy:${roleItem.id}:`).custom_id, { as: 'member' });
    assert.match(h.replyText(refused), /remboursé/);
    assert.equal(balance(h, 'member'), 500);
    assert.ok(!hasRole(h, IDS.users.member, IDS.roles.notif));
    assert.deepEqual(h.client.repositories.economy.history(h.guild.id, IDS.users.member, 2).map((t) => t.kind), ['refund', 'buy']);

    // Rôle devenu sensible : achat refusé à l'achat (revérifié), rien n'est débité.
    const notif = h.fake.roles.get(IDS.roles.notif);
    notif.permissions = String(1n << 3n); // Administrateur
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role: notif });
    await h.settle();
    const forbidden = await h.click(h.messagesOf(memberShop)[0], findButton(h.messagesOf(memberShop)[0], `cmd:eco:buy:${roleItem.id}:`).custom_id, { as: 'member' });
    assert.ok(h.isError(forbidden) && /modération ou d'administration/.test(h.replyText(forbidden)), h.replyText(forbidden));
    assert.equal(balance(h, 'member'), 500);

    // Inventaire, puis suppression de l'article (confirmation) : inventaire vidé.
    const inv = await eco(h, 'inventaire', [], { as: 'target' });
    assert.match(h.replyText(inv), /Ticket VIP/);
    const itemView = await h.click(await shopPanel(), 'cmd:economie:itempick', { values: [String(ticket.id)] });
    const confirm = await h.click(h.messagesOf(itemView)[0], `cmd:economie:go:confirmDelItem.${ticket.id}`);
    assert.match(h.replyText(confirm), /disparaîtra aussi de l'inventaire de \*\*1\*\*/);
    await h.click(h.messagesOf(confirm)[0], `cmd:economie:itemdelete:${ticket.id}`);
    assert.equal(svc.getItem(h.guild.id, ticket.id), null);
    assert.equal(svc.inventory(h.guild.id, IDS.users.target).length, 0);

    // Retirer (jamais sous zéro), définir (plafond), réinitialiser un membre puis tout le serveur.
    const take = await h.click(h.messagesOf(member)[0], `cmd:economie:adjust:take:${IDS.users.target}`);
    await h.submitModal(take, { amount: '5000' });
    assert.equal(balance(h, 'target'), 0);
    const set = await h.click(h.messagesOf(member)[0], `cmd:economie:adjust:set:${IDS.users.target}`);
    assert.ok(h.isError(await h.submitModal(set, { amount: '999999999999' })), 'solde au-delà du plafond accepté');
    await h.submitModal(set, { amount: '42' });
    assert.equal(balance(h, 'target'), 42);
    const memberAgain = await h.click(h.messagesOf(manage)[0], 'cmd:economie:member', { values: [IDS.users.target] });
    const confirmMember = await h.click(h.messagesOf(memberAgain)[0], `cmd:economie:go:confirmMember.${IDS.users.target}`);
    await h.click(h.messagesOf(confirmMember)[0], `cmd:economie:reset:member:${IDS.users.target}`);
    assert.equal(h.client.repositories.economy.get(h.guild.id, IDS.users.target), null);
    const all = await h.click(h.messagesOf(await h.click(await open(), 'cmd:economie:nav', { values: ['manage'] }))[0], 'cmd:economie:go:confirmResetAll');
    await h.click(h.messagesOf(all)[0], 'cmd:economie:reset:guild');
    assert.equal(svc.stats(h.guild.id).accounts, 0);
    assert.equal(svc.listItems(h.guild.id).length, 1, 'la boutique doit être conservée');

    // Logs « Serveur » : chaque opération d'administration.
    const titles = logTitles(h, mark);
    for (const re of [/Article ajouté/, /Solde ajusté/, /Article retiré/, /Compte d'économie réinitialisé/, /entièrement réinitialisée/]) {
      assert.ok(titles.some((t) => re.test(t)), `log manquant : ${re} (${titles.join(' | ')})`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
