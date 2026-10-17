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
