'use strict';

/**
 * SEC2 — /secur (panneau, préréglages, owners, confiance), intégration à /antiraid et /whitelist,
 * bout en bout sur le vrai bot : scénarios 01 (auto-whitelist puis destruction) et 01c (AntiRaid
 * coupé en silence) rejoués, préréglage bloqué par un bot dangereux, verrou.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore, newStats, missingNavViews } = require('./lib/explore');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const dmsTo = (h, mark, userId) => botMessages(h, mark, (m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === userId);
const inLogs = (h, mark, re) => botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && titled(re)(m));
const sub = (name, options = []) => [{ name, type: 1, options }];
const group = (g, name, options = []) => [{ name: g, type: 2, options: [{ name, type: 1, options }] }];
const opt = (name, type, value) => ({ name, type, value });
const ids = (msg) => (msg?.components ?? []).flatMap((r) => r.components ?? []).map((c) => c.custom_id).filter(Boolean);
const component = (msg, id) => (msg?.components ?? []).flatMap((r) => r.components ?? []).find((c) => c.custom_id === id);
/** Module de test chargé dans le registre (le registre livré par SEC1 est vide). */
function loadModule(h, key = 'channelDelete', auditTypes = [12]) {
  if (h.client.services.secur.registry.has(key)) return;
  h.client.services.secur.registry.register({ key, auditTypes, priority: 3, classify: () => ({ weight: 1, record: null }), undo: async () => ({ ok: true }), targetKey: () => 'x' });
}

test('/secur panneau : propriétaire (exploration complète), administrateur en lecture seule, membre refusé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    loadModule(h);

    // Propriétaire : composants de modification, exploration sans violation.
    const rec = await h.slash('secur', sub('panneau'), { as: 'owner' });
    const [reply] = h.messagesOf(rec);
    assert.ok(reply.flags & EPHEMERAL, 'panneau public');
    assert.match(reply.embeds[0].title, /Secur · statut et réglages/);
    assert.ok(ids(reply).includes('cmd:secur:preview:on'));
    const stats = newStats();
    await explore(h, rec, { as: 'owner', budget: 300, stats });
    assert.deepEqual(missingNavViews(stats), [], 'vues du panneau jamais ouvertes');
    for (const key of ['cmd:secur:mode', 'cmd:secur:punish', 'cmd:secur:undo', 'cmd:secur:limits', 'modal:cmd:secur:limitsubmit', 'cmd:secur:verrou', 'cmd:secur:raidping', 'cmd:secur:botexec', 'cmd:secur:owners', 'cmd:secur:trust', 'cmd:secur:preview', 'cmd:secur:apply']) {
      assert.ok(stats.keys.has(key), `${key} jamais exploré`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());

    // Journal (« Rendre les rôles ») et accès en attente (« Approuver ») : gestionnaires de SEC1.
    const incident = h.client.repositories.securityIncidents.create({ guildId: h.guild.id, executorId: IDS.users.target, modules: ['channelDelete'], actions: 2, punishment: 'derank', removedRoles: [IDS.roles.gamer] });
    const grant = h.client.repositories.securityGrants.create({ guildId: h.guild.id, kind: 'user', subjectId: IDS.users.target, grantedBy: IDS.users.admin });
    const journal = await h.slash('secur', sub('panneau'), { as: 'owner' });
    const jMsg = h.messagesOf(journal)[0];
    await h.click(jMsg, 'cmd:secur:nav', { as: 'owner', values: ['journal'] });
    assert.match(h.message(jMsg.id).embeds[0].description, new RegExp(`#${incident}`));
    const denied = await h.click(h.message(jMsg.id), 'cmd:secur:restore', { as: 'admin', values: [String(incident)] });
    assert.ok(h.isError(denied), 'administrateur non-owner : restauration acceptée');
    await h.click(h.message(jMsg.id), 'cmd:secur:restore', { as: 'owner', values: [String(incident)] });
    await h.settle();
    assert.ok(h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.gamer), 'rôles non rendus');
    assert.ok(h.client.repositories.securityIncidents.get(h.guild.id, incident).restored_at);
    const pending = await h.slash('secur', sub('panneau'), { as: 'owner' });
    const pMsg = h.messagesOf(pending)[0];
    await h.click(pMsg, 'cmd:secur:nav', { as: 'owner', values: ['attente'] });
    await h.click(h.message(pMsg.id), 'cmd:secur:grantdecide', { as: 'owner', values: [`approve.${grant.id}`] });
    await h.settle();
    assert.ok(h.client.repositories.securityGrants.get(h.guild.id, grant.id).approved_at, 'accès non approuvé');
    assert.equal(h.problemCount(), 0, h.formatProblems());

    // Administrateur non owner : lecture seule, rien ne change.
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).secur);
    const ro = await h.slash('secur', sub('panneau'), { as: 'admin' });
    const [roMsg] = h.messagesOf(ro);
    assert.match(roMsg.embeds[0].description, /Lecture seule/);
    assert.deepEqual(ids(roMsg).filter((id) => /preview|apply/.test(id)), []);
    await explore(h, ro, { as: 'admin', budget: 60 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).secur), before, 'un administrateur non-owner a modifié Secur');
    // Boutons du propriétaire cliqués par l'administrateur : refusés.
    const ownerPanel = await h.slash('secur', sub('panneau'), { as: 'owner' });
    await explore(h, ownerPanel, { as: 'admin', budget: 30, skip: (a) => /:(nav|go)/.test(a.customId) });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).secur), before);

    // Membre : refus en embed (Administrateur requis).
    for (const name of ['panneau', 'on']) {
      const denied = await h.slash('secur', sub(name), { as: 'member' });
      assert.ok(h.isError(denied), `membre : /secur ${name}`);
      assert.ok(h.messagesOf(denied)[0].embeds.length);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/secur on avec AutreBot Administrateur : Appliquer désactivé ; « Ajouter aux bots de confiance » → actif ; double clic → un seul journal', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    loadModule(h);
    await h.asHuman('owner').addRole('otherBot', IDS.roles.admin);
    assert.ok(h.guild.members.cache.get(IDS.users.otherBot).permissions.has('Administrator'));
    const rec = await h.slash('secur', sub('on'), { as: 'owner' });
    let msg = h.messagesOf(rec)[0];
    assert.ok(rec.ackType === 5, '/secur on doit différer (deferReply)');
    assert.match(msg.embeds[0].title, /Protection standard/);
    assert.match(msg.embeds[0].description, new RegExp(IDS.users.otherBot));
    assert.equal(component(msg, 'cmd:secur:apply:on').disabled, true, 'Appliquer actif malgré un bot Administrateur non traité');
    assert.ok(component(msg, 'cmd:secur:apply:on:force'));
    // Un administrateur non owner ne peut pas ajouter le bot.
    const denied = await h.click(msg, 'cmd:secur:trustbots:on', { as: 'admin' });
    assert.ok(h.isError(denied));
    await h.click(msg, 'cmd:secur:trustbots:on', { as: 'owner' });
    msg = h.message(msg.id);
    assert.deepEqual(h.client.services.config.get(h.guild.id).secur.trustedBots, [IDS.users.otherBot]);
    assert.ok(!component(msg, 'cmd:secur:apply:on').disabled, 'Appliquer toujours désactivé');
    // Double clic sur « Appliquer » : une seule écriture, un seul journal.
    const mark = h.fake.messageLog.length;
    const stale = JSON.parse(JSON.stringify(msg));
    await Promise.all([h.click(stale, 'cmd:secur:apply:on', { as: 'owner' }), h.click(stale, 'cmd:secur:apply:on', { as: 'owner' })]);
    await h.settle();
    const cfg = h.client.services.config.get(h.guild.id);
    assert.equal(cfg.secur.modules.channelDelete.mode, 'on');
    assert.equal(cfg.secur.modules.channelDelete.punish, 'derank', 'sanction conservée');
    const journal = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && /Préréglage/.test(m.embeds?.[0]?.description ?? ''));
    assert.equal(journal.length, 1, `${journal.length} ligne(s) securConfig pour un double clic`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('scénario 01 rejoué : /whitelist add de soi par un admin → carte critique et MP au propriétaire ; puis 3 suppressions → alerte et sanction', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { channelDeleteThreshold: 3, destructiveWindowSeconds: 30, punishExecutor: 'strip' } });
    const mark = h.fake.messageLog.length;
    const rec = await h.slash('whitelist', sub('add', [opt('utilisateur', 6, IDS.users.admin)]), { as: 'admin' });
    assert.match(h.replyText(rec), /attente d'approbation/);
    assert.ok(h.client.services.config.get(h.guild.id).whitelist.users.includes(IDS.users.admin), 'whitelist écrite normalement');
    await h.settle();
    assert.equal(inLogs(h, mark, /Accès de whitelist en attente/).length, 1, 'carte critique absente');
    assert.ok(dmsTo(h, mark, IDS.users.owner).some(titled(/Accès de whitelist en attente/)), 'propriétaire non prévenu en MP');
    // Destruction : l'accès en attente n'exempte pas.
    const failed = [];
    for (const key of ['rules', 'announcements', 'staff', 'forum']) await h.asHuman('admin').deleteChannel(IDS.channels[key]).catch((e) => failed.push(e.code));
    await h.settle();
    assert.ok(inLogs(h, mark, /Activité destructrice/).length >= 1, 'destruction non détectée');
    assert.ok(!h.fake.members.get(IDS.users.admin).roles.includes(IDS.roles.admin), 'auteur non sanctionné');
    assert.ok(failed.length >= 1, 'l\'auteur dérangé pouvait encore supprimer');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('scénario 01c : AntiRaid coupé depuis /antiraid → carte et MP au propriétaire, même avec logs.enabled=false ; « Anti-nuke » en éphémère', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ logs: { enabled: false } });
    const mark = h.fake.messageLog.length;
    const dash = await h.slash('antiraid', [], { as: 'admin' });
    const home = h.messagesOf(dash)[0];
    await h.click(home, 'cmd:antiraid:toggle:off', { as: 'admin' });
    await h.settle();
    assert.equal(h.client.services.config.get(h.guild.id).antiraid.enabled, false);
    const card = inLogs(h, mark, /Réglage de sécurité critique/);
    assert.equal(card.length, 1, 'coupure silencieuse');
    assert.match(card[0].embeds[0].description, /AntiRaid désactivé/);
    assert.match(JSON.stringify(card[0].embeds[0].fields), new RegExp(IDS.users.admin));
    assert.ok(dmsTo(h, mark, IDS.users.owner).some((m) => /AntiRaid désactivé/.test(JSON.stringify(m.embeds))), 'propriétaire non prévenu');

    // Bouton « Anti-nuke » (5e de la rangée d'index 1) : réponse éphémère, tableau de bord intact.
    const row = h.message(home.id).components[1].components;
    assert.equal(row[4].custom_id, 'cmd:secur:open:home');
    const before = JSON.stringify(h.message(home.id));
    const opened = await h.click(h.message(home.id), 'cmd:secur:open:home', { as: 'admin' });
    assert.equal(opened.ackType, 4, 'open doit RÉPONDRE');
    assert.ok(h.messagesOf(opened)[0].flags & EPHEMERAL);
    assert.match(h.messagesOf(opened)[0].embeds[0].title, /Secur/);
    assert.equal(JSON.stringify(h.message(home.id)), before);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('verrou : /whitelist add et réglages /antiraid refusés à l\'admin, acceptés pour le propriétaire ; owners et confiance par commande', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    // Owner de sécurité nommé par le propriétaire ; un administrateur ne peut pas.
    const deniedOwner = await h.slash('secur', group('owner', 'ajouter', [opt('membre', 6, IDS.users.mod)]), { as: 'admin' });
    assert.ok(h.isError(deniedOwner));
    const okOwner = await h.slash('secur', group('owner', 'ajouter', [opt('membre', 6, IDS.users.mod)]), { as: 'owner' });
    assert.ok(!h.isError(okOwner), h.replyText(okOwner));
    assert.deepEqual(h.client.services.config.get(h.guild.id).secur.owners, [IDS.users.mod]);
    const botOwner = await h.slash('secur', group('owner', 'ajouter', [opt('membre', 6, IDS.users.otherBot)]), { as: 'owner' });
    assert.match(h.replyText(botOwner), /bot/);
    const human = await h.slash('secur', group('confiance', 'ajouter', [opt('bot', 6, IDS.users.member)]), { as: 'owner' });
    assert.match(h.replyText(human), /n'est pas un bot/);
    const trusted = await h.slash('secur', group('confiance', 'ajouter', [opt('bot', 6, IDS.users.otherBot)]), { as: 'owner' });
    assert.ok(!h.isError(trusted), h.replyText(trusted));

    // Verrou activé depuis le panneau (propriétaire).
    const panel = await h.slash('secur', sub('panneau'), { as: 'owner' });
    await h.click(h.messagesOf(panel)[0], 'cmd:secur:nav', { as: 'owner', values: ['acces'] });
    await h.click(h.messagesOf(panel)[0], 'cmd:secur:verrou:on', { as: 'owner' });
    assert.equal(h.client.services.config.get(h.guild.id).secur.verrou, true);
    const wl = await h.slash('whitelist', sub('add', [opt('utilisateur', 6, IDS.users.target)]), { as: 'admin' });
    assert.ok(h.isError(wl));
    assert.match(h.replyText(wl), /Verrou de Secur actif/);
    const dash = await h.slash('antiraid', [], { as: 'admin' });
    const toggle = await h.click(h.messagesOf(dash)[0], 'cmd:antiraid:toggle:off', { as: 'admin' });
    assert.ok(h.isError(toggle));
    assert.equal(h.client.services.config.get(h.guild.id).antiraid.enabled, true);
    const sim = await h.click(h.messagesOf(dash)[0], 'cmd:antiraid:simulate', { as: 'admin' });
    assert.ok(!h.isError(sim), 'simulation fermée par le verrou');
    // L'owner de sécurité (modérateur) passe le verrou.
    const owner = await h.slash('whitelist', sub('add', [opt('utilisateur', 6, IDS.users.target)]), { as: 'owner' });
    assert.ok(!h.isError(owner), h.replyText(owner));
    assert.ok(h.client.services.config.get(h.guild.id).whitelist.users.includes(IDS.users.target));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
