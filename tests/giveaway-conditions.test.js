'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { LevelRepository } = require('../src/database/repositories/LevelRepository');
const { InviteJoinRepository } = require('../src/database/repositories/InviteJoinRepository');
const { GiveawayService, conditions, hasConditions, unmetConditions, isEligible } = require('../src/services/GiveawayService');
const { levelFromXp, totalXpForLevel } = require('../src/services/LevelService');
const giveaway = require('../src/commands/giveaways/giveaway');

const DAY = 86_400_000;
const GUILD = 'g1';
const A = '200000000000000001';
const B = '200000000000000002';
const C = '200000000000000003';

const member = (id, { roles = [], joinedDaysAgo = 400 } = {}) => ({ id, roles: { cache: new Collection(roles.map((r) => [r, {}])) }, joinedTimestamp: Date.now() - joinedDaysAgo * DAY });

test('unmetConditions / isEligible : niveau, invitations, ancienneté et rôles ; messages clairs', () => {
  const g = { required_role: null, forbidden_role: null, min_level: 5, min_invites: 2, min_days: 30 };
  const m = member(A);
  const keys = (stats) => unmetConditions(g, { member: m, joinedAt: m.joinedTimestamp, ...stats }).map((u) => u.key);
  assert.deepEqual(keys({ level: 0, invites: 0 }), ['min_level', 'min_invites']);
  assert.deepEqual(keys({ level: 5, invites: 2 }), []);
  const unmet = unmetConditions(g, { member: m, level: 3, invites: 1, joinedAt: Date.now() - 10 * DAY });
  assert.match(unmet[0].message, /niveau 5.*vous êtes niveau \*\*3\*\*/);
  assert.match(unmet[1].message, /2 invitations\*\* valides.*vous en avez \*\*1\*\*/);
  assert.match(unmet[2].message, /30 jours.*<t:\d+:R>/);
  assert.deepEqual(unmetConditions(g, { member: m, level: 9, invites: 9, joinedAt: null }).map((u) => u.key), ['min_days'], 'date d\'arrivée inconnue : refus prudent');
  // Rôles : comportement d'origine conservé.
  const roles = { required_role: 'r1', forbidden_role: 'r2' };
  assert.equal(isEligible(roles, member(A, { roles: ['r1'] })), true);
  assert.equal(isEligible(roles, member(A, { roles: ['r1', 'r2'] })), false);
  assert.equal(isEligible(roles, member(A)), false);
  assert.equal(isEligible({}, member(A)), true, 'sans condition');
  assert.equal(isEligible({ min_days: 7 }, member(A, { joinedDaysAgo: 3 })), false, 'ancienneté lue sur le membre');
  assert.equal(isEligible({ min_days: 7 }, member(A, { joinedDaysAgo: 8 })), true);
  assert.equal(isEligible({ min_level: 2 }, member(A), { level: 2 }), true);
});

test('conditions / hasConditions : affichage sur la carte', () => {
  assert.equal(hasConditions({}), false);
  assert.equal(hasConditions({ min_invites: 1 }), true);
  const text = conditions({ required_role: 'r1', min_level: 10, min_invites: 3, min_days: 1 });
  assert.match(text, /Rôle requis : <@&r1>/);
  assert.match(text, /Niveau minimum : \*\*10\*\*/);
  assert.match(text, /Invitations minimum : \*\*3\*\*/);
  assert.match(text, /\*\*1 jour\*\*/);
  assert.match(conditions({}), /ouvert à tous/);
});

function world() {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const levels = new LevelRepository(db);
  const inviteJoins = new InviteJoinRepository(db);
  const message = { id: 'm1', embeds: [], edit: async () => message };
  const channel = { isTextBased: () => true, send: async () => message, messages: { fetch: async () => message } };
  const members = new Collection([[A, member(A)], [B, member(B)], [C, member(C, { joinedDaysAgo: 2 })]]);
  const guild = { members: { cache: members, fetch: async (id) => members.get(id) ?? Promise.reject(new Error('Unknown Member')) } };
  const client = {
    channels: { fetch: async () => channel },
    users: { fetch: async (id) => ({ id, bot: false }) },
    guilds: { cache: new Map([[GUILD, guild]]) },
    repositories: { levels, inviteJoins },
  };
  const service = new GiveawayService({ client, giveaways: repo });
  const interaction = (userId) => ({ guildId: GUILD, user: { id: userId, bot: false }, member: members.get(userId) });
  const setLevel = (userId, level) => levels.setXp(GUILD, userId, totalXpForLevel(level), levelFromXp);
  const invite = (inviterId, n = 1) => {
    for (let i = 0; i < n; i += 1) inviteJoins.recordJoin({ guildId: GUILD, userId: `30000000000000000${i}`, inviterId });
  };
  return { db, repo, service, interaction, setLevel, invite, inviteJoins, members };
}

test('GiveawayRepository.create : conditions facultatives (rétrocompatible)', () => {
  const { repo } = world();
  const plain = repo.create({ guildId: GUILD, channelId: 'c', messageId: null, prize: 'Nitro', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() + 1000 });
  assert.deepEqual([repo.get(plain).min_level, repo.get(plain).min_invites, repo.get(plain).min_days], [null, null, null]);
  const strict = repo.create({ guildId: GUILD, channelId: 'c', messageId: null, prize: 'Nitro', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null, minLevel: 4, minInvites: 2, minDays: 14, endsAt: Date.now() + 1000 });
  assert.deepEqual([repo.get(strict).min_level, repo.get(strict).min_invites, repo.get(strict).min_days], [4, 2, 14]);
});

test('enter : refus clairs à l\'inscription (niveau, invitations, ancienneté), puis participation', async () => {
  const w = world();
  const { id } = await w.service.create({ isTextBased: () => true, guild: { id: GUILD }, id: 'c', send: async () => ({ id: 'm1' }) }, { id: 'h' }, { prize: 'Nitro', winners: 1, durationMs: 60_000, minLevel: 3, minInvites: 2, minDays: 7 });
  await assert.rejects(w.service.enter(w.interaction(A), id), /niveau 3/);
  w.setLevel(A, 3);
  await assert.rejects(w.service.enter(w.interaction(A), id), /2 invitations/);
  w.invite(A, 2);
  assert.equal(await w.service.enter(w.interaction(A), id), true);
  // Invitations « fausses » ou membres repartis : non comptés.
  w.setLevel(C, 9);
  w.inviteJoins.recordJoin({ guildId: GUILD, userId: '300000000000000010', inviterId: C, fake: true });
  w.inviteJoins.recordJoin({ guildId: GUILD, userId: '300000000000000011', inviterId: C });
  w.inviteJoins.recordJoin({ guildId: GUILD, userId: '300000000000000012', inviterId: C });
  w.inviteJoins.markLeft(GUILD, '300000000000000012');
  await assert.rejects(w.service.enter(w.interaction(C), id), (err) => /vous en avez \*\*1\*\*/.test(err.message) && /7 jours/.test(err.message));
  for (const t of w.service.pendingEdits.values()) clearTimeout(t);
  w.service.pendingEdits.clear();
});

test('tirage : un participant qui ne remplit plus les conditions n\'est jamais tiré', async () => {
  const w = world();
  const { id } = await w.service.create({ isTextBased: () => true, guild: { id: GUILD }, id: 'c', send: async () => ({ id: 'm1' }) }, { id: 'h' }, { prize: 'Nitro', winners: 1, durationMs: 60_000, minLevel: 2 });
  w.setLevel(A, 2);
  w.setLevel(B, 2);
  await w.service.enter(w.interaction(A), id);
  await w.service.enter(w.interaction(B), id);
  w.db.prepare('DELETE FROM levels WHERE user_id = ?').run(A); // A n'a plus le niveau requis
  for (const t of w.service.pendingEdits.values()) clearTimeout(t);
  w.service.pendingEdits.clear();
  const winners = await w.service.end(id, { guildId: GUILD });
  assert.deepEqual(winners, [B]);
});

test('/giveaway create : options de conditions et avertissements', () => {
  const create = giveaway.data.toJSON().options.find((o) => o.name === 'create');
  const byName = Object.fromEntries(create.options.map((o) => [o.name, o]));
  for (const name of ['niveau_min', 'invitations_min', 'anciennete_min']) {
    assert.equal(byName[name]?.type, 4, name);
    assert.equal(byName[name].min_value, 1);
    assert.ok(byName[name].description.length > 15, `${name} : description explicite`);
  }
  assert.deepEqual(giveaway.conditionWarnings({ levels: { enabled: true } }, { minLevel: 3, minInvites: 2, inviteTracking: true }), []);
  const warn = giveaway.conditionWarnings({ levels: { enabled: false } }, { minLevel: 3, minInvites: 2, inviteTracking: false });
  assert.equal(warn.length, 2);
  assert.match(warn[0], /niveaux est désactivé/);
  assert.match(warn[1], /suivi des invitations/);
});
