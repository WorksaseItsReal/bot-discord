'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { SanctionRepository, isEnforced } = require('../src/database/repositories/SanctionRepository');
const sanctions = require('../src/commands/moderation/sanctions');
const tempban = require('../src/commands/moderation/tempban');
const voice = require('../src/commands/voice/voice');
const antiraid = require('../src/commands/security/antiraid');
const guildMemberAdd = require('../src/events/guildMemberAdd');
const { AntiRaidService, newAccountAction, MAX_WAVE_PUNISH } = require('../src/services/AntiRaidService');

const UID = '111111111111111111';
const HOUR = 3_600_000;

// ---------------------------------------------------------------- /sanctions remove|clear

function sanctionsSetup() {
  const { db } = memoryDb();
  const repo = new SanctionRepository(db);
  const resets = [];
  const client = { repositories: { sanctions: repo }, services: { strikes: { reset: (...a) => resets.push(a), getCount: () => 0 } } };
  const interaction = (sub, { id, user } = {}) => ({
    guild: { id: 'g1' },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.ModerateMembers },
    options: { getSubcommand: () => sub, getInteger: () => id, getUser: () => user },
    replies: [],
    async reply(p) { this.replies.push(p); },
  });
  return { repo, client, interaction, resets };
}

test('isEnforced : expiration future, ou mute actif sans échéance', () => {
  const now = Date.now();
  assert.equal(isEnforced({ active: 1, type: 'tempban', expires_at: now + HOUR }, now), true);
  assert.equal(isEnforced({ active: 1, type: 'tempban', expires_at: now - 1 }, now), false);
  assert.equal(isEnforced({ active: 1, type: 'mute', expires_at: null }, now), true);
  assert.equal(isEnforced({ active: 0, type: 'mute', expires_at: null }, now), false);
  assert.equal(isEnforced({ active: 1, type: 'warn', expires_at: null }, now), false);
});

test('/sanctions remove refuse une sanction en vigueur, accepte une sanction terminée', async () => {
  const { repo, client, interaction } = sanctionsSetup();
  const tb = repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'tempban', durationMs: HOUR, expiresAt: Date.now() + HOUR });
  const warn = repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'warn' });
  await assert.rejects(sanctions.execute(interaction('remove', { id: tb }), client), /encore en vigueur[\s\S]*\/unban/);
  assert.ok(repo.get('g1', tb), 'le ban temporaire est conservé');
  const i = interaction('remove', { id: warn });
  await sanctions.execute(i, client);
  assert.equal(repo.get('g1', warn), undefined);
  assert.equal(i.replies.length, 1);
});

test('/sanctions clear refuse tant qu\'un mute / timeout est en vigueur', async () => {
  const { repo, client, interaction, resets } = sanctionsSetup();
  const user = { id: UID, toString: () => `<@${UID}>` };
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'warn' });
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'mute' });
  await assert.rejects(sanctions.execute(interaction('clear', { user }), client), /\/unmute/);
  assert.equal(repo.count('g1', UID), 2);
  assert.equal(resets.length, 0, 'strikes intacts');
  repo.deactivateActive('g1', UID, 'mute');
  repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'timeout', expiresAt: Date.now() - 1 });
  await sanctions.execute(interaction('clear', { user }), client);
  assert.equal(repo.count('g1', UID), 0);
  assert.equal(resets.length, 1);
});

// ---------------------------------------------------------------- guildMemberAdd : mute réappliqué

function joinSetup({ mute, roleExists = true, punished = false } = {}) {
  const { db } = memoryDb();
  const repo = new SanctionRepository(db);
  if (mute) repo.create({ guildId: 'g1', userId: UID, moderatorId: 'm', type: 'mute', ...mute });
  const added = [];
  const logs = [];
  const role = { id: 'muted', toString: () => '<@&muted>' };
  const member = {
    id: UID,
    guild: { id: 'g1', memberCount: 3 },
    user: { id: UID, bot: false, createdTimestamp: Date.now() - 100 * 86_400_000, toString: () => `<@${UID}>`, displayAvatarURL: () => null },
    roles: { cache: new Collection(), add: async (r, reason) => added.push({ r, reason }) },
  };
  const client = {
    repositories: { sanctions: repo },
    services: {
      antiraid: { handleJoin: async () => ({ punished }) },
      moderation: { mutedRole: () => (roleExists ? role : null) },
      logging: { send: async (guildId, category, embed, components, ctx) => logs.push({ category, ctx, embed: embed.toJSON() }) },
    },
  };
  return { client, member, added, logs };
}

test('guildMemberAdd : un mute actif est réappliqué au retour et journalisé', async () => {
  const { client, member, added, logs } = joinSetup({ mute: { expiresAt: Date.now() + HOUR } });
  await guildMemberAdd.execute(client, member);
  assert.equal(added.length, 1);
  assert.equal(added[0].r.id, 'muted');
  assert.deepEqual(logs.map((l) => [l.category, l.ctx.event]), [['members', 'memberJoin'], ['moderation', 'sanction']]);
  assert.match(logs[1].embed.title, /Mute réappliqué/);
});

test('guildMemberAdd : mute expiré, absence de rôle ou membre expulsé par l\'AntiRaid → rien', async () => {
  for (const setup of [
    joinSetup({ mute: { expiresAt: Date.now() - 1 } }),
    joinSetup({ mute: {}, roleExists: false }),
    joinSetup({ mute: {}, punished: true }),
    joinSetup(),
  ]) {
    await guildMemberAdd.execute(setup.client, setup.member);
    assert.equal(setup.added.length, 0);
    assert.deepEqual(setup.logs.map((l) => l.ctx.event), ['memberJoin']);
  }
  // Mute sans échéance : réappliqué.
  const perm = joinSetup({ mute: {} });
  await guildMemberAdd.execute(perm.client, perm.member);
  assert.equal(perm.added.length, 1);
});

// ---------------------------------------------------------------- /tempban : confirmDangerous

test('/tempban demande une confirmation si moderation.confirmDangerous', async () => {
  let banned = 0;
  let deferred = 0;
  const prompts = [];
  const message = { awaitMessageComponent: async () => { throw new Error('timeout'); }, edit: async () => {} };
  const interaction = {
    id: 'i1',
    guild: { id: 'g1', members: { cache: new Collection() } },
    user: { id: 'mod' },
    member: { id: 'mod' },
    options: {
      getUser: () => ({ id: UID }),
      getString: (n) => (n === 'duree' ? '1h' : null),
      getMember: () => null,
    },
    deferReply: async () => { deferred += 1; },
    reply: async (p) => { prompts.push(p); return message; },
    editReply: async () => message,
    followUp: async () => message,
    webhook: { editMessage: async () => {} },
  };
  const client = {
    services: {
      config: { get: () => ({ moderation: { confirmDangerous: true } }) },
      moderation: { ban: async () => { banned += 1; return { id: 1, expiresAt: Date.now() + HOUR }; } },
    },
  };
  await tempban.execute(interaction, client);
  assert.equal(prompts.length, 1, 'confirmation affichée');
  assert.match(JSON.stringify(prompts[0].embeds[0].toJSON()), /Confirmation requise/);
  assert.equal(banned, 0, 'délai dépassé : aucun ban');
  assert.equal(deferred, 0);
});

// ---------------------------------------------------------------- /voice : hiérarchie

const g = { ownerId: 'owner' };
const mk = (id, position, extra = {}) => ({ id, guild: g, roles: { highest: { position } }, ...extra });

test('/voice cleanup ignore les membres au rôle supérieur ou égal', async () => {
  const disconnected = [];
  const voiceOf = (id) => ({ disconnect: async () => disconnected.push(id) });
  const members = new Collection([
    ['low', mk('low', 1, { voice: voiceOf('low') })],
    ['high', mk('high', 9, { voice: voiceOf('high') })],
    ['owner', mk('owner', 0, { voice: voiceOf('owner') })],
  ]);
  const channel = { members, toString: () => '<#v1>' };
  let reply;
  const interaction = {
    user: { id: 'mod', tag: 'mod' },
    member: mk('mod', 5),
    guild: { members: { me: mk('bot', 20) } },
    options: { getSubcommand: () => 'cleanup', getChannel: () => channel },
    deferReply: async () => {},
    editReply: async (p) => { reply = p; },
  };
  await voice.execute(interaction);
  assert.deepEqual(disconnected, ['low']);
  assert.match(JSON.stringify(reply.embeds[0].toJSON()), /Ignorés \(hiérarchie\)/);
});

test('/voice moveback : hiérarchie vérifiée avant le déplacement', async () => {
  const moved = [];
  const target = mk('high', 9, { voice: { channel: { id: 'v2' }, setChannel: async (c) => moved.push(c) } });
  const interaction = {
    user: { id: 'mod', tag: 'mod' },
    memberPermissions: { has: () => true },
    member: mk('mod', 5),
    guild: {
      members: { fetch: async () => target, me: mk('bot', 20) },
      channels: { cache: new Collection([['v1', { id: 'v1', isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }) }]]) },
    },
  };
  await assert.rejects(voice.buttons.moveback(interaction, {}, ['high', 'v1', 'mod']), /rôle est supérieur/);
  assert.equal(moved.length, 0);
});

// ---------------------------------------------------------------- AntiRaid

function raidSetup(cfg = {}, { whitelist = { users: [], roles: [] } } = {}) {
  const kicked = [];
  const banned = [];
  const alerts = [];
  const members = new Collection();
  const guild = {
    id: 'g1',
    ownerId: 'owner',
    members: { cache: members, fetch: async (id) => members.get(id) ?? null },
    bans: { create: async (id) => banned.push(id) },
  };
  const antiraidCfg = { enabled: true, joinThreshold: 3, joinWindowSeconds: 10, minAccountAgeDays: 0, antiBot: false, action: 'kick', ...cfg };
  const config = { get: () => ({ antiraid: antiraidCfg, whitelist }) };
  const client = { user: { id: 'bot' }, services: {} };
  const service = new AntiRaidService({ client, config, logging: { send: async (...a) => alerts.push(a) } });
  const join = (id, { bot = false, ageDays = 365, roles = [] } = {}) => {
    const member = {
      id,
      guild,
      kickable: true,
      bannable: true,
      user: { id, bot, createdTimestamp: Date.now() - ageDays * 86_400_000, toString: () => `<@${id}>`, displayAvatarURL: () => null },
      roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) },
      kick: async () => kicked.push(id),
      ban: async () => banned.push(id),
    };
    members.set(id, member);
    return service.handleJoin(member);
  };
  return { service, join, kicked, banned, alerts, members };
}

test('AntiRaid : une vague en mode kick expulse les arrivants de la fenêtre', async () => {
  const { join, kicked, alerts } = raidSetup();
  await join('a');
  await join('b');
  const res = await join('c');
  assert.deepEqual(kicked.sort(), ['a', 'b', 'c']);
  assert.equal(res.punished, true);
  assert.equal(alerts.length, 1);
  assert.match(JSON.stringify(alerts[0][2].toJSON()), /Expulsés/);
});

test('AntiRaid : vague en mode ban, whitelist (rôle reçu depuis l\'arrivée) respectée', async () => {
  const { join, banned, members } = raidSetup({ action: 'ban' }, { whitelist: { users: [], roles: ['trusted'] } });
  await join('a');
  await join('b');
  // « a » a reçu un rôle de confiance entre-temps : épargné.
  members.get('a').roles.cache.set('trusted', { id: 'trusted' });
  await join('c');
  assert.deepEqual(banned.sort(), ['b', 'c']);
});

test('AntiRaid : mode lockdown ne sanctionne personne ; plafond de sécurité exposé', async () => {
  const { join, kicked } = raidSetup({ action: 'lockdown' });
  for (const id of ['a', 'b', 'c']) await join(id);
  assert.equal(kicked.length, 0);
  assert.ok(MAX_WAVE_PUNISH > 0 && MAX_WAVE_PUNISH <= 100);
});

test('AntiRaid : la sanction des comptes récents est indépendante de l\'action de vague', async () => {
  assert.equal(newAccountAction({}), 'kick');
  assert.equal(newAccountAction({ newAccountAction: 'ban' }), 'ban');
  assert.equal(newAccountAction({ newAccountAction: 'lockdown' }), 'kick');
  // Non réglé : compatibilité avec l'ancien comportement (vague en ban → comptes récents bannis).
  assert.equal(newAccountAction({ action: 'ban' }), 'ban');
  assert.equal(newAccountAction({ action: 'lockdown' }), 'kick');
  // Vague en ban, mais comptes récents expulsés si configuré.
  const a = raidSetup({ action: 'ban', minAccountAgeDays: 7, newAccountAction: 'kick' });
  assert.deepEqual(await a.join('young', { ageDays: 1 }), { punished: true });
  assert.deepEqual([a.kicked, a.banned], [['young'], []]);
  // Vague en lockdown, comptes récents bannis si configuré.
  const b = raidSetup({ action: 'lockdown', minAccountAgeDays: 7, newAccountAction: 'ban' });
  await b.join('young', { ageDays: 1 });
  assert.deepEqual([b.kicked, b.banned], [[], ['young']]);
});

test('/antiraid (tableau de bord) : chaque réglage de l\'ancien /antiraid set est modifiable', async () => {
  assert.equal((antiraid.data.toJSON().options ?? []).length, 0, 'plus de sous-commande');
  const patches = [];
  const stored = { antiraid: { enabled: true, joinThreshold: 10, joinWindowSeconds: 10, minAccountAgeDays: 0, antiBot: false, channelDeleteThreshold: 3, roleDeleteThreshold: 3, banThreshold: 5, destructiveWindowSeconds: 10, punishExecutor: 'strip', action: 'kick', alertChannel: null }, whitelist: {} };
  const client = { services: { config: { get: () => stored, update: (gid, p) => { patches.push(p.antiraid); Object.assign(stored.antiraid, p.antiraid); } } } };
  const ALERT = '200000000000000001';
  const updates = [];
  const i = (extra = {}) => ({
    guildId: 'g1',
    guild: { id: 'g1', channels: { cache: new Collection([[ALERT, { id: ALERT, type: 0 }]]) } },
    memberPermissions: { has: (f) => f === PermissionFlagsBits.Administrator },
    update: async (p) => updates.push(p),
    showModal: async () => {},
    ...extra,
  });
  const modal = (values) => i({ fields: { getTextInputValue: (id) => values[id] ?? '' } });

  // seuil_salons / seuil_roles / seuil_bans / fenetre_destructive (0 = désactivé)
  await antiraid.buttons.setsubmit(modal({ channelDeleteThreshold: '0', roleDeleteThreshold: '4', banThreshold: '7', destructiveWindowSeconds: '30' }), client, ['destructive']);
  assert.deepEqual(patches.at(-1), { channelDeleteThreshold: 0, roleDeleteThreshold: 4, banThreshold: 7, destructiveWindowSeconds: 30 });
  // join_seuil / join_fenetre
  await antiraid.buttons.setsubmit(modal({ joinThreshold: '6', joinWindowSeconds: '15' }), client, ['joins']);
  assert.deepEqual(patches.at(-1), { joinThreshold: 6, joinWindowSeconds: 15 });
  // age_min_jours
  await antiraid.buttons.setsubmit(modal({ minAccountAgeDays: '7' }), client, ['accounts']);
  assert.deepEqual(patches.at(-1), { minAccountAgeDays: 7 });
  // sanction_auteur / nouveaux_comptes / action
  await antiraid.buttons.executor(i({ values: ['ban'] }), client);
  await antiraid.buttons.newaccount(i({ values: ['ban'] }), client);
  await antiraid.buttons.action(i({ values: ['lockdown'] }), client);
  // anti_bot (valeur cible, jamais d'inversion à l'aveugle) / alertes
  await antiraid.buttons.antibot(i(), client, ['on']);
  await antiraid.buttons.antibot(i(), client, ['on']);
  await antiraid.buttons.alertch(i({ values: [ALERT] }), client);
  assert.deepEqual(patches.slice(3), [{ punishExecutor: 'ban' }, { newAccountAction: 'ban' }, { action: 'lockdown' }, { antiBot: true }, { antiBot: true }, { alertChannel: ALERT }]);

  // Saisies hors bornes refusées, rien n'est écrit.
  const before = patches.length;
  await assert.rejects(antiraid.buttons.setsubmit(modal({ channelDeleteThreshold: '101' }), client, ['destructive']), { name: 'UserError' });
  await assert.rejects(antiraid.buttons.setsubmit(modal({ joinThreshold: '1' }), client, ['joins']), { name: 'UserError' });
  await assert.rejects(antiraid.buttons.action(i({ values: ['nuke'] }), client), { name: 'UserError' });
  assert.equal(patches.length, before);

  const json = JSON.stringify(antiraid.render(client, { id: 'g1' }, 'home').embeds[0].toJSON());
  assert.match(json, /Désactivé/);
  assert.match(json, /Comptes récents/);
  assert.match(json, /Tableau de bord/);
  assert.equal(antiraid.data.toJSON().default_member_permissions, String(PermissionFlagsBits.Administrator));
});
