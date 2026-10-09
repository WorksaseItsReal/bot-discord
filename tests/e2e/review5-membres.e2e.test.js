'use strict';

/**
 * Bout en bout : régressions de la revue n° 5 (économie, mini-jeux, outils des membres)
 * sur le vrai discord.js — /afk et le filtre des pseudos de l'AutoMod, /snipe dans un fil
 * privé, suppression d'un fil (THREAD_DELETE), remboursement d'un rôle acheté, « De retour »
 * après un message filtré, raison d'absence avec un lien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Messages publiés par le bot dans un salon depuis `mark`. */
function botMessagesIn(h, channelId, mark = 0) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}

/** AutoMod réduit aux filtres donnés. */
function onlyFilters(h, keys, extra = {}) {
  const filters = Object.fromEntries(Object.keys(h.client.services.config.get(h.guild.id).automod.filters).map((k) => [k, { enabled: keys.includes(k) }]));
  h.configure({ automod: { enabled: true, filters, newMembers: { enabled: false }, ...extra } });
}

test('/afk et filtre des pseudos : le préfixe [AFK] n\'est jamais pris pour un « dehoist », le pseudo est rendu au retour', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyFilters(h, ['badNames']);
  Object.assign(h.client.services.afk, { delayMs: 5, ttlMs: 60 });
  const automod = h.client.services.automod;
  const nick = () => h.fake.members.get(IDS.users.member)?.nick ?? null;
  const renameLogs = () => [...h.fake.messages.values()].filter((m) => m.channel_id === IDS.channels.logs && /Pseudo renommé/.test(m.embeds?.[0]?.title ?? ''));
  try {
    await h.guild.members.cache.get(IDS.users.member).setNickname('Bob');
    await h.settle();
    assert.equal(nick(), 'Bob');

    await h.slash('afk', [opt('raison', 3, 'Parti déjeuner')], { as: 'member' });
    await sleep(20);
    await h.settle();
    assert.equal(nick(), '[AFK] Bob', 'le préfixe AFK a été remplacé par l\'AutoMod');
    assert.equal(renameLogs().length, 0, 'faux log « Pseudo renommé »');

    // Même sans la tolérance de 60 s (événement tardif, membre précédent inconnu) : le préfixe est ignoré.
    automod.allowedNames.clear();
    const member = h.guild.members.cache.get(IDS.users.member);
    assert.equal(await automod.checkMemberName(member, { source: 'update' }), null);
    // Le nom sous le préfixe reste vérifié : « [AFK] !Bob » posé par /afk est filtré pour « ! ».
    h.client.repositories.afk.setAfkNick(h.guild.id, IDS.users.member, '[AFK] !Bob');
    const fakeMember = { id: member.id, guild: member.guild, user: member.user, nickname: '[AFK] !Bob', permissions: member.permissions, roles: member.roles, manageable: false };
    const r = await automod.checkMemberName(fakeMember, { source: 'update' });
    assert.equal(r?.violation?.check, 'dehoist');
    assert.match(r.violation.detail, /« ! »/);
    h.client.repositories.afk.setAfkNick(h.guild.id, IDS.users.member, '[AFK] Bob');

    await h.userMessage({ as: 'member', content: 'je suis de retour' });
    await sleep(20);
    await h.settle();
    assert.equal(nick(), 'Bob', 'pseudo d\'origine non rendu au retour');
    assert.equal(renameLogs().length, 0);

    // Renommage fait par le bot hors de toute tolérance (exécutant du journal d'audit = le bot) : ignoré.
    automod.allowedNames.clear();
    await h.guild.members.cache.get(IDS.users.member).setNickname('!Bob');
    await sleep(20);
    await h.settle();
    assert.equal(nick(), '!Bob', 'un renommage du bot a été refiltré');
    assert.equal(renameLogs().length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/** DM reçus par un membre (canal MP créé par le bot). */
function dmsOf(h, userId) {
  const dm = [...h.fake.dms.values()].find((d) => d.recipients[0].id === userId);
  if (!dm) return [];
  return [...h.fake.messages.values()].filter((m) => m.channel_id === dm.id && m.author.id === h.client.user.id);
}

test('Fil privé : /snipe exige d\'en être membre (ou « Gérer les fils ») ; les alertes vérifient l\'appartenance auprès de Discord', async () => {
  const h = await createHarness();
  h.configureAll();
  Object.assign(h.client.services.highlights, { delayMs: 5 });
  try {
    // « Nettoyeur » : Gérer les messages, SANS Gérer les fils.
    const role = await h.guild.roles.create({ name: 'Nettoyeur', permissions: [P.ManageMessages] });
    const cleaner = h.addUser('Nettoyeur');
    await h.memberJoin(cleaner);
    await h.guild.members.cache.get(cleaner.id).roles.add(role.id);
    await h.settle();
    const thread = await h.guild.channels.cache.get(IDS.channels.general).threads.create({ name: 'admins-prive', type: 12, invitable: false });
    await h.settle();
    const secret = await h.userMessage({ as: 'admin', channel: thread.id, content: 'Mot de passe du panneau : hunter2' });
    await h.deleteUserMessage(secret.id);

    const snipe = (as) => h.slash('snipe', sub('supprime', [opt('salon', 7, thread.id)]), { as });
    const denied = await snipe(cleaner.id);
    assert.ok(h.isError(denied), 'contenu d\'un fil privé montré à un non-membre');
    assert.doesNotMatch(h.replyText(denied), /hunter2/);
    assert.match(h.replyText(denied), /fil privé/);
    // Membre du fil (inconnu du cache de discord.js) : vérifié auprès de Discord, accepté.
    h.fake.threadMembers.get(thread.id).add(cleaner.id);
    const allowed = await snipe(cleaner.id);
    assert.ok(!h.isError(allowed), h.replyText(allowed));
    assert.match(h.replyText(allowed), /hunter2/);
    // « Gérer les fils » (modérateur) : accepté sans en être membre.
    assert.match(h.replyText(await snipe('mod')), /hunter2/);

    // Alertes : membre du fil absent du cache → alerté ; non-membre → jamais.
    h.client.services.highlights.addWord(h.guild.id, IDS.users.target, 'gadget');
    h.client.services.highlights.addWord(h.guild.id, IDS.users.member, 'gadget');
    h.fake.threadMembers.get(thread.id).add(IDS.users.target);
    assert.equal(thread.members.cache.has(IDS.users.target), false);
    await h.userMessage({ as: 'admin', channel: thread.id, content: 'réunion gadget à 18 h' });
    await sleep(30);
    await h.settle();
    assert.equal(dmsOf(h, IDS.users.target).length, 1, 'membre du fil privé non alerté (cache incomplet)');
    assert.equal(dmsOf(h, IDS.users.member).length, 0, 'non-membre alerté du contenu d\'un fil privé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('Fil supprimé (THREAD_DELETE) : la partie s\'arrête, les verrous sont libérés, le snipe du fil est oublié', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const thread = h.client.channels.cache.get(IDS.channels.thread);
    const rec = await h.slash('jeu', sub('devine'), { as: 'member', channel: thread.id });
    assert.match(h.replyText(rec), /Devine/);
    assert.equal(h.client.services.games.count(), 1);
    const msg = await h.userMessage({ as: 'target', channel: thread.id, content: 'message à oublier' });
    await h.deleteUserMessage(msg.id);
    assert.ok(h.client.services.snipe.get(thread.id, 'deleted'));
    h.fake.deleteChannel(thread.id);
    await h.settle();
    assert.equal(h.client.services.games.count(), 0, 'partie toujours en cours dans un fil supprimé');
    assert.equal(h.client.services.snipe.get(thread.id, 'deleted'), null);
    const again = await h.slash('jeu', sub('devine'), { as: 'member', channel: 'general' });
    assert.ok(!h.isError(again), h.replyText(again));

    // Salon parent supprimé : les parties de ses fils s'arrêtent aussi.
    const t2 = await h.guild.channels.cache.get(IDS.channels.staff).threads.create({ name: 'fil-staff', type: 11 });
    await h.settle();
    await h.slash('jeu', sub('devine'), { as: 'mod', channel: t2.id });
    assert.equal(h.client.services.games.count(), 2);
    h.fake.deleteChannel(IDS.channels.staff);
    await h.settle();
    assert.equal(h.client.services.games.count(), 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('Boutique : un rôle non attribué est remboursé EXACTEMENT du débit, même si le prix change pendant l\'achat', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ economy: { enabled: true } });
  const svc = h.client.services.economy;
  const G = h.guild.id;
  try {
    svc.adminAdjust(G, IDS.users.member, 'set', 1000, IDS.users.admin);
    const item = svc.addItem(G, { name: 'Notifs', price: 1000, kind: 'role', roleId: IDS.roles.notif });
    const shop = await h.slash('eco', sub('boutique'), { as: 'member' });
    const msg = h.messagesOf(shop)[0];
    const buyId = msg.components.flatMap((r) => r.components).find((c) => c.custom_id?.startsWith('cmd:eco:buy:')).custom_id;
    // Un administrateur baisse le prix à 1 pendant l'acquittement (deferUpdate) de l'achat…
    h.fake.inject({ match: (c) => {
      if (c.method === 'POST' && /\/interactions\/\d+\/[^/]+\/callback/.test(c.route) && c.body?.type === 6) {
        h.client.repositories.economy.updateItem(G, item.id, { name: 'Notifs', price: 1 });
      }
      return false;
    } }, { times: 1e9 });
    // … et Discord refuse l'attribution du rôle.
    h.fake.inject({ method: 'PUT', route: /\/members\/\d+\/roles\/\d+$/ }, { status: 403, code: 50013 });
    const rec = await h.click(msg, buyId, { as: 'member' });
    await h.settle();
    assert.match(h.replyText(rec), /remboursé de \*\*1\*\*/);
    assert.equal(svc.account(G, IDS.users.member).balance, 1000, 'remboursement différent du débit (argent créé)');
    assert.deepEqual(h.client.repositories.economy.history(G, IDS.users.member, 2).map((t) => `${t.kind}:${t.delta}`), ['refund:1', 'buy:-1']);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
