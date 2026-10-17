'use strict';

/**
 * SEC5 — pré-blocage des destructions faites via le bot, de bout en bout : /logs remove
 * (logs-remove-bypass inversée, « Gérer les salons » natif, refus d'emblée de N suppressions,
 * journal critique de la catégorie Sécurité), /compteurs, /activite (expulsion groupée),
 * /massrole remove et /derank (roleRemove), /role delete, /backup restore.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { rawMember } = require('./lib/fixtures');
const { snowflakeAt, DAY } = require('./lib/ids');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const dmsTo = (h, mark, userId) => botMessages(h, mark, (m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === userId);
const destructiveAlerts = (h, mark) => botMessages(h, mark, titled(/destructrice/i));
const channelDeletes = (h, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'DELETE' && /^\/channels\/\d+$/.test(c.route));
const rolesOf = (h, id) => h.fake.members.get(id)?.roles ?? [];
const everyoneDeny = () => ({ id: IDS.roles.everyone, type: 0, allow: '0', deny: String(P.ViewChannel) });

async function panelOf(h, command, as) {
  h.client.cooldowns?.expiries?.clear?.();
  const rec = await h.slash(command, [], { as });
  assert.ok(!h.isError(rec), `/${command} refusé à ${as} : ${h.replyText(rec)}`);
  return h.messagesOf(rec).at(-1);
}

/** Membre ajouté sans événement d'arrivée, arrivé il y a `joinedDaysAgo` jours. */
function addSleeper(h, name, { joinedDaysAgo = 100, roles = [] } = {}) {
  const user = h.addUser(name, { ageDays: 500 });
  const raw = rawMember(user, roles, joinedDaysAgo);
  h.fake.members.set(user.id, raw);
  h.guild.members._add(JSON.parse(JSON.stringify(raw)));
  return user.id;
}

/** Salons de logs « créés par le bot » il y a deux jours (catégorie + `n` salons, avec leur historique). */
async function oldLogChannels(h, n) {
  const old = (i) => snowflakeAt(Date.now() - 2 * DAY, 3000 + i);
  const category = old(0);
  const rawCat = { id: category, type: 4, guild_id: h.guild.id, name: '📋 Logs', position: 20, permission_overwrites: [everyoneDeny()], parent_id: null, flags: 0 };
  h.fake.channels.set(category, rawCat);
  h.fake.dispatchNow('CHANNEL_CREATE', rawCat, 'catégorie de logs');
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const raw = { id: old(i), type: 0, guild_id: h.guild.id, name: `logs-${i}`, position: 60 + i, permission_overwrites: [everyoneDeny()], parent_id: category, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0 };
    h.fake.channels.set(raw.id, raw);
    h.fake.dispatchNow('CHANNEL_CREATE', raw, `salon ${raw.name}`);
    ids.push(raw.id);
  }
  await h.settle();
  h.configure({ logChannels: { security: ids[0], moderation: ids[1] }, logs: { categoryId: category, createdChannels: ids } });
  return { category, ids };
}

/** Module Secur minimal (si SEC4 ne l'a pas encore livré) : le pré-contrôle ne dépend que du registre et de la fenêtre. */
function ensureModule(h, key, auditTypes) {
  const registry = h.client.services.secur.registry;
  if (!registry.has(key)) registry.register({ key, auditTypes, classify: () => ({ weight: 1, record: null }) });
}

// ---------------------------------------------------------------- /logs

test('logs-remove-bypass inversée : « Gérer le serveur » sans « Gérer les salons » → refus en embed, 0 DELETE, salon Sécurité intact', async () => {
  const h = await createHarness();
  try {
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 1, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
    const owner = await panelOf(h, 'logs', 'owner');
    await h.click(owner, 'cmd:logs:go:setup', { as: 'owner' });
    await h.click(owner, 'cmd:logs:create', { as: 'owner' });
    const cfg0 = h.client.services.config.get(h.guild.id);
    assert.ok(cfg0.logs.createdChannels.length >= 9 && cfg0.logChannels.security);
    // Le rôle Modérateur reçoit « Gérer le serveur », pas « Gérer les salons ».
    const role = h.fake.roles.get(IDS.roles.mod);
    role.permissions = String(BigInt(role.permissions) | P.ManageGuild);
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role });
    await h.settle();

    const mark = h.fake.calls.length;
    const panel = await panelOf(h, 'logs', 'mod');
    await h.click(panel, 'cmd:logs:go:setup', { as: 'mod' });
    const go = await h.click(panel, 'cmd:logs:go:confirmRemove', { as: 'mod' });
    assert.ok(h.isError(go), 'confirmation de suppression affichée');
    assert.ok(h.messagesOf(go).at(-1).embeds.length, 'refus sans embed');
    // Bouton forgé (ancien panneau) : refusé aussi.
    const rm = await h.click(panel, 'cmd:logs:remove', { as: 'mod' });
    assert.ok(h.isError(rm), 'suppression acceptée');
    assert.equal(channelDeletes(h, mark).length, 0, 'DELETE envoyés');
    const cfg1 = h.client.services.config.get(h.guild.id);
    assert.equal(cfg1.logChannels.security, cfg0.logChannels.security, 'logChannels.security modifié');
    assert.ok(cfg0.logs.createdChannels.every((id) => h.fake.channels.has(id)));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/logs remove : administrateur non whitelisté, AntiRaid au seuil 3, 9 salons anciens → refus d\'emblée (0 DELETE) ; le propriétaire passe', async () => {
  const h = await createHarness();
  try {
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
    const { category, ids } = await oldLogChannels(h, 9);
    let mark = h.fake.calls.length;
    const msgMark = h.fake.messageLog.length;
    const panel = await panelOf(h, 'logs', 'admin');
    await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
    const go = await h.click(panel, 'cmd:logs:go:confirmRemove', { as: 'admin' });
    assert.ok(!h.isError(go), h.replyText(go));
    const rm = await h.click(panel, 'cmd:logs:remove', { as: 'admin' });
    assert.ok(h.isError(rm), 'suppression de 10 salons au seuil 3 acceptée');
    assert.match(h.replyText(rm), /Action bloquée par la sécurité \(Suppression de salons\) : 10 action\(s\)/);
    assert.equal(channelDeletes(h, mark).length, 0, 'suppression partielle');
    assert.equal(destructiveAlerts(h, msgMark).length, 0);
    assert.ok(rolesOf(h, IDS.users.admin).includes(IDS.roles.admin), 'administrateur dérangé pour une demande refusée');
    assert.ok(botMessages(h, msgMark, titled(/Action bloquée par la sécurité/)).length >= 1, 'aucun log « Action bloquée »');

    mark = h.fake.calls.length;
    const ownerPanel = await panelOf(h, 'logs', 'owner');
    await h.click(ownerPanel, 'cmd:logs:go:setup', { as: 'owner' });
    await h.click(ownerPanel, 'cmd:logs:go:confirmRemove', { as: 'owner' });
    const ok = await h.click(ownerPanel, 'cmd:logs:remove', { as: 'owner' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(channelDeletes(h, mark).length, 10);
    for (const id of [...ids, category]) assert.ok(!h.fake.channels.has(id));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/logs : catégorie Sécurité mise en pause → carte critique (salon Sécurité) et MP au propriétaire ; reprise → simple journal', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs, moderation: IDS.channels.modLog }, antiraid: { alertChannel: null } });
    const mark = h.fake.messageLog.length;
    const panel = await panelOf(h, 'logs', 'admin');
    await h.click(panel, 'cmd:logs:nav', { as: 'admin', values: ['cat:security'] });
    const pause = await h.click(panel, 'cmd:logs:pause:security:on', { as: 'admin' });
    assert.ok(!h.isError(pause), h.replyText(pause));
    assert.ok(h.client.services.config.get(h.guild.id).logs.disabledCategories.includes('security'));
    const critical = titled(/Réglage de sécurité critique modifié/);
    const posted = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && critical(m));
    assert.equal(posted.length, 1, 'carte critique absente du salon Sécurité (hors filtres)');
    assert.match(JSON.stringify(posted[0].embeds), /Catégorie de logs Sécurité mise en pause/);
    assert.equal(dmsTo(h, mark, IDS.users.owner).filter(critical).length, 1, 'propriétaire non prévenu en MP');

    // Événements de sécurité coupés (menu) : critique aussi ; reprise de la catégorie : non critique.
    const m2 = h.fake.messageLog.length;
    await h.click(panel, 'cmd:logs:events:security', { as: 'admin', values: ['lockdown'] });
    assert.ok(botMessages(h, m2, critical).length >= 1, 'événements antiraid/secur coupés sans alerte');
    const m3 = h.fake.messageLog.length;
    await h.click(panel, 'cmd:logs:pause:security:off', { as: 'admin' });
    assert.equal(botMessages(h, m3, critical).length, 0, 'reprise signalée comme critique');
    // Logs coupés pour tout le serveur : critique.
    const m4 = h.fake.messageLog.length;
    await h.click(panel, 'cmd:logs:go:home', { as: 'admin' });
    await h.click(panel, 'cmd:logs:toggle:off', { as: 'admin' });
    assert.ok(dmsTo(h, m4, IDS.users.owner).some((m) => /Logs désactivés/.test(JSON.stringify(m.embeds))), 'logs coupés sans MP');
    await explore(h, { messages: [panel.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] }, { as: 'member', budget: 6 });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- /compteurs

test('/compteurs : « Tout supprimer » au seuil → refus d\'emblée (0 DELETE), le propriétaire passe ; « présences non mises en cache »', async () => {
  const h = await createHarness();
  try {
    h.client.presenceCacheDisabled = true;
    h.configure({
      antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' },
      statsCounters: {
        categoryId: IDS.channels.catVoice,
        counters: {
          members: { enabled: true, channelId: IDS.channels.voice },
          humans: { enabled: true, channelId: IDS.channels.hub },
          bots: { enabled: true, channelId: IDS.channels.stage },
        },
      },
    });
    const panel = await panelOf(h, 'compteurs', 'admin');
    assert.match(JSON.stringify(panel.embeds), /présences non mises en cache/);
    assert.doesNotMatch(JSON.stringify(panel.embeds), /intent GuildPresences n'est pas activé/);
    const mark = h.fake.calls.length;
    await h.click(panel, 'cmd:compteurs:go:confirmRemove', { as: 'admin' });
    const rm = await h.click(panel, 'cmd:compteurs:remove', { as: 'admin' });
    assert.ok(h.isError(rm), '4 suppressions au seuil 3 acceptées');
    assert.match(h.replyText(rm), /Action bloquée par la sécurité \(Suppression de salons\) : 4 action\(s\)/);
    assert.equal(channelDeletes(h, mark).length, 0);
    // « Désactiver » un seul compteur : 1 suppression, sous le seuil → accepté et rapporté.
    await h.click(panel, 'cmd:compteurs:go:home', { as: 'admin' });
    await h.click(panel, 'cmd:compteurs:pick', { as: 'admin', values: ['bots'] });
    const off = await h.click(panel, 'cmd:compteurs:toggle:bots:off', { as: 'admin' });
    assert.ok(!h.isError(off), h.replyText(off));
    assert.ok(!h.fake.channels.has(IDS.channels.stage));

    const ownerPanel = await panelOf(h, 'compteurs', 'owner');
    await h.click(ownerPanel, 'cmd:compteurs:go:confirmRemove', { as: 'owner' });
    const ok = await h.click(ownerPanel, 'cmd:compteurs:remove', { as: 'owner' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.ok(!h.fake.channels.has(IDS.channels.voice) && !h.fake.channels.has(IDS.channels.hub));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- /activite

test('/activite : expulser 10 inactifs — admin non exempté (seuil 3) → refus avant tout kick ; whitelisté → 10 expulsions sans dérangement', async () => {
  const h = await createHarness();
  const G = h.guild.id;
  try {
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, kickThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' }, logChannels: { security: IDS.channels.logs, moderation: IDS.channels.modLog } });
    h.client.repositories.activity.setSince(G, Date.now() - 60 * DAY);
    const day = new Date().toISOString().slice(0, 10);
    h.client.repositories.activity.applyBatch({ messages: [...h.fake.members.keys()].map((userId) => ({ guildId: G, day, channelId: IDS.channels.general, userId, count: 1 })) });
    const sleepers = Array.from({ length: 10 }, (_, i) => addSleeper(h, `Dormeur${i}`));
    const kickRun = async () => {
      h.client.cooldowns?.expiries?.clear?.();
      const list = await h.slash('activite', [], { as: 'admin' });
      const ask = await h.click(h.messagesOf(list)[0], 'cmd:activite:act:30:kick', { as: 'admin' });
      const formId = buttonsOf(h.messagesOf(ask)[0]).map((c) => c.custom_id).find((cid) => cid?.startsWith('cmd:activite:kickform:30:'));
      assert.ok(formId, 'bouton « Expulser… » absent');
      const form = await h.click(h.messagesOf(ask)[0], formId, { as: 'admin' });
      return h.submitModal(form, { confirmation: 'EXPULSER', raison: '' }, { as: 'admin' });
    };
    let mark = h.fake.messageLog.length;
    const refused = await kickRun();
    assert.ok(h.isError(refused), 'expulsion groupée de 10 membres au seuil 3 acceptée');
    assert.match(h.replyText(refused), /Action bloquée par la sécurité \(Expulsions\) : 10 action\(s\)/);
    assert.ok(sleepers.every((id) => h.fake.members.has(id)), 'kick envoyé malgré le refus');
    assert.equal(destructiveAlerts(h, mark).length, 0);
    assert.ok(rolesOf(h, IDS.users.admin).includes(IDS.roles.admin));

    h.configure({ whitelist: { users: [IDS.users.admin], roles: [] } });
    mark = h.fake.messageLog.length;
    const done = await kickRun();
    assert.ok(!h.isError(done), h.replyText(done));
    assert.ok(sleepers.every((id) => !h.fake.members.has(id)), 'whitelisté : expulsions non faites');
    assert.equal(destructiveAlerts(h, mark).length, 0, 'whitelisté dérangé');
    assert.ok(rolesOf(h, IDS.users.admin).includes(IDS.roles.admin));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- /massrole, /derank

test('roleRemove : /massrole remove d\'un rôle staff sur 5 membres (on) → refus d\'emblée ; /derank d\'un modérateur → refus à la limite', async () => {
  const h = await createHarness();
  try {
    ensureModule(h, 'roleRemove', [25]);
    h.configure({ moderation: { confirmDangerous: false }, secur: { modules: { roleRemove: { mode: 'on', limit: 3 } } }, logChannels: { security: IDS.channels.logs } });
    const staff = [IDS.users.mod, ...Array.from({ length: 4 }, (_, i) => addSleeper(h, `Modo${i}`, { roles: [IDS.roles.mod] }))];
    const mark = h.fake.calls.length;
    const rec = await h.slash('massrole', [opt('action', 3, 'remove'), opt('role', 8, IDS.roles.mod)], { as: 'admin' });
    assert.ok(h.isError(rec), 'retrait du rôle staff à 5 membres accepté');
    assert.match(h.replyText(rec), /Action bloquée par la sécurité \(Rôles retirés en masse\) : 5 action\(s\)/);
    assert.ok(staff.every((id) => rolesOf(h, id).includes(IDS.roles.mod)), 'rôle retiré malgré le refus');
    assert.equal(h.fake.calls.slice(mark).filter((c) => c.method !== 'GET' && /\/members\/\d+(\/roles\/\d+)?$/.test(c.route)).length, 0);

    // /derank (limite 2) : le premier passe et compte au nom de l'auteur, le second est refusé.
    h.configure({ secur: { modules: { roleRemove: { mode: 'on', limit: 2 } } } });
    const first = await h.slash('derank', [opt('membre', 6, staff[1])], { as: 'admin' });
    assert.ok(!h.isError(first), h.replyText(first));
    assert.deepEqual(rolesOf(h, staff[1]), []);
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.admin, 'roleRemove'), 1, 'derank via le bot non compté');
    const second = await h.slash('derank', [opt('membre', 6, staff[2])], { as: 'admin' });
    assert.ok(h.isError(second), 'derank au seuil accepté');
    assert.match(h.replyText(second), /Action bloquée par la sécurité \(Rôles retirés en masse\)/);
    assert.ok(rolesOf(h, staff[2]).includes(IDS.roles.mod));
    // Le propriétaire n'est jamais bloqué.
    const owner = await h.slash('derank', [opt('membre', 6, staff[2])], { as: 'owner' });
    assert.ok(!h.isError(owner), h.replyText(owner));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/role add d\'un rôle whitelisté par un non-owner → accès en attente (carte) ; /role remove d\'un rôle staff compté (roleRemove)', async () => {
  const h = await createHarness();
  try {
    ensureModule(h, 'roleRemove', [25]);
    h.configure({ whitelist: { users: [], roles: [IDS.roles.notif] }, logChannels: { security: IDS.channels.logs }, secur: { modules: { roleRemove: { mode: 'on', limit: 3 } } } });
    const mark = h.fake.messageLog.length;
    const add = await h.slash('role', sub('add', [opt('membre', 6, IDS.users.target), opt('role', 8, IDS.roles.notif)]), { as: 'admin' });
    assert.ok(!h.isError(add), h.replyText(add));
    const [grant] = h.client.services.secur.pendingGrants(h.guild.id);
    assert.ok(grant, 'accès en attente non créé');
    assert.equal(grant.subject_id, IDS.users.target);
    assert.equal(grant.granted_by, IDS.users.admin, 'auteur réel (pas le bot)');
    assert.equal(botMessages(h, mark, titled(/Accès de whitelist en attente/)).filter((m) => !h.fake.dms.has(m.channel_id)).length, 1);

    const rm = await h.slash('role', sub('remove', [opt('membre', 6, IDS.users.mod), opt('role', 8, IDS.roles.mod)]), { as: 'admin' });
    assert.ok(!h.isError(rm), h.replyText(rm));
    assert.equal(h.client.services.secur.windowSum(h.guild.id, IDS.users.admin, 'roleRemove'), 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- /role delete, /backup restore

test('/role delete et /backup restore par un admin non exempté → refus en embed ; acceptés pour le propriétaire', async () => {
  const h = await createHarness();
  try {
    h.configure({ moderation: { confirmDangerous: false }, antiraid: { enabled: true, joinThreshold: 1000, roleDeleteThreshold: 1, destructiveWindowSeconds: 60, punishExecutor: 'strip' }, logChannels: { security: IDS.channels.logs } });
    await h.slash('role', sub('create', [opt('nom', 3, 'jetable')]), { as: 'owner' });
    const roleId = [...h.fake.roles.values()].find((r) => r.name === 'jetable').id;
    const denied = await h.slash('role', sub('delete', [opt('role', 8, roleId)]), { as: 'admin' });
    assert.ok(h.isError(denied), 'suppression de rôle au seuil 1 acceptée');
    assert.match(h.replyText(denied), /Action bloquée par la sécurité \(Suppression de rôles\) : 1 action\(s\)/);
    assert.ok(h.fake.roles.has(roleId));
    const ok = await h.slash('role', sub('delete', [opt('role', 8, roleId)]), { as: 'owner' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.ok(!h.fake.roles.has(roleId));

    // Module Secur « salons » actif : la restauration exige l'exemption.
    ensureModule(h, 'channelCreate', [10]);
    h.configure({ secur: { modules: { channelCreate: { mode: 'on' } } } });
    const { id } = h.client.services.backup.create(h.guild, h.client.users.cache.get(IDS.users.owner), 'instantané');
    const mark = h.fake.messageLog.length;
    const refused = await h.slash('backup', sub('restore', [opt('id', 3, id)]), { as: 'admin' });
    assert.ok(h.isError(refused), 'restauration acceptée');
    assert.match(h.replyText(refused), /Restauration bloquée par la sécurité : les modules Secur Création de salons/);
    assert.ok(botMessages(h, mark, titled(/Restauration bloquée par la sécurité/)).length >= 1, 'aucun log de la tentative');
    const rec = await h.slash('backup', sub('restore', [opt('id', 3, id)]), { as: 'owner' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    const go = await h.confirm(rec);
    assert.ok(go && !h.isError(go), go ? h.replyText(go) : 'pas de confirmation');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
