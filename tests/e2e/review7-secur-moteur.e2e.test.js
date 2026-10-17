'use strict';

/**
 * Revue n° 7, lot « moteur Secur / AntiRaid », bout en bout (vrai discord.js, faux Discord).
 * Un test par constat : il échouait sur le code d'origine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { rawMember } = require('./lib/fixtures');
const { nextId } = require('./lib/ids');
const { AntiRaidService } = require('../../src/services/AntiRaidService');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const inGuild = (h) => (m) => !h.fake.dms.has(m.channel_id);

/** Rôle brut ajouté au faux Discord (et au cache via GUILD_ROLE_CREATE). */
function addRole(h, { name, permissions = 0n, managed = false, tags, position = 1 }) {
  const role = { id: nextId(), name, color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position, permissions: String(permissions), managed, mentionable: false, flags: 0, ...(tags ? { tags } : {}) };
  h.fake.roles.set(role.id, role);
  h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: h.guild.id, role });
  return role;
}

/** Donne des rôles à un membre (faux Discord + cache). */
function giveRoles(h, userId, roleIds) {
  const m = h.fake.members.get(userId);
  m.roles = [...new Set([...m.roles, ...roleIds])];
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...m });
}

/* ------------------------------------------------------------------------------------------ */
/* S1 : vague d'arrivées comptée sur l'heure d'arrivée fixée par Discord                       */
/* ------------------------------------------------------------------------------------------ */

/** Arrivées livrées d'un bloc (rejeu après RESUME, rafale retardée par Discord). */
async function joinsAt(h, prefix, joinedAts) {
  const ids = [];
  for (const [i, at] of joinedAts.entries()) {
    const u = h.addUser(`${prefix}${i}`, { ageDays: 400 });
    const m = { ...rawMember(u, [], 0), joined_at: new Date(at).toISOString() };
    h.fake.members.set(u.id, m);
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...m, guild_id: h.guild.id }, `arrivée ${prefix}${i}`);
    ids.push(u.id);
  }
  await h.settle({ timeout: 10_000 });
  return ids;
}

test('S1 : 10 arrivées légitimes étalées sur 5 min, livrées d\'un bloc (rejeu) → aucune vague ; 10 arrivées en direct → vague', async () => {
  const h = await createHarness();
  try {
    h.configure({
      logChannels: { security: IDS.channels.logs },
      automod: { enabled: false },
      antiraid: { enabled: true, joinThreshold: 10, joinWindowSeconds: 10, minAccountAgeDays: 0, antiBot: false, action: 'kick', alertChannel: IDS.channels.logs },
    });
    const mark = h.fake.messageLog.length;
    const t0 = Date.now() - 5 * 60_000;
    const replayed = await joinsAt(h, 'Rejeu', Array.from({ length: 10 }, (_, i) => t0 + i * 30_000));
    assert.equal(replayed.filter((id) => h.fake.members.has(id)).length, 10, 'membres légitimes expulsés par une fausse vague');
    assert.equal(botMessages(h, mark, titled(/Vague d'arrivées/)).length, 0, 'fausse alerte de vague');
    // Témoin : 10 arrivées réellement simultanées restent une vague.
    const live = await joinsAt(h, 'Direct', Array.from({ length: 10 }, () => Date.now()));
    assert.ok(live.filter((id) => !h.fake.members.has(id)).length >= 9, 'vague réelle non sanctionnée');
    assert.equal(botMessages(h, mark, titled(/Vague d'arrivées/)).filter(inGuild(h)).length, 1, 'vague réelle non détectée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S5 : salons créés par soi-même, après un redémarrage                                         */
/* ------------------------------------------------------------------------------------------ */

async function ownChannelsScenario({ restart, foreign = false }) {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, automod: { enabled: false }, antiraid: { enabled: true, joinThreshold: 1000, alertChannel: IDS.channels.logs } });
    // Bot tiers de vocaux temporaires : rôle non géré « admin » donné par le propriétaire.
    await h.asHuman('owner').addRole('otherBot', IDS.roles.admin);
    const creator = h.asHuman(foreign ? 'owner' : 'otherBot');
    const created = [];
    for (let i = 0; i < 3; i += 1) created.push((await creator.perform('POST', `/guilds/${h.guild.id}/channels`, { name: `vocal-${i}`, type: 2 })).id);
    if (restart) {
      const old = h.client.services.antiraid;
      old.stop();
      h.client.services.antiraid = new AntiRaidService({ client: h.client, config: old.config, logging: old.logging });
    }
    const mark = h.fake.messageLog.length;
    for (const id of created) await h.asHuman('otherBot').deleteChannel(id);
    await h.settle();
    return { alerts: botMessages(h, mark, titled(/Activité destructrice/)).filter(inGuild(h)).length, roles: h.fake.members.get(IDS.users.otherBot)?.roles ?? null, problems: h.problemCount() ? h.formatProblems() : null };
  } finally {
    await h.close();
  }
}

test('S5 : après un redémarrage, un bot tiers qui supprime 3 vocaux qu\'il a créés n\'est pas sanctionné', async () => {
  const r = await ownChannelsScenario({ restart: true });
  assert.equal(r.alerts, 0, 'fausse alerte « Activité destructrice anormale » après redémarrage');
  assert.deepEqual(r.roles, [IDS.roles.admin], 'rôles retirés au bot tiers');
  assert.equal(r.problems, null, r.problems);
});

test('S5 (témoin) : après un redémarrage, supprimer 3 salons créés par un AUTRE reste détecté', async () => {
  const r = await ownChannelsScenario({ restart: true, foreign: true });
  assert.equal(r.alerts, 1);
  assert.deepEqual(r.roles, []);
});

/* ------------------------------------------------------------------------------------------ */
/* S6 : rôles gérés supprimés par Discord (bots expulsés)                                       */
/* ------------------------------------------------------------------------------------------ */

async function addOldBot(h, i) {
  const bot = h.addUser(`VieuxBot${i}`, { bot: true, ageDays: 900 });
  const role = addRole(h, { name: `VieuxBot${i}`, managed: true, tags: { bot_id: bot.id } });
  const m = rawMember(bot, [role.id], 300);
  h.fake.members.set(bot.id, m);
  h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...m, guild_id: h.guild.id });
  await h.settle();
  return { bot, role };
}

test('S6 : un admin expulse 3 bots (Discord supprime leurs rôles gérés) → AntiRaid historique muet, admin intact', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, automod: { enabled: false }, antiraid: { enabled: true, joinThreshold: 1000, alertChannel: IDS.channels.logs } });
    const bots = [];
    for (let i = 0; i < 3; i += 1) bots.push(await addOldBot(h, i));
    const before = [...h.fake.members.get(IDS.users.admin).roles];
    const mark = h.fake.messageLog.length;
    for (const [i, { bot, role }] of bots.entries()) {
      await h.asHuman('admin').kick(bot.id);
      h.fake.deleteRole(role.id); // GUILD_ROLE_DELETE envoyé avec le départ du bot, AVANT l'entrée d'audit
      await h.settle();
      await h.auditEntry({ action_type: 32, target_id: role.id, user_id: IDS.users.admin, changes: [{ key: 'name', old_value: role.name }, { key: 'permissions', old_value: '0' }] }, { at: Date.now() - 8_000 + i * 4_000 });
    }
    // Entrée d'audit reçue AVANT l'événement (rôle encore en cache) : ignorée aussi.
    const { bot, role } = await addOldBot(h, 9);
    await h.asHuman('admin').kick(bot.id);
    await h.auditEntry({ action_type: 32, target_id: role.id, user_id: IDS.users.admin, changes: [{ key: 'name', old_value: role.name }] });
    h.fake.deleteRole(role.id);
    await h.settle();
    assert.equal(botMessages(h, mark, titled(/Activité destructrice/)).length, 0, 'suppressions de rôles gérés comptées comme destructrices');
    assert.deepEqual(h.fake.members.get(IDS.users.admin).roles, before, 'admin dépouillé');
    // Témoin : 3 rôles ordinaires supprimés restent comptés.
    for (const key of ['gamer', 'notif', 'temp']) await h.asHuman('admin').deleteRole(IDS.roles[key]);
    await h.settle();
    assert.equal(botMessages(h, mark, titled(/Activité destructrice/)).filter(inGuild(h)).length, 1, 'suppressions ordinaires non détectées');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S9 : bots de confiance exemptés par l'AntiRaid historique                                    */
/* ------------------------------------------------------------------------------------------ */

test('S9 : un bot de confiance qui supprime 3 salons n\'est pas dépouillé ; arrivée d\'un bot de confiance non expulsée (anti-bot)', async () => {
  const h = await createHarness();
  try {
    h.configure({
      logChannels: { security: IDS.channels.logs },
      automod: { enabled: false },
      antiraid: { enabled: true, joinThreshold: 1000, antiBot: true, alertChannel: IDS.channels.logs },
      secur: { trustedBots: [IDS.users.otherBot] },
    });
    await h.asHuman('owner').addRole('otherBot', IDS.roles.admin);
    const mark = h.fake.messageLog.length;
    for (const key of ['rules', 'announcements', 'forum']) await h.asHuman('otherBot').deleteChannel(IDS.channels[key]);
    await h.settle();
    assert.equal(botMessages(h, mark, titled(/Activité destructrice/)).length, 0, 'bot de confiance sanctionné');
    assert.deepEqual(h.fake.members.get(IDS.users.otherBot).roles, [IDS.roles.admin]);
    // Anti-bot : un bot de confiance (ré)ajouté n'est pas expulsé à son arrivée.
    const trusted = h.addUser('BotConfiance', { bot: true, ageDays: 500 });
    h.configure({ secur: { trustedBots: [IDS.users.otherBot, trusted.id] } });
    await h.memberJoin(trusted);
    assert.ok(h.fake.members.has(trusted.id), 'bot de confiance expulsé par l\'anti-bot');
    // Témoin : un bot quelconque reste expulsé.
    const other = h.addUser('BotInconnu', { bot: true, ageDays: 500 });
    await h.memberJoin(other);
    assert.ok(!h.fake.members.has(other.id), 'anti-bot inopérant');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S27 : derank et surcharges de salon des rôles conservés                                      */
/* ------------------------------------------------------------------------------------------ */

test('S27 : derank — un rôle géré conservé garde « Gérer les salons » par surcharge → l\'auteur n\'est pas laissé armé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const G = h.guild.id;
    const mod = h.fake.roles.get(IDS.roles.mod);
    mod.permissions = (BigInt(mod.permissions) | P.ManageChannels).toString();
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: G, role: mod });
    const booster = addRole(h, { name: 'Booster', managed: true, tags: { premium_subscriber: null } });
    const general = h.fake.channels.get(IDS.channels.general);
    general.permission_overwrites = [...(general.permission_overwrites ?? []), { id: booster.id, type: 0, allow: (P.ManageChannels | P.ManageWebhooks).toString(), deny: '0' }];
    h.fake.dispatchNow('CHANNEL_UPDATE', general);
    giveRoles(h, IDS.users.mod, [booster.id]);
    await h.settle();
    h.configure({ secur: { modules: { channelDelete: { mode: 'on' } } } });
    await h.asHuman('mod').deleteChannel(IDS.channels.rules);
    await h.settle();
    const member = h.guild.members.cache.get(IDS.users.mod);
    const [incident] = h.client.repositories.securityIncidents.recent(G, 5);
    assert.ok(!member || !member.permissionsIn(IDS.channels.general).has(P.ManageChannels), `derank jugé suffisant (sanction ${incident.punishment}) : Gérer les salons reste via la surcharge d'un rôle conservé`);
    assert.equal(incident.punishment, 'kick');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ========================================================================================== */
/* Moteur Secur                                                                               */
/* ========================================================================================== */

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const incidentsOf = (h) => h.client.repositories.securityIncidents.recent(h.guild.id, 20);
const hasRole = (h, userId, roleId) => Boolean(h.fake.members.get(userId)?.roles?.includes(roleId));
const channelNames = (h) => [...h.fake.channels.values()].map((c) => c.name);
const drain = async (h) => {
  await h.settle();
  await new Promise((r) => setTimeout(r, 200));
  await h.settle();
};

/** Configuration minimale : logs sécurité, AntiRaid et AutoMod coupés, modules Secur demandés. */
function securOnly(h, modules, extra = {}) {
  h.configure({ logChannels: { security: IDS.channels.logs }, antiraid: { enabled: false }, automod: { enabled: false }, secur: { modules }, ...extra });
}

/** Membre du staff supplémentaire (rôle Modérateur). */
async function addStaff(h, name) {
  const u = h.addUser(name, { ageDays: 800 });
  const m = rawMember(u, [IDS.roles.mod], 200);
  h.fake.members.set(u.id, m);
  h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...m, guild_id: h.guild.id });
  await h.settle();
  return u.id;
}

/* ------------------------------------------------------------------------------------------ */
/* S4 : refus du pré-contrôle sans action dans la fenêtre                                      */
/* ------------------------------------------------------------------------------------------ */

test('S4 : 3 /channel creer refusés (limite 1, fenêtre vide) → refus seulement, aucun dérank ; avec une action dans la fenêtre, l\'insistance reste sanctionnée', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { channelCreate: { mode: 'on' }, channelDelete: { mode: 'on', limit: 2, windowSeconds: 60 } });
    for (let i = 0; i < 3; i += 1) {
      const rec = await h.slash('channel', sub('creer', [opt('nom', 3, `essai-${i}`)]));
      assert.ok(h.isError(rec), 'création non refusée par le pré-contrôle');
      assert.match(h.replyText(rec), /Action bloquée par la sécurité/);
    }
    await drain(h);
    assert.ok(hasRole(h, IDS.users.admin, IDS.roles.admin), 'admin dérangé pour 3 demandes refusées, sans aucune action');
    assert.equal(incidentsOf(h).length, 0, 'incident ouvert sans action');
    // Témoin : une suppression réelle dans la fenêtre, puis 3 demandes refusées → incident.
    await h.asHuman('admin').deleteChannel(IDS.channels.staff);
    for (let i = 0; i < 3; i += 1) {
      const rec = await h.slash('channel', sub('supprimer', [opt('salon', 7, IDS.channels.announcements)]));
      assert.ok(h.isError(rec));
    }
    await drain(h);
    assert.equal(incidentsOf(h).length, 1, 'insistance après une action réelle non sanctionnée');
    assert.ok(!hasRole(h, IDS.users.admin, IDS.roles.admin));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S10 : incident « alerte seule » non contagieux                                              */
/* ------------------------------------------------------------------------------------------ */

test('S10 : un @everyone (sanction « aucune ») ouvre un incident ; un retrait de rôle légitime sous le seuil dans la minute n\'est pas annulé', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { everyone: { mode: 'on' }, roleRemove: { mode: 'on' } });
    await h.userMessage({ as: 'admin', content: '@everyone réunion à 20 h' });
    await drain(h);
    assert.equal(incidentsOf(h).length, 1, 'incident @everyone non ouvert');
    await h.asHuman('admin').removeRole('mod', IDS.roles.mod);
    await drain(h);
    assert.equal(hasRole(h, IDS.users.mod, IDS.roles.mod), false, 'retrait légitime (1 sur 3) annulé par contagion d\'un incident sans sanction');
    assert.ok(hasRole(h, IDS.users.admin, IDS.roles.admin), 'auteur sanctionné');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S10 (témoin) : module « alerte seule » déjà déclenché — ses actions suivantes sous le seuil restent annulées', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { channelDelete: { mode: 'on', punish: 'none', limit: 2, windowSeconds: 60 } });
    const names = ['rules', 'announcements', 'staff'].map((k) => h.fake.channels.get(IDS.channels[k]).name);
    for (const key of ['rules', 'announcements', 'staff']) await h.asHuman('admin').deleteChannel(IDS.channels[key]);
    await drain(h);
    assert.equal(incidentsOf(h).length, 1);
    assert.deepEqual(names.map((n) => channelNames(h).includes(n)), [true, true, true], '3ᵉ suppression (sous le seuil, même module) non annulée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S14 : entrées antérieures sous le seuil reprises à l'ouverture de l'incident                */
/* ------------------------------------------------------------------------------------------ */

test('S14 : roleRemove 3 en 10 s — 2 retraits à t=0/1 s puis 3 à t=12/12,5/13 s → les 5 rôles sont rendus', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { roleRemove: { mode: 'on' } });
    const staff = [];
    for (let i = 0; i < 5; i += 1) staff.push(await addStaff(h, `Staff${i}`));
    const base = Date.now() - 20_000;
    const offsets = [0, 1_000, 12_000, 12_500, 13_000];
    for (const [i, id] of staff.entries()) await h.asHuman('admin').removeRole(id, IDS.roles.mod, { at: base + offsets[i] });
    await drain(h);
    const [incident] = incidentsOf(h);
    assert.ok(incident, 'aucun incident');
    assert.deepEqual(staff.map((id) => hasRole(h, id, IDS.roles.mod)), [true, true, true, true, true], 'rôles retirés sous le seuil avant l\'incident non rendus');
    assert.equal(incident.actions, 5);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S14 : 2 retraits de rôle Modérateur (sous le seuil) puis suppression de #règles → le staff est rendu avec le salon', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { roleRemove: { mode: 'on' }, channelDelete: { mode: 'on' } });
    const staff = [await addStaff(h, 'StaffA'), await addStaff(h, 'StaffB')];
    for (const id of staff) await h.asHuman('admin').removeRole(id, IDS.roles.mod);
    const rules = h.fake.channels.get(IDS.channels.rules).name;
    await h.asHuman('admin').deleteChannel(IDS.channels.rules);
    await drain(h);
    assert.deepEqual(staff.map((id) => hasRole(h, id, IDS.roles.mod)), [true, true], 'staff laissé dépouillé');
    assert.ok([...h.fake.channels.values()].some((c) => c.name === rules), 'salon non recréé');
    const [incident] = incidentsOf(h);
    assert.equal(incident.actions, 3);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S17 : accès de whitelist en attente jusqu'à décision                                        */
/* ------------------------------------------------------------------------------------------ */

test('S17 : un accès de whitelist donné par un non-owner n\'exempte jamais sans approbation (même après 24 h) ; un owner qui le redonne l\'approuve', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { channelDelete: { mode: 'on' } }, { whitelist: { users: [IDS.users.mod], roles: [] } });
    const secur = h.client.services.secur;
    const grant = await secur.recordGrant(h.guild, { kind: 'user', subjectId: IDS.users.mod, grantedBy: IDS.users.admin });
    assert.ok(grant && !grant.existing);
    const level = () => secur.levelOf(h.guild, IDS.users.mod, h.guild.members.cache.get(IDS.users.mod));
    assert.equal(level(), 'membre');
    const realNow = secur.now;
    secur.now = () => realNow() + 25 * 3_600_000;
    assert.equal(level(), 'membre', 'accès en attente devenu actif tout seul après 24 h');
    assert.equal(secur.pendingGrants(h.guild.id).length, 1);
    // Purge (30 jours) : un accès jamais tranché reste en attente.
    secur.now = () => realNow() + 31 * 24 * 3_600_000;
    secur.lastPurgeAt = 0;
    await secur.processSecurityDue();
    assert.equal(level(), 'membre', 'accès en attente purgé, donc actif');
    secur.now = realNow;
    // Un owner (le propriétaire) donne le même accès : l'attente est levée.
    assert.equal(await secur.recordGrant(h.guild, { kind: 'user', subjectId: IDS.users.mod, grantedBy: IDS.users.owner }), null);
    assert.equal(level(), 'whitelist');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S20 : disjoncteur par objet                                                                 */
/* ------------------------------------------------------------------------------------------ */

const hasAdminPerm = (h, roleId) => (BigInt(h.fake.roles.get(roleId).permissions) & P.Administrator) !== 0n;
const permsOf = (...f) => f.reduce((a, b) => a | b, 0n).toString();

test('S20 : un bot non neutralisé déclenche le disjoncteur sur « Joueur » → Administrateur donné à « Membre » reste annulé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const nuke = addRole(h, { name: 'NukeBot', permissions: P.Administrator, managed: true, tags: { bot_id: IDS.users.otherBot }, position: 6 });
    const m = h.fake.members.get(IDS.users.otherBot);
    m.roles = [nuke.id];
    m.joined_at = new Date(Date.now() - 30 * 86_400_000).toISOString();
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...m });
    await h.settle();
    h.configure({ antiraid: { enabled: false }, secur: { modules: { roleUpdate: { mode: 'on' } } } });
    const bot = h.asHuman('otherBot');
    for (let i = 0; i < 3; i += 1) await bot.editRole(IDS.roles.gamer, { permissions: P.ManageRoles.toString() });
    await drain(h);
    await bot.editRole(IDS.roles.member, { permissions: P.Administrator.toString() });
    await drain(h);
    assert.equal(hasAdminPerm(h, IDS.roles.member), false, 'module entier suspendu : Administrateur sur « Membre » non annulé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S20 : rafale de 4 PATCH (3 sur « Joueur » puis Administrateur sur « Membre ») → « Membre » annulé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: false }, secur: { modules: { roleUpdate: { mode: 'on' } } } });
    const route = (id) => `/guilds/${h.guild.id}/roles/${id}`;
    const actor = { actorId: IDS.users.admin };
    await h.fake.perform('PATCH', route(IDS.roles.gamer), { permissions: permsOf(P.ManageRoles) }, actor);
    await h.fake.perform('PATCH', route(IDS.roles.gamer), { permissions: permsOf(P.ManageRoles, P.ManageChannels) }, actor);
    await h.fake.perform('PATCH', route(IDS.roles.gamer), { permissions: permsOf(P.ManageRoles, P.ManageChannels, P.BanMembers) }, actor);
    await h.fake.perform('PATCH', route(IDS.roles.member), { permissions: P.Administrator.toString() }, actor);
    await drain(h);
    assert.equal(hasAdminPerm(h, IDS.roles.member), false, 'tâche « Membre » retirée par le disjoncteur');
    assert.equal(h.client.services.secur.breaker.isSuspended(h.guild.id, 'roleUpdate'), false, 'annulations sans effet comptées par le disjoncteur');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S21 : repli sur le retrait des rôles quand l'expulsion est impossible                       */
/* ------------------------------------------------------------------------------------------ */

test('S21 : sanction « kick » impossible (bot sans Expulser) → repli sur le retrait des rôles, l\'auteur ne peut plus supprimer', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const mod = h.fake.roles.get(IDS.roles.mod);
    mod.permissions = (BigInt(mod.permissions) | P.ManageChannels).toString();
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role: mod });
    const botRole = h.fake.roles.get(IDS.roles.bot);
    botRole.permissions = permsOf(P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ModerateMembers, P.ManageMessages, P.ViewAuditLog,
      P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.ViewChannel, P.ManageWebhooks, P.AttachFiles, P.AddReactions);
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role: botRole });
    await h.settle();
    h.configure({ antiraid: { enabled: false }, secur: { modules: { channelDelete: { mode: 'on', punish: 'kick' } } } });
    await h.asHuman('mod').deleteChannel(IDS.channels.rules);
    await drain(h);
    const [incident] = incidentsOf(h);
    assert.equal(hasRole(h, IDS.users.mod, IDS.roles.mod), false, 'expulsion impossible sans repli : l\'auteur garde ses rôles');
    assert.equal(incident.punishment, 'derank');
    assert.match(incident.outcome, /Expulsion impossible/);
    await assert.rejects(h.asHuman('mod').deleteChannel(IDS.channels.announcements), /Missing Permissions/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S25 : actions faites via le bot annulables                                                  */
/* ------------------------------------------------------------------------------------------ */

async function viaBotDelete(h, key) {
  const rec = await h.slash('channel', sub('supprimer', [opt('salon', 7, IDS.channels[key])]));
  await h.confirm(rec);
  await h.settle();
}

test('S25 : /channel supprimer ×2 puis 1 suppression manuelle → les 3 salons sont recréés', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: false }, secur: { modules: { channelDelete: { mode: 'on', limit: 3, windowSeconds: 60 } } } });
    const names = ['announcements', 'staff', 'modLog'].map((k) => h.fake.channels.get(IDS.channels[k]).name);
    for (const key of ['announcements', 'staff']) await viaBotDelete(h, key);
    await h.asHuman('admin').deleteChannel(IDS.channels.modLog);
    await drain(h);
    const [incident] = incidentsOf(h);
    assert.equal(incident.actions, 3);
    assert.deepEqual(names.map((n) => channelNames(h).includes(n)), [true, true, true], 'salons supprimés via le bot non recréés');
    assert.equal(incident.undo_failed, 0, incident.outcome);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S25 : limite 4, /channel supprimer ×3 puis 1 suppression manuelle → tout est recréé, aucun faux « conflit d\'annulation »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: false }, secur: { modules: { channelDelete: { mode: 'on', limit: 4, windowSeconds: 60 } } } });
    const keys = ['announcements', 'staff', 'forum', 'modLog'];
    const names = keys.map((k) => h.fake.channels.get(IDS.channels[k]).name);
    const mark = h.fake.messageLog.length;
    for (const key of keys.slice(0, 3)) await viaBotDelete(h, key);
    await h.asHuman('admin').deleteChannel(IDS.channels.modLog);
    await drain(h);
    assert.deepEqual(names.map((n) => channelNames(h).includes(n)), [true, true, true, true], 'salons non recréés');
    assert.equal(h.client.services.secur.breaker.isSuspended(h.guild.id, 'channelDelete'), false, 'disjoncteur déclenché par des actions via le bot');
    assert.equal(botMessages(h, mark, titled(/Conflit d'annulation/)).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S25 : /unban ×2 puis 1 débannissement manuel → les 3 sont rebannis', async () => {
  const h = await createHarness();
  try {
    securOnly(h, { unban: { mode: 'on', limit: 3, windowSeconds: 60 } });
    const users = [0, 1, 2].map((i) => h.addUser(`Banni${i}`, { ageDays: 900 }));
    for (const u of users) await h.asHuman('owner').ban(u.id);
    for (const u of users.slice(0, 2)) {
      const rec = await h.slash('unban', [opt('user_id', 3, u.id)], { as: 'mod' });
      assert.ok(!h.isError(rec), h.replyText(rec));
    }
    await h.asHuman('mod').perform('DELETE', `/guilds/${h.guild.id}/bans/${users[2].id}`);
    await drain(h);
    assert.deepEqual(users.map((u) => h.fake.bans.has(u.id)), [true, true, true], 'débannis via le bot non rebannis');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S25 : /derank ×2 puis 1 retrait manuel (roleRemove par défaut) → les 3 rôles sensibles sont rendus', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: false }, secur: { modules: { roleRemove: { mode: 'on' } } } });
    const staff = [await addStaff(h, 'Victime0'), await addStaff(h, 'Victime1'), await addStaff(h, 'Victime2')];
    for (const id of staff.slice(0, 2)) {
      const rec = await h.slash('derank', [opt('membre', 6, id)]);
      if (h.messagesOf(rec).some((m) => (m.components ?? []).length)) await h.confirm(rec);
      await h.settle();
      assert.equal(hasRole(h, id, IDS.roles.mod), false, 'derank non appliqué');
    }
    await h.asHuman('admin').removeRole(staff[2], IDS.roles.mod);
    await drain(h);
    assert.deepEqual(staff.map((id) => hasRole(h, id, IDS.roles.mod)), [true, true, true], 'rôles retirés via /derank non rendus');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S40 : « Débannir » sur un auteur blacklisté                                                 */
/* ------------------------------------------------------------------------------------------ */

test('S40 : bouton « Débannir » d\'une carte Secur sur un blacklisté → refus clair, incident non clos, aucun débannissement', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const t = IDS.users.target;
    const add = await h.slash('secur', [{ name: 'blacklist', type: 2, options: [{ name: 'ajouter', type: 1, options: [opt('membre', 6, t), opt('raison', 3, 'nuke')] }] }], { as: 'owner' });
    assert.ok(!h.isError(add), h.replyText(add));
    const id = h.client.repositories.securityIncidents.create({ guildId: h.guild.id, executorId: t, modules: ['channelDelete'], actions: 3, punishment: 'ban', outcome: 'applied' });
    const msg = h.fake.buildMessage({ channelId: IDS.channels.logs, body: { content: '', components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Débannir', custom_id: `secur:restore:${id}` }] }] }, author: h.fake.users.get(h.client.user.id) });
    const callMark = h.fake.calls.length;
    const rec = await h.click(msg, `secur:restore:${id}`, { as: 'owner' });
    await h.settle();
    assert.match(h.replyText(rec), /liste noire/);
    assert.equal(h.client.repositories.securityIncidents.get(h.guild.id, id).restored_by, null, 'incident clos par un faux succès');
    assert.equal(h.fake.calls.slice(callMark).filter((c) => c.method === 'DELETE' && c.route.includes(`/bans/${t}`)).length, 0, 'débannissement tenté');
    assert.ok(h.fake.bans.has(t));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S43 : membres partiels créés par PRESENCE_UPDATE                                            */
/* ------------------------------------------------------------------------------------------ */

const { config: botConfig } = require('../../src/config');

async function presenceHarness() {
  const prev = botConfig.presenceIntent;
  botConfig.presenceIntent = true;
  try {
    return await createHarness();
  } finally {
    botConfig.presenceIntent = prev;
  }
}

function online(h, userId, state = null) {
  h.fake.dispatchNow('PRESENCE_UPDATE', {
    user: { id: userId }, guild_id: h.guild.id, status: 'online',
    activities: state ? [{ type: 4, name: 'Custom Status', state, created_at: Date.now() }] : [],
    client_status: { desktop: 'online' },
  });
}

async function partialAuthor(h, who, { wlRoles = [] } = {}) {
  securOnly(h, { channelCreate: { mode: 'on', limit: 1, windowSeconds: 30 } }, { whitelist: { users: [], roles: wlRoles } });
  const uid = IDS.users[who];
  h.guild.members.cache.delete(uid); // gros serveur : hors cache au démarrage
  online(h, uid);
  await h.settle();
  const created = await h.fake.perform('POST', `/guilds/${h.guild.id}/channels`, { name: 'salon-x', type: 0 }, { actorId: IDS.users.owner });
  await h.settle();
  await h.auditEntry({ action_type: 10, target_id: created.id, user_id: uid, changes: [{ key: 'name', new_value: 'salon-x' }, { key: 'type', new_value: 0 }] });
  await drain(h);
  return { uid, created };
}

test('S43 : auteur hors cache puis PRESENCE_UPDATE → le derank retire bien ses rôles', async () => {
  const h = await presenceHarness();
  try {
    const { uid } = await partialAuthor(h, 'admin');
    const [incident] = incidentsOf(h);
    assert.equal(incident.punishment, 'derank', 'derank sans effet sur un membre partiel');
    assert.equal(hasRole(h, uid, IDS.roles.admin), false);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S43 : modérateur whitelisté par rôle, hors cache puis PRESENCE_UPDATE → exempté (aucun incident)', async () => {
  const h = await presenceHarness();
  try {
    const { created } = await partialAuthor(h, 'mod', { wlRoles: [IDS.roles.mod] });
    assert.equal(incidentsOf(h).length, 0, 'whitelist par rôle ignorée');
    assert.ok(h.fake.channels.has(created.id), 'salon légitime annulé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S43 : rôle soutien (statut), membre hors cache puis PRESENCE_UPDATE sans le texte → le rôle est retiré', async () => {
  const h = await presenceHarness();
  try {
    h.configureAll();
    const ROLE = IDS.roles.temp;
    const uid = IDS.users.target;
    h.configure({ support: { enabled: true, roleId: ROLE, source: 'statut', text: 'gadget' } });
    h.client.services.supportRole.debounceMs = 20;
    h.fake.members.get(uid).roles.push(ROLE);
    h.guild.members.cache.delete(uid);
    online(h, uid, 'rien à voir');
    await new Promise((r) => setTimeout(r, 150));
    await h.settle();
    assert.equal(hasRole(h, uid, ROLE), false, 'rôle soutien jamais retiré');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ========================================================================================== */
/* Périmètre, journal, audit                                                                  */
/* ========================================================================================== */

const S = require('../../src/utils/secur');
const embedText = (m) => (m?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');
const updatedMsg = (h, rec) => h.message(rec.componentMessageId ?? rec.original);

/* ------------------------------------------------------------------------------------------ */
/* S13 : seuil ban/kick hérité par Secur                                                       */
/* ------------------------------------------------------------------------------------------ */

async function raiseBanThreshold(h, as, value) {
  const dash = await h.slash('antiraid', [], { as });
  const view = await h.click(h.message(dash.original), 'cmd:antiraid:nav', { as, values: ['destructive'] });
  const text = embedText(updatedMsg(h, view));
  const form = await h.click(updatedMsg(h, view), 'cmd:antiraid:set:destructive', { as });
  const saved = await h.submitModal(form, { channelDeleteThreshold: '', roleDeleteThreshold: '', banThreshold: String(value), kickThreshold: '', destructiveWindowSeconds: '' }, { as });
  return { text, saved };
}

test('S13 : relever via /antiraid le seuil « Bannissements » repris par Secur exige le niveau owner, et le relèvement est critique', async () => {
  const h = await createHarness();
  try {
    h.configure({
      logChannels: { security: IDS.channels.logs },
      antiraid: { enabled: false, banThreshold: 3, alertChannel: IDS.channels.logs },
      automod: { enabled: false },
      secur: { modules: { ban: { mode: 'on', limit: null } } },
    });
    const limit = () => S.effectiveLimit(h.client.services.config.get(h.guild.id), 'ban');
    const { text, saved } = await raiseBanThreshold(h, 'admin', 100);
    assert.doesNotMatch(text, /Bannissements \(mode on\)[^\n]*ne s'appliquent plus/, 'texte faux : ce seuil EST celui de Secur');
    assert.match(text, /Repris par Secur/);
    assert.ok(h.isError(saved), 'un admin non owner abaisse Secur via /antiraid');
    assert.equal(limit(), 3);
    // Owner : accepté, mais journalisé comme critique (carte critique + MP au propriétaire hors filtres).
    const mark = h.fake.messageLog.length;
    const ok = await raiseBanThreshold(h, 'owner', 100);
    assert.ok(!h.isError(ok.saved), h.replyText(ok.saved));
    assert.equal(limit(), 100);
    await h.settle();
    const critical = botMessages(h, mark, (m) => /Secur abaissé : Bannissements \(limite 3 → 100\)/.test(embedText(m)));
    assert.ok(critical.length >= 1, 'relèvement du seuil Secur hérité non classé critique');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S13 (annexe) : un owner resserre /secur module ban de 50 (hérité) à 10 → jamais classé « Secur abaissé »', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, antiraid: { enabled: false, banThreshold: 50 }, automod: { enabled: false }, secur: { modules: { ban: { mode: 'on', limit: null } } } });
    const mark = h.fake.messageLog.length;
    const rec = await h.slash('secur', [{ name: 'module', type: 1, options: [opt('module', 3, 'ban'), opt('mode', 3, 'on'), opt('seuil', 4, 10)] }], { as: 'owner' });
    assert.ok(!h.isError(rec), h.replyText(rec));
    await h.settle();
    assert.equal(S.effectiveLimit(h.client.services.config.get(h.guild.id), 'ban'), 10);
    assert.equal(botMessages(h, mark, (m) => /Secur abaissé/.test(embedText(m))).length, 0, 'resserrement classé « Secur abaissé (limite 3 → 10) »');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S15 : le bot perd « Voir les logs du serveur »                                              */
/* ------------------------------------------------------------------------------------------ */

/** Bot sans Administrateur ; co-admin au-dessus de lui ; entrées d'audit remises au bot SEULEMENT s'il a « Voir les logs » (règle de Discord). */
async function blindHarness() {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  h.configure({ logChannels: { security: IDS.channels.general }, antiraid: { alertChannel: IDS.channels.general }, secur: { modules: { channelDelete: { mode: 'on' } } } });
  h.fake.roles.get(IDS.roles.admin).position = 8;
  h.guild.roles.cache.get(IDS.roles.admin).rawPosition = 8;
  const viewAudit = () => {
    const m = h.fake.members.get(IDS.users.bot);
    let bits = BigInt(h.fake.roles.get(h.guild.id).permissions);
    for (const r of m?.roles ?? []) bits |= BigInt(h.fake.roles.get(r)?.permissions ?? 0);
    return (bits & P.Administrator) !== 0n || (bits & P.ViewAuditLog) !== 0n;
  };
  const orig = h.fake.dispatchNow.bind(h.fake);
  h.fake.dispatchNow = (t, d, label) => (t === 'GUILD_AUDIT_LOG_ENTRY_CREATE' && !viewAudit() ? undefined : orig(t, d, label));
  return h;
}
const blindAlerts = (h, mark) => botMessages(h, mark, titled(/Secur est aveugle|Secur affaibli/));

test('S15 : un co-admin retire « Voir les logs » au rôle du bot → alerte critique (salon + MP au propriétaire) avant le nuke invisible', async () => {
  const h = await blindHarness();
  try {
    const mark = h.fake.messageLog.length;
    const botRole = h.fake.roles.get(IDS.roles.bot);
    await h.asHuman('admin').editRole(IDS.roles.bot, { permissions: String(BigInt(botRole.permissions) & ~P.ViewAuditLog) });
    await h.settle();
    const alerts = blindAlerts(h, mark);
    assert.ok(alerts.some(inGuild(h)), 'perte de « Voir les logs » sans alerte');
    assert.ok(alerts.some((m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === IDS.users.owner), 'propriétaire non prévenu en MP');
    assert.match(embedText(alerts[0]), /Voir les logs/);
    // Une permission accordée au bot (réglage d'un admin) ne déclenche rien.
    const again = h.fake.messageLog.length;
    await h.asHuman('admin').editRole(IDS.roles.bot, { permissions: String(BigInt(h.fake.roles.get(IDS.roles.bot).permissions) | P.ViewAuditLog) });
    await h.settle();
    assert.equal(blindAlerts(h, again).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S15 : rôle non géré qui donnait « Gérer les rôles » retiré au bot → alerte « Secur affaibli » ; Secur coupé → aucune alerte', async () => {
  const h = await blindHarness();
  try {
    const botRole = h.fake.roles.get(IDS.roles.bot);
    botRole.permissions = String(BigInt(botRole.permissions) & ~P.ManageRoles);
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role: botRole });
    const keeper = addRole(h, { name: 'Gardien', permissions: P.ManageRoles, position: 2 });
    giveRoles(h, IDS.users.bot, [keeper.id]);
    await h.settle();
    const mark = h.fake.messageLog.length;
    await h.asHuman('admin').removeRole('bot', keeper.id);
    await h.settle();
    const alerts = blindAlerts(h, mark).filter(inGuild(h));
    assert.equal(alerts.length, 1, 'perte de « Gérer les rôles » sans alerte');
    assert.match(embedText(alerts[0]), /Gérer les rôles/);
    // Secur coupé (et AntiRaid coupé) : rien à protéger, aucune alerte.
    h.configure({ antiraid: { enabled: false }, secur: { modules: { channelDelete: { mode: 'off' } } } });
    giveRoles(h, IDS.users.bot, [keeper.id]);
    await h.settle();
    const quiet = h.fake.messageLog.length;
    await h.asHuman('admin').removeRole('bot', keeper.id);
    await h.settle();
    assert.equal(blindAlerts(h, quiet).length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S16 : timeouts en masse et suppressions de fils                                             */
/* ------------------------------------------------------------------------------------------ */

async function addPlain(h, name) {
  const u = h.addUser(name, { ageDays: 900 });
  const m = rawMember(u, [], 300);
  h.fake.members.set(u.id, m);
  h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...m, guild_id: h.guild.id });
  await h.settle();
  return u.id;
}

test('S16 : préréglage max — un modérateur met 6 membres en timeout 27 jours → incident, dérank, timeouts levés', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, antiraid: { enabled: false }, automod: { enabled: false } });
    const { defaultGuildConfig } = require('../../src/config/defaults');
    h.configure({ secur: { modules: S.presetPatch('max', defaultGuildConfig.secur.modules) } });
    assert.ok(h.client.services.secur.registry.has('timeout'), 'module « timeout » absent');
    const victims = [];
    for (let i = 0; i < 6; i += 1) victims.push(await addPlain(h, `Muet${i}`));
    const until = new Date(Date.now() + 27 * 86_400_000).toISOString();
    for (const id of victims) await h.asHuman('mod').perform('PATCH', `/guilds/${h.guild.id}/members/${id}`, { communication_disabled_until: until }).catch(() => {});
    await drain(h);
    const [incident] = incidentsOf(h);
    assert.ok(incident, 'timeouts en masse sans incident, même en max');
    assert.match(String(incident.modules), /timeout/);
    assert.equal(hasRole(h, IDS.users.mod, IDS.roles.mod), false, 'modérateur non sanctionné');
    const still = victims.filter((id) => h.fake.members.get(id)?.communication_disabled_until);
    assert.equal(still.length, 0, `timeouts non levés : ${still.length}/6`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('S16 : préréglage on — suppression de 5 posts de forum (audit 112) → incident ; un timeout retiré n\'est jamais compté', async () => {
  const h = await createHarness();
  try {
    h.configure({ logChannels: { security: IDS.channels.logs }, antiraid: { enabled: false }, automod: { enabled: false } });
    const { defaultGuildConfig } = require('../../src/config/defaults');
    h.configure({ secur: { modules: S.presetPatch('on', defaultGuildConfig.secur.modules) } });
    // Lever un timeout (retour à la normale) : jamais destructeur.
    const muted = await addPlain(h, 'DejaMuet');
    h.fake.members.get(muted).communication_disabled_until = new Date(Date.now() + 3_600_000).toISOString();
    for (let i = 0; i < 6; i += 1) await h.auditEntry({ action_type: 24, target_id: muted, user_id: IDS.users.mod, changes: [{ key: 'communication_disabled_until', old_value: new Date(Date.now() + 3_600_000).toISOString() }] });
    await drain(h);
    assert.equal(incidentsOf(h).length, 0, 'levée de timeout comptée');
    const limit = S.effectiveLimit(h.client.services.config.get(h.guild.id), 'threadDelete');
    for (let i = 0; i < limit; i += 1) await h.auditEntry({ action_type: 112, target_id: nextId(), user_id: IDS.users.mod, changes: [{ key: 'name', old_value: `post-${i}` }, { key: 'type', old_value: 11 }] });
    await drain(h);
    const [incident] = incidentsOf(h);
    assert.ok(incident, 'suppressions de fils sans incident');
    assert.equal(hasRole(h, IDS.users.mod, IDS.roles.mod), false);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S33 : mode strict et restrictions posées par le propriétaire                                */
/* ------------------------------------------------------------------------------------------ */

test('S33 : /ban restreinte par le propriétaire (sanctions lourdes) → un administrateur ne peut pas couper le mode strict ; le propriétaire le peut', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const perm = (name, options, as) => h.slash('permissions', sub(name, options), { as });
    const assigned = await perm('commande', [opt('nom', 3, 'ban'), opt('niveau', 4, 3)], 'owner');
    assert.ok(!h.isError(assigned), h.replyText(assigned));
    h.configure({ permissions: { strict: true } });
    const home = await perm('panneau', [], 'admin');
    const panel = h.messagesOf(home)[0];
    const view = await h.click(panel, 'cmd:permissions:nav', { as: 'admin', values: ['strict'] });
    const strictMsg = h.message(view.componentMessageId ?? panel.id);
    const off = await h.click(strictMsg, 'cmd:permissions:strict:off', { as: 'admin' });
    assert.ok(h.isError(off), 'un administrateur neutralise la restriction du propriétaire');
    assert.match(h.replyText(off), /propriétaire/);
    assert.equal(h.client.services.permissions.settings(h.guild.id).strict, true);
    const byOwner = await h.click(strictMsg, 'cmd:permissions:strict:off', { as: 'owner' });
    assert.ok(!h.isError(byOwner), h.replyText(byOwner));
    assert.equal(h.client.services.permissions.settings(h.guild.id).strict, false);
    // Réactiver reste ouvert aux administrateurs (cela ne fait que restreindre).
    const on = await h.click(h.message(strictMsg.id), 'cmd:permissions:strict:on', { as: 'admin' });
    assert.ok(!h.isError(on), h.replyText(on));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------ */
/* S46 : correction C1 et « Mentionner @everyone » du bot                                      */
/* ------------------------------------------------------------------------------------------ */

test('S46 : C1 prévient que le bot perdra « Mentionner @everyone » ; /invite le demande et /diagnostics le signale ensuite', async () => {
  const { INVITE_PERMISSIONS } = require('../../src/commands/utility/invite');
  assert.ok(INVITE_PERMISSIONS.includes('MentionEveryone'), '/invite ne demande pas « Mentionner @everyone »');
  const h = await createHarness({ botAdministrator: false });
  try {
    h.configureAll();
    const everyonePerms = () => BigInt(h.fake.roles.get(IDS.roles.everyone).permissions);
    await h.asHuman('owner').editRole(IDS.roles.everyone, { permissions: String(everyonePerms() | P.MentionEveryone) });
    await h.settle();
    assert.ok(h.guild.members.me.permissions.has(P.MentionEveryone));
    const rec = await h.slash('diagnostics', [], { as: 'admin' });
    const msg = h.messagesOf(rec)[0];
    await h.click(msg, 'cmd:diagnostics:audit', { as: 'admin' });
    await h.settle();
    let view = h.message(msg.id);
    await h.click(view, 'cmd:diagnostics:fix:everyone_perms', { as: 'admin' });
    view = h.message(msg.id);
    assert.match(embedText(view), /perdrai moi-même[^\n]*Mentionner @everyone/, 'la confirmation ne prévient pas que le bot perd la permission');
    await h.click(view, 'cmd:diagnostics:fixok:everyone_perms', { as: 'admin' });
    await h.settle();
    assert.equal(h.guild.members.me.permissions.has(P.MentionEveryone), false);
    const rec2 = await h.slash('diagnostics', [], { as: 'admin' });
    assert.match(JSON.stringify(h.messagesOf(rec2)[0].embeds), /Mentionner @everyone/, '/diagnostics ne signale pas la permission perdue');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
