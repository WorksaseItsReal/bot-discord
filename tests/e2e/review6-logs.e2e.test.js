'use strict';

/**
 * Revue n° 6, lot « logs », bout en bout (vrai discord.js, faux Discord) : droits de /logs
 * (création, rôle staff, suppression des salons), contenu des salons privés dans les logs,
 * salons d'annonces, transcriptions sans « Joindre des fichiers », ancien rôle staff,
 * inondation, AutoMod en pause, spoilers tronqués, « Réparer ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { nextId, snowflakeAt, DAY } = require('./lib/ids');

const ROLE_MENU = 6;
const CHANNEL_MENU = 8;

/** Rôle ajouté au serveur (faux Discord + cache discord.js). */
function addRole(h, name, permissions, position = 2, extra = {}) {
  const role = {
    id: nextId(), name, color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null,
    unicode_emoji: null, position, permissions: String(permissions), managed: false, mentionable: false, flags: 0, ...extra,
  };
  h.fake.roles.set(role.id, role);
  h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: h.guild.id, role }, `rôle ${name}`);
  return role.id;
}

/** Donne un rôle à un membre (GUILD_MEMBER_UPDATE). */
async function giveRole(h, userId, roleId) {
  const raw = h.fake.members.get(userId);
  raw.roles = [...raw.roles, roleId];
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...raw, guild_id: h.guild.id }, 'rôle donné');
  await h.settle();
}

/** Salon textuel ajouté au serveur. */
async function addChannel(h, name, overwrites = [], extra = {}) {
  const raw = { id: nextId(), type: 0, guild_id: h.guild.id, name, position: 60, permission_overwrites: overwrites, parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0, ...extra };
  h.fake.channels.set(raw.id, raw);
  h.fake.dispatchNow('CHANNEL_CREATE', raw, `salon ${name}`);
  await h.settle();
  return raw.id;
}

/** Messages du bot postés dans un salon depuis `mark`. */
const botPostsIn = (h, mark, channelId) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m?.channel_id === channelId && m.author?.id === h.client.user.id && m.embeds?.length);
const blob = (messages) => JSON.stringify(messages.map((m) => m.embeds));
const BASIC = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.UseApplicationCommands;
const everyoneDeny = () => ({ id: IDS.roles.everyone, type: 0, allow: '0', deny: String(P.ViewChannel) });

/** Un administrateur crée les salons de logs (rôle staff : Modérateur). */
async function adminCreatesLogs(h, { categories } = {}) {
  const rec = await h.slash('logs', [], { as: 'admin' });
  const panel = h.messagesOf(rec).at(-1);
  await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
  if (categories) await h.click(panel, 'cmd:logs:setupcats', { as: 'admin', values: categories });
  await h.click(panel, 'cmd:logs:staff', { as: 'admin', values: [IDS.roles.mod], componentType: ROLE_MENU });
  await h.click(panel, 'cmd:logs:create', { as: 'admin' });
  h.client.cooldowns?.expiries?.clear?.();
  return h.client.services.config.get(h.guild.id);
}

async function panelOf(h, as) {
  h.client.cooldowns?.expiries?.clear?.();
  const rec = await h.slash('logs', [], { as });
  assert.ok(!h.isError(rec), `/logs refusé à ${as} : ${h.replyText(rec)}`);
  return h.messagesOf(rec).at(-1);
}

/** Retire un rôle à un membre. */
async function takeRole(h, userId, roleId) {
  const raw = h.fake.members.get(userId);
  raw.roles = raw.roles.filter((r) => r !== roleId);
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...raw, guild_id: h.guild.id }, 'rôle retiré');
  await h.settle();
}

/**
 * Panneau /logs resté ouvert sur la confirmation de suppression, ouvert pendant que le membre
 * était administrateur (rôle retiré ensuite) : le bouton « Oui, supprimer » est bien présent.
 */
async function staleRemovePanel(h, userId) {
  const tmp = addRole(h, 'Admin temporaire', P.Administrator, 5);
  await giveRole(h, userId, tmp);
  const panel = await panelOf(h, userId);
  await h.click(panel, 'cmd:logs:go:setup', { as: userId });
  const go = await h.click(panel, 'cmd:logs:go:confirmRemove', { as: userId });
  assert.ok(!h.isError(go), h.replyText(go));
  assert.ok(h.findComponent(h.message(panel.id), 'cmd:logs:remove'));
  await takeRole(h, userId, tmp);
  return h.message(panel.id);
}

// ---------------------------------------------------------------- R28

test('R28 : « Gérer le serveur » seul ne crée, ne répare, ne réattribue ni ne supprime les salons de logs', async () => {
  const h = await createHarness({ botAdministrator: false });
  try {
    const cfg0 = await adminCreatesLogs(h);
    const created = [...cfg0.logs.createdChannels, cfg0.logs.categoryId];
    assert.ok(created.length >= 9);
    // Un salon de logs du bot devenu illisible pour lui : « Réparer » apparaît.
    const broken = h.fake.channels.get(cfg0.logChannels.voice);
    broken.permission_overwrites = broken.permission_overwrites.filter((o) => o.id !== IDS.users.bot);
    broken.permission_overwrites.push({ id: IDS.users.bot, type: 1, allow: '0', deny: String(P.ViewChannel) });
    h.fake.dispatchNow('CHANNEL_UPDATE', broken, 'salon de logs cassé');
    await h.settle();
    const gestion = addRole(h, 'Gestion', P.ManageGuild | BASIC, 2);
    await giveRole(h, IDS.users.target, gestion);
    const stale = await staleRemovePanel(h, IDS.users.target);

    const panel = await panelOf(h, 'target');
    const mark = h.fake.calls.length;
    const rp = await h.click(panel, 'cmd:logs:repair', { as: 'target' });
    assert.ok(h.isError(rp), 'réparation acceptée sans Gérer les salons / Gérer les rôles');
    assert.match(h.replyText(rp), /Gérer les salons|Gérer les rôles/);
    await h.click(panel, 'cmd:logs:go:setup', { as: 'target' });
    const st = await h.click(panel, 'cmd:logs:staff', { as: 'target', values: [gestion], componentType: ROLE_MENU });
    assert.ok(h.isError(st), 'choix du rôle staff accepté sans Gérer les salons / Gérer les rôles');
    assert.match(h.replyText(st), /Gérer les salons|Gérer les rôles/);
    assert.equal(h.client.services.config.get(h.guild.id).logs.staffRoleId, IDS.roles.mod, 'rôle staff modifié');
    const cr = await h.click(panel, 'cmd:logs:create', { as: 'target' });
    assert.ok(h.isError(cr), 'création acceptée sans Gérer les salons / Gérer les rôles');
    const go = await h.click(panel, 'cmd:logs:go:confirmRemove', { as: 'target' });
    assert.ok(h.isError(go), 'confirmation de suppression affichée à un non-administrateur');
    assert.match(h.replyText(go), /Administrateur/);

    const rm = await h.click(stale, 'cmd:logs:remove', { as: 'target' });
    assert.ok(h.isError(rm), 'suppression acceptée');
    assert.match(h.replyText(rm), /Administrateur/);
    const writes = h.fake.calls.slice(mark).filter((c) => c.method === 'DELETE' || (c.method === 'PUT' && c.route.includes('/permissions/')) || (c.method === 'POST' && /\/guilds\/\d+\/channels$/.test(c.route)));
    assert.deepEqual(writes.map((c) => `${c.method} ${c.route}`), [], 'requêtes de suppression / permissions envoyées');
    for (const id of created) assert.ok(h.fake.channels.has(id), `salon ${id} supprimé`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R28 : rôle staff refusé s\'il est géré, au-dessus de l\'auteur, automatique, ou si l\'auteur ne voit pas les logs', async () => {
  const h = await createHarness();
  try {
    h.configure({ welcome: { autoRoles: { humans: [IDS.roles.temp], bots: [] } } });
    await adminCreatesLogs(h);
    // Gérer le serveur + Gérer les salons + Gérer les rôles, sans Administrateur ni accès aux salons de logs.
    const chef = addRole(h, 'Chef', P.ManageGuild | P.ManageChannels | P.ManageRoles | BASIC, 4);
    await giveRole(h, IDS.users.target, chef);
    const stale = await staleRemovePanel(h, IDS.users.target);
    const panel = await panelOf(h, 'target');
    await h.click(panel, 'cmd:logs:go:setup', { as: 'target' });
    const pick = (roleId) => h.click(panel, 'cmd:logs:staff', { as: 'target', values: [roleId], componentType: ROLE_MENU });

    const own = await pick(chef);
    assert.ok(h.isError(own), 'son propre rôle (≥ rôle le plus haut) accepté');
    const managed = await pick(IDS.roles.bot);
    assert.ok(h.isError(managed), 'rôle géré (bot) accepté');
    const auto = await pick(IDS.roles.temp);
    assert.ok(h.isError(auto), 'rôle donné automatiquement à l\'arrivée accepté');
    const member = await pick(IDS.roles.member);
    assert.ok(h.isError(member), 'rôle Membre accepté alors que l\'auteur ne voit pas les salons de logs');
    assert.match(h.replyText(member), /ne voyez pas/i);
    assert.equal(h.client.services.config.get(h.guild.id).logs.staffRoleId, IDS.roles.mod);

    // Un Administrateur peut toujours choisir un rôle sous le sien.
    const adminPanel = await panelOf(h, 'admin');
    await h.click(adminPanel, 'cmd:logs:go:setup', { as: 'admin' });
    const ok = await h.click(adminPanel, 'cmd:logs:staff', { as: 'admin', values: [IDS.roles.gamer], componentType: ROLE_MENU });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(h.client.services.config.get(h.guild.id).logs.staffRoleId, IDS.roles.gamer);

    // Gérer les salons + Gérer les rôles sans Administrateur : la suppression reste refusée.
    const rm = await h.click(stale, 'cmd:logs:remove', { as: 'target' });
    assert.ok(h.isError(rm));
    assert.match(h.replyText(rm), /Administrateur/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R28 : suppression par un administrateur signalée à l\'AntiRaid (chaque salon ancien) et carte dans un salon survivant', async () => {
  const h = await createHarness();
  try {
    // Salons de logs créés par le bot il y a deux jours (catégorie + 3 salons, avec leur historique).
    const old = () => snowflakeAt(Date.now() - 2 * DAY);
    const category = old();
    const rawCat = { id: category, type: 4, guild_id: h.guild.id, name: '📋 Logs', position: 20, permission_overwrites: [everyoneDeny()], parent_id: null, flags: 0 };
    h.fake.channels.set(category, rawCat);
    h.fake.dispatchNow('CHANNEL_CREATE', rawCat, 'catégorie de logs');
    const ids = [];
    for (const name of ['logs-moderation', 'logs-messages', 'logs-membres']) ids.push(await addChannel(h, name, [everyoneDeny()], { id: old(), parent_id: category }));
    h.configure({
      logChannels: { moderation: ids[0], messages: ids[1], members: ids[2], channels: IDS.channels.modLog },
      logs: { categoryId: category, createdChannels: ids },
    });
    const reports = [];
    const moderation = h.client.services.moderation;
    const original = moderation.reportDestructiveAction.bind(moderation);
    moderation.reportDestructiveAction = async (guild, user, type, opts) => {
      reports.push({ user: user.id, type });
      return original(guild, user, type, opts);
    };
    const remove = async () => {
      const panel = await panelOf(h, 'admin');
      await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
      const go = await h.click(panel, 'cmd:logs:go:confirmRemove', { as: 'admin' });
      assert.ok(!h.isError(go), h.replyText(go));
      const rm = await h.click(panel, 'cmd:logs:remove', { as: 'admin' });
      assert.ok(!h.isError(rm), h.replyText(rm));
    };
    const mark = h.fake.messageLog.length;
    await remove();
    for (const id of [...ids, category]) assert.ok(!h.fake.channels.has(id), `salon ${id} toujours là`);
    assert.equal(reports.length, 4, 'chaque salon supprimé (et la catégorie) doit être signalé à l\'AntiRaid');
    assert.ok(reports.every((r) => r.user === IDS.users.admin && r.type === 'channelDelete'));
    const card = botPostsIn(h, mark, IDS.channels.modLog).find((m) => /Salons de logs supprimés/.test(m.embeds[0].title ?? ''));
    assert.ok(card, 'aucune carte « Salons de logs supprimés » dans le salon survivant');
    assert.ok(blob([card]).includes(IDS.users.admin));

    // Salons tout juste créés puis retirés : rien à signaler (aucun historique détruit).
    reports.length = 0;
    await adminCreatesLogs(h);
    await remove();
    assert.equal(reports.length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R28 : /compteurs — créer, activer/désactiver ou supprimer des salons exige « Gérer les salons »', async () => {
  const h = await createHarness();
  try {
    const gestion = addRole(h, 'Gestion', P.ManageGuild | BASIC, 2);
    await giveRole(h, IDS.users.target, gestion);
    const open = async (as) => {
      h.client.cooldowns?.expiries?.clear?.();
      const rec = await h.slash('compteurs', [], { as });
      assert.ok(!h.isError(rec));
      return h.messagesOf(rec).at(-1);
    };
    const refused = async (panel, id) => {
      const mark = h.fake.calls.length;
      const r = await h.click(panel, id, { as: 'target' });
      assert.ok(h.isError(r), `${id} accepté sans Gérer les salons`);
      assert.match(h.replyText(r), /Gérer les salons/);
      const writes = h.fake.calls.slice(mark).filter((c) => c.method !== 'GET' && /^\/(guilds\/\d+\/)?channels/.test(c.route));
      assert.deepEqual(writes.map((c) => `${c.method} ${c.route}`), [], `${id} : salons créés ou supprimés`);
    };
    await refused(await open('target'), 'cmd:compteurs:create');
    // Un administrateur crée les compteurs ; le membre « Gérer le serveur » tente de les retirer.
    await h.click(await open('admin'), 'cmd:compteurs:create', { as: 'admin' });
    const panel = await open('target');
    await h.click(panel, 'cmd:compteurs:pick', { as: 'target', values: ['members'] });
    await refused(panel, 'cmd:compteurs:toggle:members:off');
    await h.click(panel, 'cmd:compteurs:go:home', { as: 'target' });
    await h.click(panel, 'cmd:compteurs:go:confirmRemove', { as: 'target' });
    await refused(panel, 'cmd:compteurs:remove');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R52

/** Salon de logs : messages publiés depuis `mark`, par titre. */
const titled = (posts, re) => posts.filter((m) => re.test(m.embeds[0].title ?? ''));

test('R52 : contenu d\'un salon privé masqué dans un salon de logs lu par des membres qui ne le voient pas', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const admins = await addChannel(h, 'admins', [everyoneDeny()]);
    const mod = h.guild.members.cache.get(IDS.users.mod);
    assert.ok(!h.client.channels.cache.get(admins).permissionsFor(mod).has(P.ViewChannel), 'le modérateur ne doit pas voir #admins');
    assert.ok(h.client.channels.cache.get(IDS.channels.logs).permissionsFor(mod).has(P.ViewChannel), 'le modérateur doit voir #logs');

    const mark = h.fake.messageLog.length;
    const secret = await h.userMessage({ as: 'admin', channel: admins, content: 'SECRET-A1 vote de rétrogradation' });
    await h.editUserMessage(secret.id, 'SECRET-A2 vote reporté');
    await h.deleteUserMessage(secret.id);
    const m1 = await h.userMessage({ as: 'admin', channel: admins, content: 'SECRET-B3 dossier' });
    const m2 = await h.userMessage({ as: 'admin', channel: admins, content: 'SECRET-B4 plainte' });
    h.fake.dispatchNow('MESSAGE_DELETE_BULK', { ids: [m1.id, m2.id], channel_id: admins, guild_id: h.guild.id }, 'purge #admins');
    await h.settle();
    // Témoins : salons que le modérateur voit (contenu conservé).
    const staff = await h.userMessage({ as: 'admin', channel: 'staff', content: 'VISIBLE-S1 réunion' });
    await h.deleteUserMessage(staff.id);
    const general = await h.userMessage({ as: 'member', channel: 'general', content: 'VISIBLE-G1 bonjour' });
    await h.editUserMessage(general.id, 'VISIBLE-G2 bonsoir');

    const posts = botPostsIn(h, mark, IDS.channels.logs);
    const text = blob(posts);
    assert.ok(!/SECRET-/.test(text), `contenu de #admins recopié dans #logs : ${text.match(/SECRET-[^"\\]*/g)}`);
    assert.equal(titled(posts, /Message modifié/).length, 2, 'cartes « Message modifié » (#admins + #général)');
    assert.equal(titled(posts, /Message supprimé/).length, 2, 'cartes « Message supprimé » (#admins + #staff)');
    const purge = titled(posts, /Suppression en masse/);
    assert.equal(purge.length, 1);
    assert.equal(purge[0].attachments?.length ?? 0, 0, 'transcription de #admins jointe');
    assert.match(text, /salon privé/);
    for (const k of ['VISIBLE-S1', 'VISIBLE-G1', 'VISIBLE-G2']) assert.ok(text.includes(k), `${k} manquant (salon visible du lecteur)`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R52 : rebrancher les logs sur un salon que l\'on voit ne révèle pas les salons que l\'on ne voit pas', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const admins = await addChannel(h, 'admins', [everyoneDeny()]);
    const gestion = addRole(h, 'Gestionnaire', P.ManageGuild | BASIC, 3);
    await giveRole(h, IDS.users.member, gestion);
    const own = await addChannel(h, 'gestion', [everyoneDeny(), { id: gestion, type: 0, allow: String(P.ViewChannel), deny: '0' }]);
    const panel = await panelOf(h, 'member');
    await h.click(panel, 'cmd:logs:nav', { as: 'member', values: ['cat:messages'] });
    await h.click(panel, 'cmd:logs:channel:messages', { as: 'member', values: [own], componentType: CHANNEL_MENU });
    assert.equal(h.client.services.config.get(h.guild.id).logChannels.messages, own);

    const mark = h.fake.messageLog.length;
    const s = await h.userMessage({ as: 'admin', channel: admins, content: 'SECRET-B1 mot de passe' });
    await h.editUserMessage(s.id, 'SECRET-B2 changé');
    await h.deleteUserMessage(s.id);
    const posts = botPostsIn(h, mark, own);
    assert.ok(posts.length >= 2, 'les cartes doivent toujours être publiées (auteur, salon, date)');
    assert.ok(!/SECRET-/.test(blob(posts)), 'contenu de #admins lisible dans #gestion');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R52 : fil privé — contenu et nom masqués si un lecteur des logs n\'a pas « Gérer les fils »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const threadId = nextId();
    const raw = {
      id: threadId, type: 12, guild_id: h.guild.id, parent_id: IDS.channels.general, name: 'SECRET-NOM-du-fil', owner_id: IDS.users.member,
      rate_limit_per_user: 0, message_count: 0, member_count: 1, total_message_sent: 0, last_message_id: null, flags: 0,
      thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false, invitable: false },
    };
    const openThread = async (id, name) => {
      const t = { ...raw, id, name };
      h.fake.channels.set(id, t);
      h.fake.dispatchNow('THREAD_CREATE', { ...t, newly_created: true }, `fil privé ${name}`);
      await h.settle();
      return id;
    };
    // 1) Lecteurs des logs : Modérateur (« Gérer les fils » : il voit déjà tous les fils privés) → rien à masquer.
    let mark = h.fake.messageLog.length;
    await openThread(threadId, 'VISIBLE-fil');
    let m = await h.userMessage({ as: 'member', channel: threadId, content: 'VISIBLE-T1' });
    await h.deleteUserMessage(m.id);
    let text = blob(botPostsIn(h, mark, IDS.channels.logs));
    assert.ok(text.includes('VISIBLE-T1') && text.includes('VISIBLE-fil'), 'fil privé masqué alors que tous les lecteurs le voient');

    // 2) Un rôle « Lecteur » sans « Gérer les fils » lit aussi #logs → contenu et nom masqués.
    const lecteur = addRole(h, 'Lecteur', BASIC, 2);
    const logs = h.fake.channels.get(IDS.channels.logs);
    logs.permission_overwrites.push({ id: lecteur, type: 0, allow: String(P.ViewChannel), deny: '0' });
    h.fake.dispatchNow('CHANNEL_UPDATE', logs, 'Lecteur voit #logs');
    await h.settle();
    mark = h.fake.messageLog.length;
    const second = await openThread(nextId(), 'SECRET-NOM-du-fil');
    m = await h.userMessage({ as: 'member', channel: second, content: 'SECRET-T2 confidence' });
    await h.editUserMessage(m.id, 'SECRET-T3 confidence modifiée');
    await h.deleteUserMessage(m.id);
    const posts = botPostsIn(h, mark, IDS.channels.logs);
    text = blob(posts);
    assert.ok(titled(posts, /Fil créé/).length === 1 && titled(posts, /Message supprimé/).length === 1, 'cartes manquantes');
    assert.ok(!/SECRET-/.test(text), `contenu ou nom du fil privé recopié : ${text.match(/SECRET-[^"\\]*/g)}`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R52 : un modérateur exclu d\'un salon (permission propre) ne lit pas son contenu dans les logs', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    // #staff : lisible par le rôle Modérateur, sauf pour Modo (refus propre au membre).
    const staff = h.fake.channels.get(IDS.channels.staff);
    staff.permission_overwrites.push({ id: IDS.users.mod, type: 1, allow: '0', deny: String(P.ViewChannel) });
    h.fake.dispatchNow('CHANNEL_UPDATE', staff, 'Modo exclu de #staff');
    await h.settle();
    const mark = h.fake.messageLog.length;
    const m = await h.userMessage({ as: 'admin', channel: 'staff', content: 'SECRET-M1 avis sur Modo' });
    await h.deleteUserMessage(m.id);
    const posts = botPostsIn(h, mark, IDS.channels.logs);
    assert.equal(titled(posts, /Message supprimé/).length, 1);
    assert.ok(!/SECRET-/.test(blob(posts)), 'contenu de #staff lisible par Modo dans #logs');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R53

test('R53 : jamais de carte de log dans un salon d\'annonces (publication automatique vers les serveurs abonnés)', async () => {
  const h = await createHarness();
  try {
    h.client.services.automations.delayMs = 5;
    const ann = IDS.channels.announcements;
    h.configure({ automations: { crosspost: { enabled: true, channels: [ann] } } });
    const panel = await panelOf(h, 'admin');
    await h.click(panel, 'cmd:logs:nav', { as: 'admin', values: ['cat:messages'] });
    const set = await h.click(panel, 'cmd:logs:channel:messages', { as: 'admin', values: [ann], componentType: CHANNEL_MENU });
    assert.ok(h.isError(set), 'salon d\'annonces accepté comme salon de logs');
    assert.notEqual(h.client.services.config.get(h.guild.id).logChannels.messages, ann);
    const menu = h.findComponent(h.message(panel.id), 'cmd:logs:channel:messages');
    assert.deepEqual(menu.channel_types, [0], 'le sélecteur ne doit proposer que des salons textuels');

    // Ancienne configuration (avant ce correctif) : salon d'annonces déjà branché.
    h.configure({ logChannels: { messages: ann } });
    const mark = h.fake.calls.length;
    const logMark = h.fake.messageLog.length;
    const msg = await h.userMessage({ as: 'member', content: 'mon numéro perso : 06 12 34 56 78' });
    await h.deleteUserMessage(msg.id);
    await h.waitFor(() => h.fake.calls.slice(mark).some((c) => /\/crosspost$/.test(c.route)), { timeout: 300 }).catch(() => {});
    assert.deepEqual(h.fake.calls.slice(mark).filter((c) => /\/crosspost$/.test(c.route)).map((c) => c.route), [], 'carte de log publiée vers les serveurs abonnés');
    assert.equal(botPostsIn(h, logMark, ann).length, 0, 'carte de log envoyée dans le salon d\'annonces');
    // Le tableau de bord signale le problème.
    const home = await panelOf(h, 'admin');
    assert.match(JSON.stringify(h.message(home.id).embeds), /annonces/i);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R54

test('R54 : sans « Joindre des fichiers », la purge est journalisée sans transcription (et le tableau de bord le signale)', async () => {
  const h = await createHarness({ botAdministrator: false });
  try {
    h.configureAll();
    const raw = h.fake.channels.get(IDS.channels.logs);
    raw.permission_overwrites.push({ id: IDS.roles.bot, type: 0, allow: String(P.ViewChannel | P.SendMessages | P.EmbedLinks), deny: String(P.AttachFiles) });
    h.fake.dispatchNow('CHANNEL_UPDATE', raw, '#logs sans Joindre des fichiers');
    await h.settle();
    const mark = h.fake.messageLog.length;
    const m1 = await h.userMessage({ as: 'member', content: 'insulte 1' });
    const m2 = await h.userMessage({ as: 'member', content: 'insulte 2' });
    h.fake.dispatchNow('MESSAGE_DELETE_BULK', { ids: [m1.id, m2.id], channel_id: IDS.channels.general, guild_id: h.guild.id }, 'purge');
    await h.settle();
    const purge = titled(botPostsIn(h, mark, IDS.channels.logs), /Suppression en masse/);
    assert.equal(purge.length, 1, 'log de purge perdu');
    assert.equal(purge[0].attachments?.length ?? 0, 0);
    assert.match(blob(purge), /Joindre des fichiers/);
    // Tableau de bord : la catégorie Messages signale la permission manquante.
    const panel = await panelOf(h, 'admin');
    await h.click(panel, 'cmd:logs:nav', { as: 'admin', values: ['cat:messages'] });
    assert.match(JSON.stringify(h.message(panel.id).embeds), /Joindre des fichiers/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R55

test('R55 : changer ou retirer le rôle staff retire l\'accès de l\'ancien rôle aux salons de logs', async () => {
  const h = await createHarness();
  try {
    const panel = await panelOf(h, 'admin');
    await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
    await h.click(panel, 'cmd:logs:staff', { as: 'admin', values: [IDS.roles.gamer], componentType: ROLE_MENU });
    await h.click(panel, 'cmd:logs:create', { as: 'admin' });
    const cfg1 = h.client.services.config.get(h.guild.id).logs;
    const ids = [cfg1.categoryId, ...cfg1.createdChannels];
    const gamer = h.guild.members.cache.get(IDS.users.member); // porte le rôle Joueur
    assert.ok(ids.every((id) => h.client.channels.cache.get(id).permissionsFor(gamer).has(P.ViewChannel)));

    // Plus de rôle staff : le tableau de bord prévient que l'ancien rôle garde l'accès jusqu'à « Créer ».
    await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
    await h.click(panel, 'cmd:logs:staff', { as: 'admin', values: [], componentType: ROLE_MENU });
    assert.match(JSON.stringify(h.message(panel.id).embeds), /garde l'accès/);
    await h.click(panel, 'cmd:logs:create', { as: 'admin' });
    for (const id of ids) {
      const ch = h.client.channels.cache.get(id);
      assert.ok(!ch.permissionOverwrites.cache.has(IDS.roles.gamer), `#${ch.name} : surcharge de l'ancien rôle staff conservée`);
      assert.ok(!ch.permissionsFor(gamer).has(P.ViewChannel), `#${ch.name} : l'ancien rôle staff voit encore le salon`);
    }
    // Nouveau rôle staff : posé partout, y compris sur les salons hors du plan (réparation partielle).
    await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
    await h.click(panel, 'cmd:logs:staff', { as: 'admin', values: [IDS.roles.mod], componentType: ROLE_MENU });
    await h.click(panel, 'cmd:logs:create', { as: 'admin' });
    const mod = h.guild.members.cache.get(IDS.users.mod);
    assert.ok(ids.every((id) => h.client.channels.cache.get(id).permissionsFor(mod).has(P.ViewChannel)));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R55 : un salon de logs créé par le bot rendu visible par @everyone est signalé', async () => {
  const h = await createHarness();
  try {
    const cfg = await adminCreatesLogs(h, { categories: ['messages'] });
    const raw = h.fake.channels.get(cfg.logChannels.messages);
    raw.permission_overwrites = raw.permission_overwrites.filter((o) => o.id !== IDS.roles.everyone);
    raw.permission_overwrites.push({ id: IDS.roles.everyone, type: 0, allow: String(P.ViewChannel), deny: '0' });
    h.fake.dispatchNow('CHANNEL_UPDATE', raw, 'salon de logs rendu public');
    await h.settle();
    const panel = await panelOf(h, 'admin');
    await h.click(panel, 'cmd:logs:nav', { as: 'admin', values: ['cat:messages'] });
    assert.match(JSON.stringify(h.message(panel.id).embeds), /visible par @everyone/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
