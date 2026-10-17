'use strict';

/**
 * SEC3 — liste noire persistante et blrank : dépôt (migration #30), service (ajout, retrait,
 * persistance, contrôle périodique), refus, gardes de ModerationService (unban, softban) et du
 * scheduler (tempban échu), blrank (applyRoles, guildMemberUpdate, boucle).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { SecurityBlacklistRepository, MAX_PER_KIND } = require('../src/database/repositories/SecurityBlacklistRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { BlacklistService, retryDelay, CHECK_INTERVAL_MS, RETRY_BASE_MS, RETRY_MAX_MS, DUE_PER_TICK, BLRANK_WINDOW_MS } = require('../src/services/BlacklistService');
const { ModerationService } = require('../src/services/ModerationService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { applyRoles } = require('../src/utils/memberRoles');
const { migrations } = require('../src/database/schema');

const G = '100000000000000001';
const OTHER_G = '100000000000000002';
const BOT = '100000000000000010';
const OWNER = '100000000000000011';
const SECOWNER = '100000000000000013';
const MOD = '100000000000000014';
const TRUSTED = '100000000000000015';
const TARGET = '100000000000000016';
const TARGET2 = '100000000000000017';
const R_WL = '100000000000000031';
const MINUTE = 60_000;
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const err = (code, message = `Erreur ${code}`) => Object.assign(new Error(message), { code });

/** Monde de test : vraie base en mémoire, faux serveur (bans, rôles, journal d'audit). */
function world({ now = 1_700_000_000_000 } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new SecurityBlacklistRepository(db);
  const sanctions = new SanctionRepository(db);
  const w = { now, calls: [], logs: [], marks: [], banError: null, fetchError: null, onFetch: null, auditEntries: [] };
  const bans = new Map();
  const guild = {
    id: G,
    ownerId: OWNER,
    available: true,
    members: {
      me: { id: BOT, permissions: new PermissionsBitField(P.Administrator), roles: { highest: { position: 50 } } },
      cache: new Map(),
      fetch: async () => { throw err(10007, 'Unknown Member'); },
    },
    roles: { cache: new Map() },
    bans: {
      create: async (id, opts) => {
        w.calls.push(['ban', id, opts?.reason]);
        if (w.banError) throw w.banError;
        bans.set(id, opts);
      },
      fetch: async (opts) => {
        const user = typeof opts === 'string' ? opts : opts?.user;
        w.calls.push(['fetch', user]);
        await w.onFetch?.(user);
        if (w.fetchError) throw w.fetchError;
        if (!bans.has(user)) throw err(10026, 'Unknown Ban');
        return { user: { id: user } };
      },
      remove: async (id) => {
        w.calls.push(['unban', id]);
        bans.delete(id);
      },
    },
    fetchAuditLogs: async () => ({ entries: new Collection(w.auditEntries.map((e, i) => [String(i), e])) }),
  };
  const logging = { send: async (...a) => { w.logs.push(a); return true; } };
  const client = {
    user: { id: BOT },
    config: { ownerIds: [] },
    guilds: { cache: new Map([[G, guild]]) },
    repositories: { sanctions, securityBlacklist: repo },
    services: { config, logging },
  };
  guild.client = client;
  const moderation = new ModerationService({ sanctions, config, logging });
  const realUnban = moderation.unban.bind(moderation);
  moderation.unban = async (...args) => {
    w.calls.push(['moderation.unban', args[1], repo.has(G, args[1], 'ban')]);
    return realUnban(...args);
  };
  const origMark = moderation.markBotAction.bind(moderation);
  moderation.markBotAction = (...a) => { w.marks.push(a); return origMark(...a); };
  client.services.moderation = moderation;
  const svc = new BlacklistService({ client, config, logging, repo, now: () => w.now });
  client.services.blacklist = svc;
  const interaction = (userId = OWNER, extra = {}) => ({ guild, user: { id: userId, tag: `u${userId.slice(-2)}`, bot: false }, member: null, ...extra });
  const titles = () => w.logs.map((l) => String(json(l[2]).title ?? '').replace(/^\S+\s+/, ''));
  return { db, config, repo, sanctions, svc, guild, client, bans, interaction, titles, w };
}

const user = (id, extra = {}) => ({ id, bot: false, tag: `u${id.slice(-2)}`, toString: () => `<@${id}>`, ...extra });

// ---------------------------------------------------------------- dépôt

test('migration #30 à sa place (après #29) ; dépôt : filtre guild_id, clé (guild, user, kind), types validés, purgeGuild, lignes dues bornées, 1 000 entrées au plus', () => {
  const ids = migrations.map((m) => m.id);
  assert.equal(ids.indexOf(30), ids.indexOf(29) + 1);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'ids croissants');
  const { repo } = world();
  assert.deepEqual(repo.add({ guildId: G, userId: TARGET, kind: 'ban', reason: 'x', authorId: OWNER }), { added: true });
  assert.deepEqual(repo.add({ guildId: G, userId: TARGET, kind: 'ban', reason: 'y', authorId: OWNER }), { added: false });
  assert.deepEqual(repo.add({ guildId: G, userId: TARGET, kind: 'rank', authorId: OWNER }), { added: true }, 'même utilisateur dans les deux listes');
  assert.ok(repo.add({ guildId: OTHER_G, userId: TARGET, kind: 'ban', authorId: OWNER }).added);
  assert.equal(repo.count(G, 'ban'), 1);
  assert.equal(repo.get(G, TARGET, 'ban').reason, 'x');
  assert.equal(repo.list(OTHER_G, 'rank').length, 0);
  assert.throws(() => repo.add({ guildId: G, userId: TARGET2, kind: 'autre', authorId: OWNER }), /inconnu/);
  assert.throws(() => repo.add({ guildId: G, userId: 'abc', kind: 'ban', authorId: OWNER }), /invalides/);
  assert.equal(repo.remove(G, TARGET, 'ban'), true);
  assert.equal(repo.remove(G, TARGET, 'ban'), false, 'verrou : un seul DELETE effectif');
  assert.ok(repo.has(OTHER_G, TARGET, 'ban'), 'autre serveur touché');
  assert.equal(repo.purgeGuild(OTHER_G), 1);
  assert.equal(repo.has(G, TARGET, 'rank'), true);

  for (let i = 0; i < 70; i += 1) repo.add({ guildId: G, userId: String(200000000000000000n + BigInt(i)), kind: 'ban', authorId: OWNER, nextCheckAt: 1_000 + i });
  repo.add({ guildId: G, userId: '300000000000000000', kind: 'ban', authorId: OWNER, nextCheckAt: null });
  const due = repo.due(5_000, DUE_PER_TICK);
  assert.equal(due.length, DUE_PER_TICK, 'lignes dues non bornées');
  assert.ok(due.every((r) => r.kind === 'ban' && r.next_check_at <= 5_000));
  assert.deepEqual(due.slice(0, 2).map((r) => r.next_check_at), [1_000, 1_001], 'les plus anciennes d\'abord');

  const { repo: full } = world();
  const insert = full.insertStmt;
  for (let i = 0; i < MAX_PER_KIND; i += 1) insert.run({ guildId: G, userId: String(400000000000000000n + BigInt(i)), kind: 'rank', reason: null, authorId: OWNER, createdAt: 1, nextCheckAt: null });
  assert.deepEqual(full.add({ guildId: G, userId: TARGET, kind: 'rank', authorId: OWNER }), { added: false, full: true });
  assert.ok(full.add({ guildId: G, userId: TARGET, kind: 'ban', authorId: OWNER }).added, 'plafond par type');
});

// ---------------------------------------------------------------- ajout, retrait

test('ajout : double ajout → un seul ban (marqué, casier, tempban remplacé) ; échec 50013 → aucune ligne ; échec passager → ligne gardée, nouvel essai dans 5 min, puis contrôle', async () => {
  const { svc, repo, sanctions, interaction, w } = world();
  sanctions.create({ guildId: G, userId: TARGET, moderatorId: MOD, type: 'tempban', reason: 'r', durationMs: 3_600_000, expiresAt: Date.now() + 3_600_000 });
  const res = await svc.add(interaction(), user(TARGET), 'Nuke');
  assert.equal(res.banned, true);
  await assert.rejects(svc.add(interaction(), user(TARGET), 'Encore'), /déjà/);
  assert.deepEqual(w.calls.filter((c) => c[0] === 'ban'), [['ban', TARGET, 'Blacklist : Nuke']]);
  assert.deepEqual(w.marks, [['ban', G, TARGET]]);
  const row = repo.get(G, TARGET, 'ban');
  assert.equal(row.last_enforced_at, w.now);
  assert.equal(row.next_check_at, w.now + CHECK_INTERVAL_MS);
  const active = sanctions.listActive(G, TARGET);
  assert.deepEqual(active.map((s) => s.type), ['ban'], 'tempban non remplacé ou casier absent');

  w.banError = err(50013, 'Missing Permissions');
  await assert.rejects(svc.add(interaction(), user(TARGET2), 'Hiérarchie'), /Bannissement impossible/);
  assert.equal(repo.has(G, TARGET2, 'ban'), false, 'ligne gardée après un refus définitif');

  w.banError = Object.assign(new Error('Service Unavailable'), { status: 503 });
  const transient = await svc.add(interaction(), user(TARGET2), 'Passager');
  assert.equal(transient.banned, false);
  const kept = repo.get(G, TARGET2, 'ban');
  assert.equal(kept.enforce_failures, 1);
  assert.equal(kept.next_check_at, w.now + RETRY_BASE_MS);
  assert.equal(sanctions.listActive(G, TARGET2).length, 0, 'casier avant un ban effectif');

  // Contrôle 5 min plus tard : 10026 → ban appliqué, inscrit au casier.
  w.banError = null;
  w.now += RETRY_BASE_MS;
  await svc.processSecurityDue();
  const after = repo.get(G, TARGET2, 'ban');
  assert.equal(after.enforce_failures, 0);
  assert.equal(after.last_enforced_at, w.now);
  assert.equal(after.next_check_at, w.now + CHECK_INTERVAL_MS);
  assert.deepEqual(sanctions.listActive(G, TARGET2).map((s) => s.type), ['ban']);
});

test('retrait : DELETE AVANT le débannissement (guildBanRemove ne trouve plus la ligne) ; second retrait refusé sans débannissement ; debannir=faux garde le ban', async () => {
  const { svc, repo, bans, interaction, w } = world();
  await svc.add(interaction(), user(TARGET), 'Raid');
  const res = await svc.remove(interaction(), TARGET, { unban: true });
  assert.equal(res.unbanned, true);
  const call = w.calls.find((c) => c[0] === 'moderation.unban');
  assert.deepEqual(call, ['moderation.unban', TARGET, false], 'la ligne existait encore au débannissement');
  assert.equal(bans.has(TARGET), false);
  // guildBanRemove arrive après : pas de rebannissement.
  await svc.handleUnban(svc.client.guilds.cache.get(G), { id: TARGET });
  assert.equal(w.calls.filter((c) => c[0] === 'ban').length, 1);
  await assert.rejects(svc.remove(interaction(), TARGET, { unban: true }), /déjà retiré/);
  assert.equal(w.calls.filter((c) => c[0] === 'unban').length, 1, 'débanni deux fois');

  await svc.add(interaction(), user(TARGET2), 'Garde');
  const keep = await svc.remove(interaction(), TARGET2, { unban: false });
  assert.equal(keep.unbanned, null);
  assert.ok(bans.has(TARGET2));
  assert.equal(repo.has(G, TARGET2, 'ban'), false);
});

test('refus : soi-même, le bot, le propriétaire, un owner, un whitelisté (utilisateur ou rôle), un bot de confiance, une cible non bannissable', async () => {
  const { svc, config, guild, interaction, w } = world();
  config.update(G, { secur: { owners: [SECOWNER], trustedBots: [TRUSTED] }, whitelist: { users: [MOD], roles: [R_WL] } });
  await assert.rejects(svc.add(interaction(SECOWNER), user(SECOWNER), 'x'), /vous-même/);
  await assert.rejects(svc.add(interaction(), user(BOT), 'x'), /moi-même/);
  await assert.rejects(svc.add(interaction(SECOWNER), user(OWNER), 'x'), /propriétaire du serveur/);
  await assert.rejects(svc.add(interaction(), user(SECOWNER), 'x'), /owner de sécurité/);
  await assert.rejects(svc.add(interaction(), user(MOD), 'x'), /whitelist/);
  guild.members.cache.set(TARGET, { id: TARGET, user: user(TARGET), bannable: true, roles: { cache: new Map([[R_WL, {}]]), highest: { position: 1 } } });
  await assert.rejects(svc.add(interaction(), user(TARGET), 'x'), /whitelist/);
  await assert.rejects(svc.add(interaction(), user(TRUSTED, { bot: true }), 'x'), /bot de confiance/);
  guild.members.cache.set(TARGET2, { id: TARGET2, user: user(TARGET2), bannable: false, roles: { cache: new Map(), highest: { position: 99 } } });
  await assert.rejects(svc.add(interaction(), user(TARGET2), 'x'), /Je ne peux pas bannir/);
  await assert.rejects(svc.add(interaction(), user('100000000000000099'), '   '), /raison/);
  // blrank : propriétaire, owner et bot refusés.
  await assert.rejects(svc.addRank(interaction(SECOWNER), user(OWNER)), /propriétaire/);
  await assert.rejects(svc.addRank(interaction(), user(SECOWNER)), /owner de sécurité/);
  await assert.rejects(svc.addRank(interaction(), user(BOT)), /moi-même/);
  assert.equal(w.calls.length, 0, 'requête envoyée malgré un refus');
  assert.throws(() => svc.assertOwner(interaction(MOD)), /Réservé au propriétaire/);
  assert.doesNotThrow(() => svc.assertOwner(interaction(SECOWNER)));
});

// ---------------------------------------------------------------- persistance

test('persistance : arrivée et débannissement → rebanni (ligne relue) ; contrôle périodique : relu avant d\'agir, backoff 5 min × 2ⁿ plafonné à 24 h, serveur absent repoussé', async () => {
  const { svc, repo, bans, guild, titles, w } = world();
  repo.add({ guildId: G, userId: TARGET, kind: 'ban', reason: 'Raid', authorId: OWNER, nextCheckAt: w.now + CHECK_INTERVAL_MS });
  assert.deepEqual(await svc.handleJoin({ id: TARGET2, guild, user: user(TARGET2) }), { punished: false });
  assert.deepEqual(await svc.handleJoin({ id: TARGET, guild, user: user(TARGET) }), { punished: true });
  assert.ok(bans.has(TARGET));
  assert.ok(titles().includes('Blacklisté banni à son arrivée'));
  bans.delete(TARGET);
  w.auditEntries = [{ targetId: TARGET, executorId: MOD, createdTimestamp: Date.now(), changes: [] }];
  await svc.handleUnban(guild, { id: TARGET });
  assert.ok(bans.has(TARGET), 'débannissement non annulé');
  const cancelled = w.logs.find((l) => /Débannissement annulé/.test(json(l[2]).title));
  assert.match(JSON.stringify(json(cancelled[2]).fields), new RegExp(MOD));
  assert.equal(cancelled[4].event, 'blacklist');

  // Ligne relue : retirée entre la lecture des lignes dues et l'action → aucun ban.
  const before = w.calls.filter((c) => c[0] === 'ban').length;
  repo.add({ guildId: G, userId: TARGET2, kind: 'ban', reason: 'x', authorId: OWNER, nextCheckAt: w.now - 1 });
  const due = repo.due.bind(repo);
  repo.due = (...a) => {
    const rows = due(...a);
    repo.remove(G, TARGET2, 'ban');
    return rows;
  };
  await svc.processSecurityDue();
  repo.due = due;
  assert.equal(w.calls.filter((c) => c[0] === 'ban').length, before, 'ligne retirée rebannie');
  assert.equal(w.calls.filter((c) => c[0] === 'fetch').length, 0, 'GET pour une ligne retirée');
  // Retirée PENDANT la lecture du ban (GET) : relue avant le bannissement.
  repo.add({ guildId: G, userId: TARGET2, kind: 'ban', reason: 'x', authorId: OWNER, nextCheckAt: w.now - 1 });
  w.onFetch = async (id) => { if (id === TARGET2) repo.remove(G, TARGET2, 'ban'); };
  await svc.processSecurityDue();
  w.onFetch = null;
  assert.equal(w.calls.filter((c) => c[0] === 'ban').length, before, 'ligne retirée pendant le GET rebannie');

  // Backoff : échecs successifs du GET (5 min, 10 min, …), plafonné à 24 h.
  assert.equal(retryDelay(0), 5 * MINUTE);
  assert.equal(retryDelay(1), 10 * MINUTE);
  assert.equal(retryDelay(12), RETRY_MAX_MS);
  repo.add({ guildId: G, userId: TARGET2, kind: 'ban', reason: 'x', authorId: OWNER, nextCheckAt: w.now - 1 });
  w.fetchError = err(0, 'Service Unavailable');
  await svc.processSecurityDue();
  assert.equal(repo.get(G, TARGET2, 'ban').next_check_at, w.now + 5 * MINUTE);
  w.now += 5 * MINUTE;
  await svc.processSecurityDue();
  assert.equal(repo.get(G, TARGET2, 'ban').next_check_at, w.now + 10 * MINUTE);
  assert.equal(repo.get(G, TARGET2, 'ban').enforce_failures, 2);
  w.fetchError = null;
  w.now += 10 * MINUTE;
  await svc.processSecurityDue();
  assert.ok(bans.has(TARGET2));
  assert.equal(repo.get(G, TARGET2, 'ban').enforce_failures, 0);
  assert.ok(titles().includes('Bannissement rétabli'));

  // Toujours banni : prochain contrôle dans 6 h, aucun ban. Serveur absent : repoussé, aucun GET.
  const bansBefore = w.calls.filter((c) => c[0] === 'ban').length;
  w.now += CHECK_INTERVAL_MS;
  repo.add({ guildId: OTHER_G, userId: TARGET, kind: 'ban', reason: 'x', authorId: OWNER, nextCheckAt: w.now - 1 });
  const fetchesBefore = w.calls.filter((c) => c[0] === 'fetch').length;
  await svc.processSecurityDue();
  assert.equal(w.calls.filter((c) => c[0] === 'ban').length, bansBefore);
  assert.equal(w.calls.filter((c) => c[0] === 'fetch').length - fetchesBefore, 2, 'un GET par ligne due de ce serveur');
  assert.equal(repo.get(OTHER_G, TARGET, 'ban').next_check_at, w.now + CHECK_INTERVAL_MS);
  // Arrêt demandé : rien n'est traité.
  w.now += CHECK_INTERVAL_MS;
  const n = w.calls.length;
  await svc.processSecurityDue({ isStopping: () => true });
  assert.equal(w.calls.length, n);
});

// ---------------------------------------------------------------- gardes

test('ModerationService : unban et softban refusés pour un blacklisté, avant toute requête', async () => {
  const { svc, guild, client, interaction, w } = world();
  await svc.add(interaction(), user(TARGET), 'Raid');
  const n = w.calls.length;
  const moderator = { id: MOD, tag: 'mod', guild };
  await assert.rejects(client.services.moderation.unban(guild, TARGET, moderator, 'pardon'), /liste noire/);
  await assert.rejects(client.services.moderation.softban(guild, user(TARGET), moderator, 'purge'), /liste noire/);
  assert.deepEqual(w.calls.slice(n).filter((c) => c[0] !== 'moderation.unban'), [], 'requête envoyée');
});

test('scheduler : tempban échu d\'un blacklisté non levé ; ligne close ; staff prévenu', async () => {
  const { svc, guild, client, sanctions, interaction, w } = world();
  await svc.add(interaction(), user(TARGET), 'Raid');
  // Tempban échu enregistré plus tard (données anciennes, autre modérateur…).
  const id = sanctions.create({ guildId: G, userId: TARGET, moderatorId: MOD, type: 'tempban', reason: 'r', durationMs: 1_000, expiresAt: Date.now() - 1_000 });
  sanctions.deactivateActive(G, TARGET, 'ban', { by: null, reason: 'test' });
  const scheduler = new SchedulerService({ client, sanctions, reminders: { findDue: () => [] } });
  client.services.scheduler = scheduler;
  await scheduler.tick();
  assert.equal(w.calls.filter((c) => c[0] === 'unban').length, 0, 'blacklisté débanni à la fin du tempban');
  assert.equal(sanctions.get(G, id).active, 0, 'ligne temporaire non close');
  assert.ok(w.logs.some((l) => /Bannissement temporaire maintenu/.test(json(l[2]).title)));
  assert.ok(guild.bans);
});

// ---------------------------------------------------------------- blrank

function rankedMember(w, guild, client, roleIds = []) {
  const removed = [];
  const added = [];
  const roles = new Map(roleIds.map((id) => [id, { id, managed: false, editable: true }]));
  return {
    id: TARGET,
    guild,
    client,
    user: user(TARGET),
    removed,
    added,
    roles: {
      cache: roles,
      add: async (id) => { added.push(id); },
      remove: async (id) => { removed.push(id); },
    },
  };
}

test('blrank : applyRoles saute les ajouts (skipped) et garde les retraits ; guildMemberUpdate retire le rôle gagné ; autre bot : 4ᵉ retrait en 10 min → carte, aucun retrait ; humain : toujours retiré', async () => {
  const { svc, repo, guild, client, titles, w } = world();
  const free = rankedMember(w, guild, client);
  const out0 = await applyRoles(free, { add: ['r1'] });
  assert.deepEqual(out0.added, ['r1'], 'membre libre bloqué');
  repo.add({ guildId: G, userId: TARGET, kind: 'rank', authorId: OWNER });
  const m = rankedMember(w, guild, client);
  const out = await applyRoles(m, { add: ['r1', 'r2'], remove: ['r3'] });
  assert.deepEqual(out, { added: [], removed: ['r3'], failed: [], skipped: ['r1', 'r2'] });
  assert.deepEqual(m.added, []);

  const R = '100000000000000040';
  const oldMember = { roles: { cache: new Map([['r0', {}]]) } };
  const gainedMember = () => {
    const nm = rankedMember(w, guild, client, ['r0']);
    nm.roles.cache.set(R, { id: R, managed: false, editable: true });
    nm.roles.cache.set('100000000000000041', { id: '100000000000000041', managed: true, editable: true });
    return nm;
  };
  // Rôle rendu par un AUTRE bot : plafond « boucle » (3 retraits par 10 min).
  const OTHER_BOT = '100000000000000018';
  client.users = { cache: new Map([[OTHER_BOT, { id: OTHER_BOT, bot: true }], [MOD, { id: MOD, bot: false }]]) };
  w.auditEntries = [{ targetId: TARGET, executorId: OTHER_BOT, createdTimestamp: Date.now(), changes: [{ key: '$add', new: [{ id: R }] }] }];
  for (let i = 0; i < 3; i += 1) {
    const nm = gainedMember();
    await svc.handleMemberUpdate(oldMember, nm);
    assert.deepEqual(nm.removed, [R], `retrait n° ${i + 1} (rôle géré jamais retiré)`);
    w.now += MINUTE;
  }
  assert.equal(titles().filter((t) => t === 'Rôle retiré (blrank)').length, 3);
  assert.match(JSON.stringify(json(w.logs.at(-1)[2]).fields), new RegExp(OTHER_BOT), 'auteur non nommé');
  const fourth = gainedMember();
  await svc.handleMemberUpdate(oldMember, fourth);
  assert.deepEqual(fourth.removed, [], '4ᵉ retrait en 10 min');
  assert.equal(titles().filter((t) => /Boucle d'attribution/.test(t)).length, 1);
  const fifth = gainedMember();
  await svc.handleMemberUpdate(oldMember, fifth);
  assert.equal(titles().filter((t) => /Boucle d'attribution/.test(t)).length, 1, 'carte répétée');
  // Fenêtre écoulée : le retrait reprend.
  w.now += BLRANK_WINDOW_MS;
  const later = gainedMember();
  await svc.handleMemberUpdate(oldMember, later);
  assert.deepEqual(later.removed, [R]);
  // Rôle donné par un humain (ou par ce bot) : toujours retiré, hors plafond (revue 7, S36).
  w.auditEntries = [{ targetId: TARGET, executorId: MOD, createdTimestamp: Date.now(), changes: [{ key: '$add', new: [{ id: R }] }] }];
  for (let i = 0; i < 5; i += 1) {
    const nm = gainedMember();
    await svc.handleMemberUpdate(oldMember, nm);
    assert.deepEqual(nm.removed, [R], `ajout humain n° ${i + 1} laissé`);
  }
  w.auditEntries = [{ targetId: TARGET, executorId: BOT, createdTimestamp: Date.now(), changes: [{ key: '$add', new: [{ id: R }] }] }];
  const byBot = gainedMember();
  await svc.handleMemberUpdate(oldMember, byBot);
  assert.deepEqual(byBot.removed, [R], 'ajout de ce bot laissé');
  // Rôle restrictif (Muted) : jamais retiré (revue 7, S35).
  const MUTED = '100000000000000042';
  guild.roles.cache.set(MUTED, { id: MUTED, name: 'Muted' });
  client.services.config.update(G, { moderation: { mutedRoleId: MUTED } });
  const muted = rankedMember(w, guild, client, ['r0']);
  muted.roles.cache.set(MUTED, { id: MUTED, managed: false, editable: true });
  await svc.handleMemberUpdate(oldMember, muted);
  assert.deepEqual(muted.removed, [], 'rôle Muted retiré par le blrank');
  assert.deepEqual([...svc.restrictiveRoleIds(guild)], [MUTED]);
  // Ancien membre partiel : rôle ajouté récemment (journal d'audit) retiré, rôle déjà porté gardé (S37).
  w.auditEntries = [{ targetId: TARGET, executorId: MOD, createdTimestamp: Date.now(), changes: [{ key: '$add', new: [{ id: R }] }] }];
  const partial = gainedMember();
  await svc.handleMemberUpdate({ partial: true }, partial);
  assert.deepEqual(partial.removed, [R]);
  // … sans ajout récent dans le journal : rien.
  w.auditEntries = [{ targetId: TARGET, executorId: MOD, createdTimestamp: Date.now() - 60_000, changes: [{ key: '$add', new: [{ id: R }] }] }];
  const stale = gainedMember();
  await svc.handleMemberUpdate({ partial: true }, stale);
  assert.deepEqual(stale.removed, []);
  assert.equal(svc.isRankBlocked(G, TARGET2), false);
  svc.removeRank(G, TARGET);
  assert.throws(() => svc.removeRank(G, TARGET), /pas dans le blrank/);
  assert.equal(svc.purgeGuild(G), 0);
});
