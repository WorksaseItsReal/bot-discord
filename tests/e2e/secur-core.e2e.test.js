'use strict';

/**
 * SEC1 — Secur, bout en bout : /secur statut, module de test chargé dans le registre (incident,
 * ping, annulations, carte publique et ses boutons), pré-contrôle des commandes de modération.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const dmsTo = (h, mark, userId) => botMessages(h, mark, (m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === userId);
const secur = (sub = 'statut') => [{ name: sub, type: 1, options: [] }];
/** Pseudo-interaction pour explorer les boutons d'un message publié dans un salon. */
const recOf = (h, message) => ({ messages: [message.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] });

test('/secur statut : administrateur (embed, actualiser, exploration) ; membre refusé en embed', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const rec = await h.slash('secur', secur());
    const [reply] = h.messagesOf(rec);
    assert.ok(reply.flags & EPHEMERAL, 'statut public');
    assert.match(reply.embeds[0].title, /Secur · statut/);
    const modules = reply.embeds[0].fields.filter((f) => /Modules/.test(f.name)).map((f) => f.value).join('\n');
    const loaded = h.client.services.secur.registry.modules.size;
    assert.equal((modules.match(/non disponible/g) ?? []).length, 18 - loaded, 'module non chargé : « non disponible »');
    await explore(h, rec, { budget: 10 });
    const denied = await h.slash('secur', secur(), { as: 'member' });
    assert.ok(h.isError(denied), 'membre sans Administrateur');
    assert.ok(h.messagesOf(denied)[0].embeds.length);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('module de test en « on » : un incident, un seul ping (allowed_mentions explicites), annulations ; « Ouvrir Secur » en éphémère ; « Rendre les rôles » une seule fois', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const undone = [];
    h.client.services.secur.registry.register({
      key: 'channelDelete',
      auditTypes: [12],
      priority: 3,
      classify: (entry) => ({ weight: 1, record: { channelId: entry.targetId } }),
      undo: async (_guild, record) => {
        undone.push(record.channelId);
        return { ok: true };
      },
      targetKey: (record) => record.channelId,
    });
    h.configure({ secur: { raidPingRoleId: IDS.roles.notif, modules: { channelDelete: { mode: 'on', limit: 2, windowSeconds: 30 } } } });
    assert.ok(h.client.services.secur.covers(h.guild.id, 'channelDelete'));
    const mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    const failed = [];
    for (const key of ['rules', 'announcements', 'forum']) await h.asHuman('admin').deleteChannel(IDS.channels[key]).catch((e) => failed.push(e.code));
    await h.settle();
    assert.deepEqual(failed, [50013], 'l\'auteur dérangé ne devait plus pouvoir supprimer');
    const [incident, ...more] = h.client.repositories.securityIncidents.recent(h.guild.id, 5);
    assert.equal(more.length, 0, 'plusieurs incidents pour un même auteur');
    assert.equal(incident.punishment, 'derank');
    assert.deepEqual(incident.removed_roles.sort(), [IDS.roles.admin, IDS.roles.member].sort());
    assert.deepEqual(undone.sort(), [IDS.channels.rules, IDS.channels.announcements].sort());
    assert.equal(botMessages(h, mark, titled(/Activité destructrice/)).length, 0, 'chemin historique ET module Secur');
    // Une seule carte, un seul ping, mentions explicites.
    const cards = botMessages(h, mark, titled(/Incident Secur/)).filter((m) => !h.fake.dms.has(m.channel_id));
    assert.equal(cards.length, 1);
    const pings = h.fake.calls.slice(callMark).filter((c) => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.route) && (c.body?.content ?? '').includes(`<@&${IDS.roles.notif}>`));
    assert.equal(pings.length, 1, `${pings.length} ping(s) du rôle d'alerte`);
    assert.deepEqual(pings[0].body.allowed_mentions, { parse: [], roles: [IDS.roles.notif] });
    assert.ok(dmsTo(h, mark, IDS.users.owner).some(titled(/Incident Secur/)), 'propriétaire non prévenu en MP');
    const card = h.message(cards[0].id);
    assert.match(card.embeds[0].fields.find((f) => /Annulations/.test(f.name)).value, /\*\*2\*\*\/2/);

    // « Ouvrir Secur » depuis la carte publique : réponse éphémère, carte intacte.
    const before = JSON.stringify(card);
    const opened = await h.click(card, 'cmd:secur:open:home', { as: 'owner' });
    assert.equal(opened.ackType, 4, 'open doit RÉPONDRE (jamais update)');
    assert.ok(h.messagesOf(opened)[0].flags & EPHEMERAL);
    assert.match(h.messagesOf(opened)[0].embeds[0].title, /Secur · statut/);
    assert.equal(JSON.stringify(h.message(card.id)), before, 'carte d\'incident remplacée');

    // Boutons explorés par un membre : tout est refusé, rien ne change.
    await explore(h, recOf(h, card), { as: 'member', budget: 8 });
    assert.equal(h.client.repositories.securityIncidents.get(h.guild.id, incident.id).restored_at, null);

    // « Rendre les rôles » : double clic du propriétaire → un seul effet.
    const restore = `secur:restore:${incident.id}`;
    const stale = JSON.parse(JSON.stringify(h.message(card.id)));
    const puts = () => h.fake.calls.filter((c) => c.method === 'PUT' && c.route.startsWith(`/guilds/${h.guild.id}/members/${IDS.users.admin}/roles/`)).length;
    const putMark = puts();
    await Promise.all([h.click(stale, restore, { as: 'owner' }), h.click(stale, restore, { as: 'owner' })]);
    const again = await h.click(stale, restore, { as: 'owner' });
    assert.match(h.replyText(again), /déjà été restauré/);
    assert.equal(puts() - putMark, 2, 'rôles rendus plusieurs fois');
    assert.ok(h.fake.members.get(IDS.users.admin).roles.includes(IDS.roles.admin));
    assert.equal(h.findComponent(h.message(card.id), restore), null, 'bouton laissé après la restauration');
    assert.match(h.message(card.id).embeds[0].fields.map((f) => f.name).join(' '), /Rôles rendus/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('pré-contrôle : /ban d\'un admin non exempté à la limite → refus en embed AVANT toute requête de bannissement (AntiRaid, puis module Secur)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false }, antiraid: { enabled: true, banThreshold: 1 } });
    // Membre ancien (un arrivant récent, raider présumé, ne serait pas compté).
    const target = { id: IDS.users.member };
    const mark = h.fake.calls.length;
    const rec = await h.slash('ban', [{ name: 'membre', type: 6, value: target.id }], { as: 'admin' });
    assert.ok(h.isError(rec), 'ban au seuil exécuté');
    assert.match(h.replyText(rec), /Action bloquée par la sécurité \(Bannissements\)/);
    const writes = h.fake.calls.slice(mark).filter((c) => c.method !== 'GET' && c.route.startsWith(`/guilds/${h.guild.id}/`));
    assert.deepEqual(writes.map((c) => `${c.method} ${c.route}`), [], 'requête envoyée à Discord malgré le refus');
    assert.ok(h.fake.members.has(target.id));

    // Module Secur « ban » (limite 2) : le 1er ban passe et est compté, le 2e est refusé.
    if (!h.client.services.secur.registry.has('ban')) h.client.services.secur.registry.register({ key: 'ban', auditTypes: [22], classify: () => ({ weight: 1, record: null }) });
    h.configure({ secur: { modules: { ban: { mode: 'on', limit: 2 } } } });
    const first = await h.slash('ban', [{ name: 'membre', type: 6, value: target.id }], { as: 'admin' });
    assert.ok(!h.isError(first), h.replyText(first));
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.admin, 'ban'), 1, 'ban fait via le bot non compté');
    const second = await h.slash('ban', [{ name: 'membre', type: 6, value: IDS.users.target }], { as: 'admin' });
    assert.ok(h.isError(second));
    assert.match(h.replyText(second), /Action bloquée par la sécurité \(Bannissements\)/);
    assert.ok(h.fake.members.has(IDS.users.target));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
