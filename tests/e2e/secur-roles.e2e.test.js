'use strict';

/**
 * SEC4 — modules Secur « rôles », bout en bout (vrai bot, faux Discord) : @everyone passé
 * Administrateur, rôle supprimé (membres, surcharges, références de configuration), rôle géré
 * jamais recréé, rôles sensibles donnés ou retirés en masse, rôles retirés au bot, rôle créé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const incidentCards = (h, mark) => botMessages(h, mark, titled(/Incident Secur/)).filter((m) => !h.fake.dms.has(m.channel_id));
const incidents = (h) => h.client.repositories.securityIncidents.recent(h.guild.id, 20);
const setModules = (h, modules) => h.configure({ secur: { modules } });
const roleNamed = (h, name) => [...h.fake.roles.values()].find((r) => r.name === name) ?? null;
const rolesOf = (h, key) => h.fake.members.get(IDS.users[key] ?? key)?.roles ?? [];
const recOf = (h, message) => ({ messages: [message.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] });

test('@everyone passé Administrateur (audit 31) → rétabli ; changement anodin ignoré en « on », rétabli en « max »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { roleUpdate: { mode: 'on' } });
    const everyone = h.fake.roles.get(IDS.roles.everyone);
    const before = everyone.permissions;
    await h.asHuman('admin').editRole(IDS.roles.gamer, { color: 0x123456 });
    await h.settle();
    assert.equal(incidents(h).length, 0, 'couleur comptée en « on »');
    assert.equal(h.fake.roles.get(IDS.roles.gamer).color, 0x123456);
    const mark = h.fake.messageLog.length;
    await h.asHuman('admin').editRole(IDS.roles.everyone, { permissions: String(BigInt(before) | P.Administrator) });
    await h.settle();
    assert.equal(h.fake.roles.get(IDS.roles.everyone).permissions, before, '@everyone toujours Administrateur');
    assert.equal(h.guild.roles.everyone.permissions.has(P.Administrator), false);
    const [incident] = incidents(h);
    assert.deepEqual(incident.modules, ['roleUpdate']);
    assert.equal(incident.undone, 1);
    assert.ok(!rolesOf(h, 'admin').includes(IDS.roles.admin), 'auteur non dérangé');
    assert.equal(incidentCards(h, mark).length, 1);
    await explore(h, recOf(h, incidentCards(h, mark)[0]), { as: 'member', budget: 6 });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }

  const m = await createHarness();
  try {
    m.configureAll();
    setModules(m, { roleUpdate: { mode: 'max' } });
    await m.asHuman('admin').editRole(IDS.roles.gamer, { name: 'Pirates', color: 0x123456 });
    await m.settle();
    const gamer = m.fake.roles.get(IDS.roles.gamer);
    assert.equal(gamer.name, 'Joueur', 'nom non rétabli en « max »');
    assert.equal(gamer.color, 0x3498db, 'couleur non rétablie en « max »');
    assert.equal(m.problemCount(), 0, m.formatProblems());
  } finally {
    await m.close();
  }
});

test('rôle supprimé → recréé avec ses membres, ses surcharges et ses références de configuration', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { roleDelete: { mode: 'on' } });
    const g = h.guild;
    // État de départ (fait par le bot) : rôle « Notifications » porté par deux membres, surcharge sur #général.
    for (const key of ['member', 'target']) await g.members.cache.get(IDS.users[key]).roles.add(IDS.roles.notif);
    await g.channels.cache.get(IDS.channels.general).permissionOverwrites.create(IDS.roles.notif, { AddReactions: false, AttachFiles: true });
    await h.settle();
    assert.equal(h.client.services.config.get(g.id).levels.rewards[0].roleId, IDS.roles.notif);
    // Garde : discord.js ne nettoie pas member._roles à la suppression d'un rôle (source des membres).
    assert.ok(Array.isArray(g.members.cache.get(IDS.users.member)._roles), 'member._roles a disparu de discord.js');

    let kept = null;
    h.client.once('roleDelete', (deleted) => {
      kept = g.members.cache.get(IDS.users.member)._roles.includes(deleted.id);
    });
    await h.asHuman('admin').deleteRole(IDS.roles.notif);
    await h.settle();
    assert.equal(kept, true, 'member._roles nettoyé à la suppression du rôle : la source des membres d\'un rôle supprimé a changé');
    const role = roleNamed(h, 'Notifications');
    assert.ok(role, 'rôle non recréé');
    assert.notEqual(role.id, IDS.roles.notif);
    assert.equal(role.mentionable, true);
    for (const key of ['member', 'target']) assert.ok(rolesOf(h, key).includes(role.id), `${key} n'a pas retrouvé le rôle`);
    const ow = h.fake.channels.get(IDS.channels.general).permission_overwrites.find((o) => o.id === role.id);
    assert.ok(ow, 'surcharge non recréée');
    assert.equal(BigInt(ow.deny) & P.AddReactions, P.AddReactions);
    assert.equal(BigInt(ow.allow) & P.AttachFiles, P.AttachFiles);
    assert.equal(h.client.services.config.get(g.id).levels.rewards[0].roleId, role.id, 'référence de configuration non reportée');
    const [incident] = incidents(h);
    assert.match(incident.outcome, /Rôles recréés : 1 \(membres rendus : 2\/2 ; surcharges : 1 ; références de configuration : 1\)/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('rôle géré supprimé (bot expulsé) → rien n\'est recréé ni compté', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { roleDelete: { mode: 'on' }, roleCreate: { mode: 'on' } });
    const g = h.guild;
    const managed = { id: '910000000000000001', name: 'AutreBot', color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position: 1, permissions: String(P.Administrator), managed: true, mentionable: false, flags: 0, tags: { bot_id: IDS.users.otherBot } };
    h.fake.roles.set(managed.id, managed);
    h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: g.id, role: managed });
    await h.auditEntry({ action_type: 30, target_id: managed.id, user_id: IDS.users.admin });
    assert.equal(incidents(h).length, 0, 'rôle géré créé compté');
    const mark = h.fake.calls.length;
    // Discord retire le rôle d'intégration quand le bot part, et peut l'attribuer à l'humain qui l'a expulsé.
    h.fake.deleteRole(managed.id);
    await h.auditEntry({ action_type: 32, target_id: managed.id, user_id: IDS.users.admin });
    await h.settle();
    assert.equal(h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && /\/roles$/.test(c.route)).length, 0, 'rôle géré recréé');
    assert.equal(incidents(h).length, 0, 'suppression d\'un rôle géré comptée');
    assert.ok(rolesOf(h, 'admin').includes(IDS.roles.admin));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('rôle de niveau 1 donné → aucune sanction ; rôle sensible donné à un complice → retiré, auteur dérangé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { roleAdd: { mode: 'on' } });
    // Niveaux de délégation (ADM1) : « Joueur » au niveau 1, « Notifications » au niveau 2.
    h.client.services.permissions = { levelOf: (_g, roleId) => ({ [IDS.roles.gamer]: 1, [IDS.roles.notif]: 2 }[roleId] ?? 0) };
    await h.asHuman('admin').addRole('target', IDS.roles.gamer);
    assert.ok(rolesOf(h, 'target').includes(IDS.roles.gamer), 'rôle de niveau 1 retiré');
    assert.equal(incidents(h).length, 0, 'rôle de niveau 1 sanctionné');
    const mark = h.fake.messageLog.length;
    await h.asHuman('admin').addRole('target', IDS.roles.mod);
    await h.settle();
    assert.ok(!rolesOf(h, 'target').includes(IDS.roles.mod), 'rôle sensible laissé au complice');
    assert.ok(!rolesOf(h, 'admin').includes(IDS.roles.admin), 'auteur non dérangé');
    const [incident] = incidents(h);
    assert.deepEqual(incident.modules, ['roleAdd']);
    assert.equal(incidentCards(h, mark).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }

  // Rôle de niveau 2 : sensible, même sans permission dangereuse.
  const m = await createHarness();
  try {
    m.configureAll();
    setModules(m, { roleAdd: { mode: 'on' } });
    m.client.services.permissions = { levelOf: (_g, roleId) => (roleId === IDS.roles.notif ? 2 : 0) };
    await m.asHuman('admin').addRole('target', IDS.roles.notif);
    await m.settle();
    assert.ok(!rolesOf(m, 'target').includes(IDS.roles.notif), 'rôle de niveau 2 laissé');
    assert.equal(incidents(m).length, 1);
    assert.equal(m.problemCount(), 0, m.formatProblems());
  } finally {
    await m.close();
  }
});

test('3 retraits de rôles staff en 10 s (dont un PATCH) → rôles rendus, auteur dérangé ; rôle retiré au bot → incident d\'emblée et rôle rendu', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    setModules(h, { roleRemove: { mode: 'on' } });
    const g = h.guild;
    for (const key of ['member', 'target']) await g.members.cache.get(IDS.users[key]).roles.add(IDS.roles.mod);
    await h.settle();
    await h.asHuman('admin').removeRole('mod', IDS.roles.mod);
    await h.asHuman('admin').removeRole('member', IDS.roles.mod);
    assert.equal(incidents(h).length, 0, 'sous la limite de 3 : rien');
    const target = h.fake.members.get(IDS.users.target);
    await h.asHuman('admin').perform('PATCH', `/guilds/${g.id}/members/${IDS.users.target}`, { roles: target.roles.filter((r) => r !== IDS.roles.mod) });
    await h.settle();
    for (const key of ['mod', 'member', 'target']) assert.ok(rolesOf(h, key).includes(IDS.roles.mod), `rôle staff non rendu à ${key}`);
    assert.ok(!rolesOf(h, 'admin').includes(IDS.roles.admin), 'auteur non dérangé');
    const [incident] = incidents(h);
    assert.deepEqual(incident.modules, ['roleRemove']);
    assert.equal(incident.actions, 3);
    assert.equal(incident.undone, 3);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }

  const b = await createHarness();
  try {
    b.configureAll();
    setModules(b, { roleRemove: { mode: 'on' } });
    await b.guild.members.me.roles.add(IDS.roles.notif);
    await b.settle();
    await b.asHuman('admin').removeRole('bot', IDS.roles.notif);
    await b.settle();
    assert.ok(rolesOf(b, 'bot').includes(IDS.roles.notif), 'rôle du bot non rendu');
    const [incident] = incidents(b);
    assert.ok(incident, 'rôle retiré au bot : aucun incident');
    assert.equal(incident.punishment, 'derank');
    assert.equal(b.problemCount(), 0, b.formatProblems());
  } finally {
    await b.close();
  }
});

test('rôle créé en « on » → supprimé ; le même par un whitelisté : rien en « on », supprimé en « max »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ whitelist: { users: [IDS.users.mod] } });
    h.fake.roles.get(IDS.roles.mod).permissions = String(BigInt(h.fake.roles.get(IDS.roles.mod).permissions) | P.ManageRoles);
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role: h.fake.roles.get(IDS.roles.mod) });
    setModules(h, { roleCreate: { mode: 'on' } });
    const kept = await h.asHuman('mod').perform('POST', `/guilds/${h.guild.id}/roles`, { name: 'Légitime', permissions: '0' });
    await h.settle();
    assert.ok(h.fake.roles.has(kept.id), 'rôle d\'un whitelisté supprimé en « on »');
    const spam = await h.asHuman('admin').perform('POST', `/guilds/${h.guild.id}/roles`, { name: 'Raid', permissions: '0' });
    await h.settle();
    assert.equal(h.fake.roles.has(spam.id), false, 'rôle créé non supprimé');
    setModules(h, { roleCreate: { mode: 'max' } });
    const again = await h.asHuman('mod').perform('POST', `/guilds/${h.guild.id}/roles`, { name: 'En max', permissions: '0' });
    await h.settle();
    assert.equal(h.fake.roles.has(again.id), false, 'rôle d\'un whitelisté gardé en « max »');
    assert.equal(incidents(h).length, 2);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
