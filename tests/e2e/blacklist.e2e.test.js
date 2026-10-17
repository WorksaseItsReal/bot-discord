'use strict';

/**
 * SEC3 — liste noire persistante et blrank, bout en bout (vrai discord.js, faux Discord) :
 * ajout par le propriétaire, refus en embed, débannissement manuel annulé, /unban refusé,
 * retour d'un blacklisté débanni hors ligne, contrôle périodique, retrait (double clic), blrank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');

const bl = (sub, options = []) => [{ name: 'blacklist', type: 2, options: [{ name: sub, type: 1, options }] }];
const blr = (sub, options = []) => [{ name: 'blrank', type: 2, options: [{ name: sub, type: 1, options }] }];
const opt = (name, type, value) => ({ name, type, value });
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const logged = (h, mark, re) => botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && titled(re)(m));
const calls = (h, mark, method, re) => h.fake.calls.slice(mark).filter((c) => c.method === method && re.test(c.route));
const recOf = (h, message) => ({ messages: [message.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] });

test('liste noire : ajout par le propriétaire (ban, casier, log) ; doublon sans second ban ; admin non-owner et membre refusés en embed ; /unban refusé ; débannissement manuel annulé avec son auteur', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const target = IDS.users.target;
    let mark = h.fake.messageLog.length;
    let callMark = h.fake.calls.length;
    const rec = await h.slash('secur', bl('ajouter', [opt('membre', 6, target), opt('raison', 3, 'Nuke de salons')]), { as: 'owner' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    const [reply] = h.messagesOf(rec);
    assert.ok(reply.flags & EPHEMERAL);
    assert.match(reply.embeds[0].title, /Ajouté à la liste noire/);
    assert.ok(h.fake.bans.has(target), 'cible non bannie');
    assert.match(h.fake.bans.get(target).reason, /^Blacklist : Nuke de salons/);
    assert.equal(h.fake.members.has(target), false);
    const row = h.client.repositories.securityBlacklist.get(h.guild.id, target, 'ban');
    assert.equal(row.author_id, IDS.users.owner);
    assert.ok(row.next_check_at > Date.now() + 5 * 3_600_000, 'prochain contrôle dans 6 h');
    assert.ok(h.client.repositories.sanctions.listActive(h.guild.id, target).some((s) => s.type === 'ban' && /^Blacklist/.test(s.reason)), 'casier non renseigné');
    assert.equal(logged(h, mark, /Ajouté à la liste noire/).length, 1, 'log blacklist absent');
    assert.equal(logged(h, mark, /Membre banni/).length, 0, 'ban du bot journalisé comme manuel');
    assert.equal(calls(h, callMark, 'PUT', /\/bans\//).length, 1);

    // Doublon : refus, aucun second ban.
    callMark = h.fake.calls.length;
    const again = await h.slash('secur', bl('ajouter', [opt('membre', 6, target), opt('raison', 3, 'Encore')]), { as: 'owner' });
    assert.ok(h.isError(again));
    assert.match(h.replyText(again), /déjà/);
    assert.equal(calls(h, callMark, 'PUT', /\/bans\//).length, 0, 'double ban');

    // Administrateur non-owner et membre : refus en embed.
    const admin = await h.slash('secur', bl('ajouter', [opt('membre', 6, IDS.users.member), opt('raison', 3, 'x')]), { as: 'admin' });
    assert.ok(h.isError(admin));
    assert.ok(h.messagesOf(admin)[0].embeds.length);
    assert.match(h.replyText(admin), /Réservé au propriétaire du serveur et aux owners/);
    assert.ok(h.fake.members.has(IDS.users.member));
    const member = await h.slash('secur', bl('liste'), { as: 'member' });
    assert.ok(h.isError(member));
    // Refus : soi-même, whitelisté.
    assert.match(h.replyText(await h.slash('secur', bl('ajouter', [opt('membre', 6, IDS.users.owner), opt('raison', 3, 'x')]), { as: 'owner' })), /vous-même/);
    h.configure({ whitelist: { users: [IDS.users.mod], roles: [] } });
    assert.match(h.replyText(await h.slash('secur', bl('ajouter', [opt('membre', 6, IDS.users.mod), opt('raison', 3, 'x')]), { as: 'owner' })), /whitelist/);

    // /unban : refus en embed, aucune requête de débannissement.
    callMark = h.fake.calls.length;
    const unban = await h.slash('unban', [opt('user_id', 3, target)], { as: 'admin' });
    assert.ok(h.isError(unban));
    assert.match(h.replyText(unban), /liste noire/);
    assert.equal(calls(h, callMark, 'DELETE', /\/bans\//).length, 0);

    // Débannissement manuel (interface Discord) : GUILD_BAN_REMOVE + audit 23 → rebanni, log avec l'auteur.
    mark = h.fake.messageLog.length;
    await h.asHuman('admin').perform('DELETE', `/guilds/${h.guild.id}/bans/${target}`);
    await h.settle();
    assert.ok(h.fake.bans.has(target), 'blacklisté resté débanni');
    const [cancelled] = logged(h, mark, /Débannissement annulé/);
    assert.ok(cancelled, 'log « Débannissement annulé » absent');
    assert.match(cancelled.embeds[0].fields.find((f) => /Débanni par/.test(f.name)).value, new RegExp(IDS.users.admin));

    // Liste et fiche (exploration : la fiche propose « Retirer », refusé à un administrateur non-owner).
    const list = await h.slash('secur', bl('liste'), { as: 'admin' });
    assert.match(h.messagesOf(list)[0].embeds[0].title, /Liste noire · 1/);
    const info = await h.slash('secur', bl('info', [opt('utilisateur', 3, `<@${target}>`)]), { as: 'admin' });
    assert.match(h.messagesOf(info)[0].embeds[0].title, /Liste noire · fiche/);
    await explore(h, info, { as: 'admin', budget: 6 });
    assert.ok(h.client.repositories.securityBlacklist.has(h.guild.id, target, 'ban'), 'retiré par un administrateur non-owner');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('blacklisté débanni hors ligne : banni à son arrivée, sans accueil, sans rôle d\'arrivée, sans comptage de vague ; contrôle périodique (10026 → rebanni)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const repo = h.client.repositories.securityBlacklist;
    const back = h.addUser('Revenant', { ageDays: 400 });
    repo.add({ guildId: h.guild.id, userId: back.id, kind: 'ban', reason: 'Raid', authorId: IDS.users.owner, nextCheckAt: Date.now() + 6 * 3_600_000 });
    const mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    await h.memberJoin(back);
    await h.settle();
    assert.ok(h.fake.bans.has(back.id), 'blacklisté non banni à son arrivée');
    assert.equal(calls(h, callMark, 'PUT', new RegExp(`/members/${back.id}/roles/`)).length, 0, 'rôle d\'arrivée donné');
    assert.equal(botMessages(h, mark, (m) => m.channel_id === IDS.channels.general).length, 0, 'message de bienvenue envoyé');
    assert.equal(botMessages(h, mark, (m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === back.id).length, 0, 'MP d\'accueil envoyé');
    assert.equal((h.client.services.antiraid.joinWindows.get(h.guild.id)?.entries ?? []).some((e) => e.id === back.id), false, 'compté dans la vague');
    assert.equal(logged(h, mark, /Blacklisté banni à son arrivée/).length, 1);
    assert.ok(repo.get(h.guild.id, back.id, 'ban').last_enforced_at);

    // Contrôle périodique : débanni pendant une absence du bot (aucun événement) → rebanni.
    const away = h.addUser('Absent', { ageDays: 400 });
    repo.add({ guildId: h.guild.id, userId: away.id, kind: 'ban', reason: 'Nuke', authorId: IDS.users.owner, nextCheckAt: Date.now() - 1_000 });
    const still = h.addUser('Toujours', { ageDays: 400 });
    h.fake.bans.set(still.id, { user: still, reason: 'Blacklist' });
    repo.add({ guildId: h.guild.id, userId: still.id, kind: 'ban', reason: 'Spam', authorId: IDS.users.owner, nextCheckAt: Date.now() - 1_000 });
    const mark2 = h.fake.messageLog.length;
    const callMark2 = h.fake.calls.length;
    await h.client.services.blacklist.processSecurityDue();
    await h.settle();
    assert.ok(h.fake.bans.has(away.id), 'débanni hors ligne non rebanni');
    assert.equal(calls(h, callMark2, 'GET', /\/bans\/\d+$/).length, 2, 'un GET par ligne due');
    assert.equal(calls(h, callMark2, 'PUT', /\/bans\//).length, 1, 'un seul rebannissement (la ligne encore bannie n\'est pas rebannie)');
    assert.ok(repo.get(h.guild.id, still.id, 'ban').next_check_at > Date.now() + 5 * 3_600_000);
    assert.equal(logged(h, mark2, /Bannissement rétabli/).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('retirer : confirmation, DELETE avant le débannissement (pas de rebannissement) ; double clic sur Confirmer → un seul débannissement ; administrateur non-owner refusé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const target = IDS.users.target;
    const add = await h.slash('secur', bl('ajouter', [opt('membre', 6, target), opt('raison', 3, 'Raid')]), { as: 'owner' });
    assert.ok(!h.isError(add), h.replyText(add));
    // Administrateur non-owner : refusé dès la commande.
    assert.ok(h.isError(await h.slash('secur', bl('retirer', [opt('utilisateur', 3, target)]), { as: 'admin' })));

    const ask = await h.slash('secur', bl('retirer', [opt('utilisateur', 3, target)]), { as: 'owner' });
    const [prompt] = h.messagesOf(ask);
    assert.match(prompt.embeds[0].title, /Retirer de la liste noire/);
    const confirmId = `cmd:secur:blremove:${target}:1`;
    assert.ok(h.findComponent(prompt, confirmId));
    // Bouton exploré par un administrateur non-owner : refusé, rien ne change.
    const denied = await h.click(prompt, confirmId, { as: 'admin' });
    assert.ok(h.isError(denied));
    assert.ok(h.client.repositories.securityBlacklist.has(h.guild.id, target, 'ban'));

    const stale = JSON.parse(JSON.stringify(h.message(prompt.id)));
    const mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    const [a, b] = await Promise.all([h.click(stale, confirmId, { as: 'owner' }), h.click(stale, confirmId, { as: 'owner' })]);
    await h.settle();
    assert.equal(calls(h, callMark, 'DELETE', /\/bans\//).length, 1, 'débanni plusieurs fois');
    assert.equal(calls(h, callMark, 'PUT', /\/bans\//).length, 0, 'rebanni après le retrait');
    assert.equal(h.fake.bans.has(target), false);
    assert.equal(h.client.repositories.securityBlacklist.has(h.guild.id, target, 'ban'), false);
    assert.equal([a, b].filter((r) => h.isError(r)).length, 1, 'le second clic doit être refusé');
    assert.match([a, b].map((r) => h.replyText(r)).join(' '), /déjà retiré/);
    assert.equal(logged(h, mark, /Retiré de la liste noire/).length, 1);
    assert.ok(!h.client.repositories.sanctions.listActive(h.guild.id, target).some((s) => s.type === 'ban'), 'casier non levé');

    // Retirer sans débannir : la ligne part, le ban reste.
    const other = h.addUser('Garde', { ageDays: 300 });
    await h.slash('secur', bl('ajouter', [opt('membre', 6, other.id), opt('raison', 3, 'Raid')]), { as: 'owner' });
    const keep = await h.slash('secur', bl('retirer', [opt('utilisateur', 3, other.id), opt('debannir', 5, false)]), { as: 'owner' });
    await h.click(h.messagesOf(keep)[0], `cmd:secur:blremove:${other.id}:0`, { as: 'owner' });
    assert.ok(h.fake.bans.has(other.id));
    assert.equal(h.client.repositories.securityBlacklist.has(h.guild.id, other.id, 'ban'), false);
    // Annuler : rien ne change.
    const third = h.addUser('Annule', { ageDays: 300 });
    await h.slash('secur', bl('ajouter', [opt('membre', 6, third.id), opt('raison', 3, 'Raid')]), { as: 'owner' });
    const cancel = await h.slash('secur', bl('retirer', [opt('utilisateur', 3, third.id)]), { as: 'owner' });
    await h.click(h.messagesOf(cancel)[0], 'cmd:secur:blcancel', { as: 'owner' });
    assert.ok(h.client.repositories.securityBlacklist.has(h.guild.id, third.id, 'ban'));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('liste paginée (10 par page) : boutons explorés en administrateur', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const repo = h.client.repositories.securityBlacklist;
    for (let i = 0; i < 23; i += 1) {
      const u = h.addUser(`Liste${i}`, { ageDays: 300 });
      repo.add({ guildId: h.guild.id, userId: u.id, kind: 'ban', reason: `Raison ${'*_'.repeat(20)} ${i}`, authorId: IDS.users.owner, createdAt: Date.now() - i * 1_000, nextCheckAt: Date.now() + 3_600_000 });
    }
    const rec = await h.slash('secur', bl('liste'), { as: 'admin' });
    const [page] = h.messagesOf(rec);
    assert.match(page.embeds[0].title, /Liste noire · 23/);
    assert.ok(h.findComponent(page, 'cmd:secur:blpage:1'));
    const next = await h.click(page, 'cmd:secur:blpage:1', { as: 'admin' });
    assert.ok(!h.isError(next));
    assert.match(h.message(page.id).embeds[0].footer.text, /Page 2\/3/);
    await explore(h, rec, { as: 'admin', budget: 10 });
    const empty = await h.slash('secur', blr('liste'), { as: 'admin' });
    assert.match(h.messagesOf(empty)[0].embeds[0].description, /Aucune entrée/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('blrank : rôle donné à la main → retiré avec log (auteur nommé) ; 4ᵉ retrait en 10 min → carte « boucle » sans retrait ; rôle d\'arrivée non appliqué ; refus pour un owner', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const add = await h.slash('secur', blr('ajouter', [opt('membre', 6, IDS.users.member), opt('raison', 3, 'Abus de rôles')]), { as: 'owner' });
    assert.ok(!h.isError(add), h.replyText(add));
    assert.ok(h.client.services.blacklist.isRankBlocked(h.guild.id, IDS.users.member));
    assert.ok(h.isError(await h.slash('secur', blr('ajouter', [opt('membre', 6, IDS.users.target)]), { as: 'admin' })), 'admin non-owner accepté');
    assert.match(h.replyText(await h.slash('secur', blr('ajouter', [opt('membre', 6, IDS.users.owner)]), { as: 'owner' })), /vous-même|propriétaire/);
    h.configure({ secur: { owners: [IDS.users.admin] } });
    assert.match(h.replyText(await h.slash('secur', blr('ajouter', [opt('membre', 6, IDS.users.admin)]), { as: 'owner' })), /owner de sécurité/);
    h.configure({ secur: { owners: [] } });

    const roleOf = () => h.fake.members.get(IDS.users.member).roles;
    let mark = h.fake.messageLog.length;
    await h.asHuman('admin').addRole('member', IDS.roles.notif);
    await h.settle();
    assert.equal(roleOf().includes(IDS.roles.notif), false, 'rôle laissé à un membre du blrank');
    const [log] = logged(h, mark, /Rôle retiré \(blrank\)/);
    assert.ok(log, 'log blrank absent');
    assert.match(log.embeds[0].fields.find((f) => /Rôle donné par/.test(f.name)).value, new RegExp(IDS.users.admin));
    assert.ok(roleOf().includes(IDS.roles.gamer), 'rôle déjà porté retiré');

    // Deux retraits de plus (3 en tout), puis le 4ᵉ : carte « boucle », aucun retrait.
    await h.asHuman('admin').addRole('member', IDS.roles.notif);
    await h.asHuman('admin').addRole('member', IDS.roles.notif);
    await h.settle();
    assert.equal(roleOf().includes(IDS.roles.notif), false);
    mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    await h.asHuman('admin').addRole('member', IDS.roles.notif);
    await h.settle();
    assert.ok(roleOf().includes(IDS.roles.notif), '4ᵉ retrait en 10 min');
    assert.equal(calls(h, callMark, 'DELETE', new RegExp(`/members/${IDS.users.member}/roles/`)).length, 0);
    assert.equal(logged(h, mark, /Boucle d'attribution/).length, 1);

    // Rôle d'arrivée : un membre du blrank qui arrive ne le reçoit pas.
    const newcomer = h.addUser('Nouveau', { ageDays: 400 });
    h.client.repositories.securityBlacklist.add({ guildId: h.guild.id, userId: newcomer.id, kind: 'rank', authorId: IDS.users.owner });
    const joinMark = h.fake.calls.length;
    await h.memberJoin(newcomer);
    await h.settle();
    assert.equal(calls(h, joinMark, 'PUT', new RegExp(`/members/${newcomer.id}/roles/`)).length, 0, 'rôle d\'arrivée donné à un membre du blrank');
    assert.ok(h.fake.members.has(newcomer.id), 'un membre du blrank n\'est pas banni');

    // Retrait du blrank : il peut de nouveau recevoir des rôles.
    const rm = await h.slash('secur', blr('retirer', [opt('membre', 6, IDS.users.member)]), { as: 'owner' });
    assert.ok(!h.isError(rm), h.replyText(rm));
    await h.asHuman('admin').addRole('member', IDS.roles.temp);
    await h.settle();
    assert.ok(roleOf().includes(IDS.roles.temp));
    const list = await h.slash('secur', blr('liste'), { as: 'admin' });
    assert.match(h.messagesOf(list)[0].embeds[0].title, /Blrank · 1/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
