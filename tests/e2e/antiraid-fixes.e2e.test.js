'use strict';

/**
 * SEC1 — correctifs du chemin historique de l'AntiRaid (Secur coupé), bout en bout : les cinq
 * preuves de la revue sont inversées.
 *  - stale-audit-replay : entrées rejouées après un RESUME, fenêtre sur l'horodatage ;
 *  - paused-security-alert : alerte remise hors filtres des logs, MP sans salon ;
 *  - prune-gap : un prune (audit 21) compte members_removed expulsions ;
 *  - nukebot-strip : bot récent expulsé, bot ancien signalé (bouton « Expulser ce bot ») ;
 *  - wlrole-selfgrant : rôle whitelisté donné par un non-owner en attente d'approbation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { snowflakeAt, nextId, DAY } = require('./lib/ids');
const { explore } = require('./lib/explore');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const dmsTo = (h, mark, userId) => botMessages(h, mark, (m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === userId);
const rolesOf = (h, id) => h.fake.members.get(id)?.roles ?? null;
const DESTRUCTIVE = /Activité destructrice/;

test('stale-audit-replay : 3 suppressions datées de -6, -4 et -2 min reçues d\'un coup → rôles 2 → 2, aucune alerte', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, antiraid: { enabled: true, channelDeleteThreshold: 3, destructiveWindowSeconds: 10, punishExecutor: 'strip' } });
    const before = [...rolesOf(h, IDS.users.mod)];
    const mark = h.fake.messageLog.length;
    const now = Date.now();
    for (const [i, min] of [6, 4, 2].entries()) {
      await h.auditEntry({ action_type: 12, target_id: snowflakeAt(now - DAY, 200 + i), user_id: IDS.users.mod }, { at: now - min * 60_000, label: `rejeu suppression il y a ${min} min` });
    }
    assert.deepEqual(rolesOf(h, IDS.users.mod), before, 'modérateur sanctionné pour des suppressions étalées sur 4 min');
    assert.equal(before.length, 2);
    assert.equal(botMessages(h, mark, titled(DESTRUCTIVE)).length, 0);
    // Contrôle : les mêmes 3 suppressions dans les mêmes 10 s (reçues en retard) déclenchent bien.
    for (let i = 0; i < 3; i += 1) await h.auditEntry({ action_type: 12, target_id: snowflakeAt(now - DAY, 300 + i), user_id: IDS.users.mod }, { at: now - 120_000 + i * 1_000 });
    assert.equal(botMessages(h, mark, titled(DESTRUCTIVE)).length, 1, 'rafale datée non détectée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('paused-security-alert : catégorie Sécurité en pause → 1 message dans les logs sécurité ; sans aucun salon → 1 MP', async () => {
  const h = await createHarness();
  try {
    h.configure({
      logChannels: { security: IDS.channels.logs },
      logs: { disabledCategories: ['security'] },
      antiraid: { enabled: true, alertChannel: null, channelDeleteThreshold: 2, destructiveWindowSeconds: 10, punishExecutor: 'strip' },
    });
    let mark = h.fake.messageLog.length;
    const now = Date.now();
    for (let i = 0; i < 2; i += 1) await h.auditEntry({ action_type: 12, target_id: snowflakeAt(now - DAY, 400 + i), user_id: IDS.users.mod });
    assert.equal(rolesOf(h, IDS.users.mod).length, 0, 'auteur non sanctionné');
    const posted = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && titled(DESTRUCTIVE)(m));
    assert.equal(posted.length, 1, 'alerte filtrée comme un simple log');
    assert.equal(dmsTo(h, mark, IDS.users.owner).length, 1, 'logs en pause : le propriétaire n\'est pas prévenu');

    // Aucun salon (logs sécurité et salon d'alerte débranchés) : MP au propriétaire.
    h.configure({ logChannels: { security: null }, logs: { disabledCategories: [] } });
    mark = h.fake.messageLog.length;
    for (let i = 0; i < 2; i += 1) await h.auditEntry({ action_type: 12, target_id: snowflakeAt(now - DAY, 500 + i), user_id: IDS.users.admin });
    const dms = dmsTo(h, mark, IDS.users.owner);
    assert.equal(dms.length, 1);
    assert.match(dms[0].embeds[0].title, DESTRUCTIVE);
    assert.match(dms[0].content, /ni le salon d'alerte ni les logs sécurité/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('prune-gap : un prune de 742 membres (une seule entrée d\'audit) → alerte et sanction ; prune réel via l\'API', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, antiraid: { enabled: true, kickThreshold: 2, banThreshold: 1, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
    let mark = h.fake.messageLog.length;
    await h.auditEntry({ action_type: 21, target_id: null, user_id: IDS.users.mod, options: { delete_member_days: '1', members_removed: '742' } }, { label: 'prune de 742 membres' });
    const alerts = botMessages(h, mark, titled(DESTRUCTIVE));
    assert.equal(alerts.length, 1, 'prune invisible pour l\'AntiRaid');
    assert.match(alerts[0].embeds[0].fields.find((f) => /Type/.test(f.name)).value, /Expulsions ×\*\*742\*\*/);
    assert.equal(rolesOf(h, IDS.users.mod).length, 0, 'auteur du prune non sanctionné');

    // Prune réel fait par un administrateur dans l'interface : les membres sans rôle expulsés
    // (3 inactifs, plus le modérateur dérangé juste avant).
    for (let i = 0; i < 3; i += 1) await h.memberJoin(h.addUser(`Inactif${i}`, { ageDays: 400 }));
    mark = h.fake.messageLog.length;
    const res = await h.asHuman('admin').prune(7);
    assert.equal(res.pruned, 4);
    assert.equal(botMessages(h, mark, titled(DESTRUCTIVE)).length, 1, 'prune réel non détecté');
    assert.ok(!rolesOf(h, IDS.users.admin).includes(IDS.roles.admin));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/** Rôle géré « NukeBot » (Administrateur) donné au bot tiers, arrivé il y a `joinedDaysAgo` jours. */
async function nukeBot(h, joinedDaysAgo) {
  const G = h.guild.id;
  const roleId = nextId();
  const role = { id: roleId, name: 'NukeBot', color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position: 3, permissions: '8', managed: true, mentionable: false, flags: 0, tags: { bot_id: IDS.users.otherBot } };
  h.fake.roles.set(roleId, role);
  h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: G, role });
  const m = h.fake.members.get(IDS.users.otherBot);
  m.roles = [roleId];
  m.joined_at = new Date(Date.now() - joinedDaysAgo * DAY).toISOString();
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: G, ...m });
  await h.settle();
  return roleId;
}

async function botNukes(h, n = 4) {
  for (const key of ['rules', 'announcements', 'staff', 'forum'].slice(0, n)) {
    const id = IDS.channels[key];
    const ch = h.fake.channels.get(id);
    h.fake.channels.delete(id);
    h.fake.dispatchNow('CHANNEL_DELETE', ch, `suppression de #${ch.name}`);
    await h.auditEntry({ action_type: 12, target_id: id, user_id: IDS.users.otherBot });
  }
}

test('nukebot-strip : bot de nuke arrivé il y a moins de 7 jours → expulsé (le retrait des rôles ne neutralise pas un rôle géré)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
    await nukeBot(h, 2);
    const mark = h.fake.messageLog.length;
    await botNukes(h);
    assert.equal(h.fake.members.has(IDS.users.otherBot), false, 'bot de nuke récent toujours là');
    const alert = botMessages(h, mark, titled(DESTRUCTIVE))[0];
    assert.match(alert.embeds[0].fields.find((f) => /Sanction/.test(f.name)).value, /Bot expulsé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('nukebot-strip : bot ancien → carte « Bot non neutralisé » avec bouton ; clic d\'un admin ayant « Expulser » → expulsé ; double clic → un seul DELETE', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
    await nukeBot(h, 200);
    const mark = h.fake.messageLog.length;
    await botNukes(h);
    assert.ok(h.fake.members.has(IDS.users.otherBot), 'bot ancien expulsé sans demande');
    const alert = botMessages(h, mark, titled(DESTRUCTIVE)).find((m) => m.channel_id === IDS.channels.logs);
    assert.match(alert.embeds[0].fields.find((f) => /Sanction/.test(f.name)).value, /Bot non neutralisé automatiquement/);
    const customId = `secur:kickbot:${IDS.users.otherBot}`;
    assert.ok(h.findComponent(alert, customId), 'bouton « Expulser ce bot » absent');
    const stale = JSON.parse(JSON.stringify(alert));
    // Un membre sans « Expulser » : refusé.
    const denied = await h.click(stale, customId, { as: 'member' });
    assert.ok(h.isError(denied));
    assert.ok(h.fake.members.has(IDS.users.otherBot));
    const deletes = () => h.fake.calls.filter((c) => c.method === 'DELETE' && c.route === `/guilds/${h.guild.id}/members/${IDS.users.otherBot}`).length;
    await Promise.all([h.click(stale, customId, { as: 'admin' }), h.click(stale, customId, { as: 'admin' })]);
    await h.click(stale, customId, { as: 'admin' }); // troisième clic sur l'ancienne carte
    assert.equal(h.fake.members.has(IDS.users.otherBot), false, 'bot non expulsé par le bouton');
    assert.equal(deletes(), 1, `${deletes()} expulsion(s) pour un double clic`);
    assert.equal(h.findComponent(h.message(alert.id), customId), null, 'bouton laissé sur la carte');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('wlrole-selfgrant : rôle whitelisté auto-attribué par un non-owner → carte en attente et MP ; 4 suppressions → alerte et sanction ; approuver → l\'accès exempte', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' }, whitelist: { users: [], roles: [IDS.roles.notif] } });
    const mark = h.fake.messageLog.length;
    // L'administrateur (ni propriétaire ni owner de sécurité) se donne le rôle whitelisté.
    await h.asHuman('admin').addRole('admin', IDS.roles.notif);
    const card = botMessages(h, mark, titled(/Accès de whitelist en attente/)).find((m) => !h.fake.dms.has(m.channel_id));
    assert.ok(card, 'aucune carte d\'accès en attente');
    assert.ok(dmsTo(h, mark, IDS.users.owner).some(titled(/Accès de whitelist en attente/)), 'propriétaire non prévenu en MP');
    const [grant] = h.client.services.secur.pendingGrants(h.guild.id);
    assert.equal(grant.subject_id, IDS.users.admin);
    // Puis il détruit : le rôle fraîchement obtenu n'exempte pas.
    const failed = [];
    for (const key of ['rules', 'announcements', 'staff', 'forum']) await h.asHuman('admin').deleteChannel(IDS.channels[key]).catch((e) => failed.push(e.code));
    assert.equal(botMessages(h, mark, titled(DESTRUCTIVE)).length, 1, 'destruction non détectée malgré l\'accès en attente');
    assert.deepEqual(failed, [50013], 'la 4e suppression aurait dû échouer : l\'auteur a perdu Administrateur');
    assert.ok(!rolesOf(h, IDS.users.admin).includes(IDS.roles.admin), 'auteur non sanctionné');
    // Boutons de la carte : un administrateur non owner est refusé, le propriétaire approuve.
    const approve = `secur:grant:${grant.id}:approve`;
    const refused = await h.click(card, approve, { as: 'admin' });
    assert.ok(h.isError(refused));
    await explore(h, { messages: [card.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] }, { as: 'member', budget: 6 });
    assert.equal(h.client.services.secur.pendingGrants(h.guild.id).length, 1, 'un membre a tranché l\'accès');
    const ok = await h.click(h.message(card.id), approve, { as: 'owner' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(h.client.services.secur.pendingGrants(h.guild.id).length, 0);
    assert.equal(h.client.services.antiraid.isWhitelisted(h.guild.id, IDS.users.admin, [IDS.roles.notif], { excludePending: true }), true, 'accès approuvé : n\'exempte toujours pas');
    assert.deepEqual(h.message(card.id).components, [], 'boutons laissés sur une carte tranchée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
