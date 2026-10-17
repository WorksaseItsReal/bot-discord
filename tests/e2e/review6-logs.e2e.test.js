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
const { nextId } = require('./lib/ids');

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
  const id = nextId();
  const raw = { id, type: 0, guild_id: h.guild.id, name, position: 60, permission_overwrites: overwrites, parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0, ...extra };
  h.fake.channels.set(id, raw);
  h.fake.dispatchNow('CHANNEL_CREATE', raw, `salon ${name}`);
  await h.settle();
  return id;
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

test('R28 : suppression par un administrateur signalée à l\'AntiRaid (chaque salon) et carte dans un salon survivant', async () => {
  const h = await createHarness();
  try {
    const cfg0 = await adminCreatesLogs(h);
    const total = cfg0.logs.createdChannels.length + 1; // + catégorie
    // Les logs « Salons » vont dans un salon choisi à la main (il survit à la suppression).
    h.configure({ logChannels: { channels: IDS.channels.modLog } });
    const reports = [];
    const moderation = h.client.services.moderation;
    const original = moderation.reportDestructiveAction.bind(moderation);
    moderation.reportDestructiveAction = async (guild, user, type, opts) => {
      reports.push({ user: user.id, type });
      return original(guild, user, type, opts);
    };
    const panel = await panelOf(h, 'admin');
    await h.click(panel, 'cmd:logs:go:setup', { as: 'admin' });
    const go = await h.click(panel, 'cmd:logs:go:confirmRemove', { as: 'admin' });
    assert.ok(!h.isError(go), h.replyText(go));
    const mark = h.fake.messageLog.length;
    const rm = await h.click(panel, 'cmd:logs:remove', { as: 'admin' });
    assert.ok(!h.isError(rm), h.replyText(rm));
    for (const id of cfg0.logs.createdChannels) assert.ok(!h.fake.channels.has(id));
    assert.equal(reports.length, total, 'chaque salon supprimé doit être signalé à l\'AntiRaid');
    assert.ok(reports.every((r) => r.user === IDS.users.admin && r.type === 'channelDelete'));
    const card = botPostsIn(h, mark, IDS.channels.modLog).find((m) => /Salons de logs supprimés/.test(m.embeds[0].title ?? ''));
    assert.ok(card, 'aucune carte « Salons de logs supprimés » dans le salon survivant');
    assert.ok(blob([card]).includes(IDS.users.admin));
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
