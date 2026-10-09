'use strict';

/**
 * Limites connues restées ouvertes après trois revues :
 *  1. niveaux et membres partis (migration 17, left_at) ;
 *  2. AntiRaid : expulsions massives (kickThreshold) ;
 *  3. /backup restore : ordre des rôles et permissions des salons existants ;
 *  4. défi anti-robot de /bienvenue en toutes lettres ;
 *  5. pièces jointes des transcripts (tickets.archiveAttachments).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, AuditLogEvent, ChannelType, OverwriteType, PermissionsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { LevelRepository } = require('../src/database/repositories/LevelRepository');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { LevelService, levelFromXp } = require('../src/services/LevelService');
const { AntiRaidService, RECENT_JOIN_MS } = require('../src/services/AntiRaidService');
const { ModerationService } = require('../src/services/ModerationService');
const { BackupService, planRolePositions, sameOverwrites } = require('../src/services/BackupService');
const W = require('../src/services/WelcomeService');
const T = require('../src/utils/transcriptArchive');
const { attachmentFields } = require('../src/services/TicketService');
const { defaultGuildConfig: defaults } = require('../src/config/defaults');
const levelEvents = require('../src/events/levels');
const antiraidDepartures = require('../src/events/antiraidDepartures');
const banEvents = require('../src/events/banEvents');
const rang = require('../src/commands/levels/rang');
const niveaux = require('../src/commands/levels/niveaux');
const antiraid = require('../src/commands/security/antiraid');
const backupCmd = require('../src/commands/configuration/backup');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const DAY = 86_400_000;
const G = '100000000000000001';
const A = '200000000000000001';
const B = '200000000000000002';
const C = '200000000000000003';
const MOD = '200000000000000009';

function configService() {
  const { db } = memoryDb();
  return { db, config: new ConfigService(new GuildConfigRepository(db)) };
}

// ================================================================ 1. niveaux et membres partis

test('migration 17 : colonne levels.left_at', () => {
  const last = migrations.find((m) => m.id === 17);
  assert.ok(last, 'migration 17 présente');
  assert.match(last.up, /ALTER TABLE levels ADD COLUMN left_at INTEGER/);
  const { db } = memoryDb();
  assert.ok(db.prepare('PRAGMA table_info(levels)').all().some((c) => c.name === 'left_at'));
});

test('niveaux : un membre parti quitte classement, rang et total, mais garde son XP', () => {
  const { db } = memoryDb();
  const repo = new LevelRepository(db);
  repo.setXp(G, A, 500, levelFromXp);
  repo.setXp(G, B, 300, levelFromXp);
  repo.setXp(G, C, 100, levelFromXp);
  assert.equal(repo.count(G), 3);
  assert.equal(repo.rank(G, B), 2);

  assert.equal(repo.markLeft(G, A, 1_000), true);
  assert.equal(repo.markLeft(G, A, 9_000), false, 'date du premier départ conservée');
  assert.equal(repo.markLeft(G, '200000000000000077'), false, 'sans ligne : rien');
  assert.deepEqual(repo.leaderboard(G).map((r) => r.user_id), [B, C]);
  assert.equal(repo.count(G), 2);
  assert.equal(repo.countAll(G), 3);
  assert.equal(repo.rank(G, A), null);
  assert.equal(repo.rank(G, B), 1, 'le parti ne compte plus au-dessus');
  assert.equal(repo.get(G, A).xp, 500, 'XP conservée');
  assert.equal(repo.get(G, A).left_at, 1_000);

  // Retour : il retrouve sa place.
  assert.equal(repo.markReturned(G, A), true);
  assert.equal(repo.markReturned(G, A), false);
  assert.equal(repo.rank(G, A), 1);
  assert.equal(repo.count(G), 3);

  // Un gain d'XP « présent » (message, vocal) efface aussi la marque.
  repo.markLeft(G, C, 2_000);
  repo.add(G, C, { xp: 5, present: true }, levelFromXp);
  assert.equal(repo.get(G, C).left_at, null);
  // Un changement d'admin (setXp) ne la touche pas.
  repo.markLeft(G, C, 2_000);
  repo.setXp(G, C, 50, levelFromXp);
  assert.equal(repo.get(G, C).left_at, 2_000);
});

test('niveaux : purge des membres partis depuis plus de N jours', () => {
  const { db } = memoryDb();
  const { config } = configService();
  const repo = new LevelRepository(db);
  const levels = new LevelService({ levels: repo, config });
  const now = 100 * DAY;
  for (const id of [A, B, C]) repo.setXp(G, id, 200, levelFromXp);
  levels.markLeft(G, A, now - 40 * DAY);
  levels.markLeft(G, B, now - 5 * DAY);
  assert.equal(LevelService.leftBefore(30, now), now - 30 * DAY);
  assert.equal(levels.countLeft(G, 30, now), 1);
  assert.equal(levels.countLeft(G, 0, now), 2, '0 jour : tous les partis');
  assert.equal(levels.purgeLeft(G, 30, now), 1);
  assert.equal(repo.get(G, A), null);
  assert.ok(repo.get(G, B), 'départ récent conservé');
  assert.ok(repo.get(G, C), 'membre présent jamais touché');
  assert.equal(levels.purgeLeft(G, 0, now), 1);
  assert.equal(repo.countLeft(G), 0);
  assert.equal(niveaux.parseDays('30'), 30);
  assert.throws(() => niveaux.parseDays('-1'), /entre 0 et/);
  assert.throws(() => niveaux.parseDays('abc'), /entre 0 et/);
});

test('niveaux : événements de départ et de retour (bots ignorés)', () => {
  const { db } = memoryDb();
  const { config } = configService();
  const repo = new LevelRepository(db);
  const client = { services: { levels: new LevelService({ levels: repo, config }) } };
  repo.setXp(G, A, 200, levelFromXp);
  const guild = { id: G };
  levelEvents.find((e) => e.name === 'guildMemberRemove').execute(client, { id: A, guild, user: { id: A, bot: false } });
  assert.ok(repo.get(G, A).left_at > 0);
  levelEvents.find((e) => e.name === 'guildMemberAdd').execute(client, { id: A, guild, user: { id: A, bot: false } });
  assert.equal(repo.get(G, A).left_at, null);
  levelEvents.find((e) => e.name === 'guildMemberRemove').execute(client, { id: A, guild, user: { id: A, bot: true } });
  assert.equal(repo.get(G, A).left_at, null, 'bot ignoré');
});

test('/rang d\'un membre parti : « a quitté le serveur (XP conservée) »', () => {
  const embed = json(rang.rankCard({ user: { id: A, username: 'alice', displayAvatarURL: () => null }, row: { xp: 300, messages: 3, voice_minutes: 0, left_at: 1 }, rank: null, total: 2, cfg: {} }));
  assert.match(embed.description, /a quitté le serveur \(XP conservée\)/);
  assert.ok(embed.fields.some((f) => f.value === '*Parti du serveur*'));
});

// ================================================================ 2. AntiRaid : expulsions massives

function raidEnv(cfg = {}) {
  const alerts = [];
  const executor = {
    id: MOD,
    roles: { cache: new Collection([['r1', { id: 'r1', editable: true, permissions: new PermissionsBitField([]), toString: () => '<@&r1>' }]]), remove: async () => { executor.stripped = true; } },
    user: { id: MOD, toString: () => `<@${MOD}>`, displayAvatarURL: () => null },
  };
  const guild = {
    id: G,
    ownerId: 'owner',
    members: { cache: new Map(), fetch: async () => executor },
    roles: { everyone: { id: G, permissions: new PermissionsBitField([]) } },
  };
  const antiraidCfg = { ...defaults.antiraid, enabled: true, destructiveWindowSeconds: 10, punishExecutor: 'strip', ...cfg };
  const config = { get: () => ({ antiraid: antiraidCfg, whitelist: { users: [], roles: [] } }) };
  const client = { user: { id: 'bot' }, services: {}, channels: { fetch: async () => null } };
  const service = new AntiRaidService({ client, config, logging: { send: async (...a) => alerts.push(a) } });
  client.services.antiraid = service;
  return { service, guild, alerts, executor, client };
}

test('AntiRaid : kickThreshold à 0 par défaut (aucun changement pour les serveurs existants)', async () => {
  assert.equal(defaults.antiraid.kickThreshold, 0);
  const env = raidEnv();
  for (let i = 0; i < 20; i += 1) await env.service.handleDestructive(env.guild, MOD, 'kick', { targetId: `${i}`, targetJoinedAt: 1 });
  assert.equal(env.alerts.length, 0);
  // Ancienne configuration sans la clé : désactivé aussi.
  const old = raidEnv({ kickThreshold: undefined });
  for (let i = 0; i < 5; i += 1) await old.service.handleDestructive(old.guild, MOD, 'kick', { targetId: `${i}`, targetJoinedAt: 1 });
  assert.equal(old.alerts.length, 0);
});

test('AntiRaid : expulsions massives → alerte et sanction de l\'auteur ; raiders exemptés', async () => {
  const env = raidEnv({ kickThreshold: 3 });
  for (let i = 0; i < 2; i += 1) await env.service.handleDestructive(env.guild, MOD, 'kick', { targetId: `old${i}`, targetJoinedAt: 1 });
  // Expulser des arrivants récents ne compte pas.
  for (let i = 0; i < 5; i += 1) await env.service.handleDestructive(env.guild, MOD, 'kick', { targetId: `new${i}`, targetJoinedAt: Date.now() - 60_000 });
  assert.equal(env.alerts.length, 0);
  await env.service.handleDestructive(env.guild, MOD, 'kick', { targetId: 'old2', targetJoinedAt: 1 });
  assert.equal(env.alerts.length, 1);
  const alert = json(env.alerts[0][2]);
  assert.match(alert.title, /Activité destructrice/);
  assert.ok(alert.fields.some((f) => /Expulsions ×\*\*3\*\*/.test(f.value)));
  assert.ok(env.executor.stripped, 'auteur sanctionné (retrait des rôles)');
});

test('AntiRaid : départ d\'un arrivant récent mémorisé (kick lu dans l\'audit log après le départ)', async () => {
  const env = raidEnv({ kickThreshold: 2 });
  const recent = { id: 'raider', guild: env.guild, joinedTimestamp: Date.now() - 30_000 };
  antiraidDepartures.execute(env.client, recent);
  assert.equal(env.service.isRecentJoiner(G, 'raider'), true);
  assert.equal(env.service.rememberDeparture({ id: 'vieux', guild: env.guild, joinedTimestamp: Date.now() - RECENT_JOIN_MS - 1 }), false);
  const audit = banEvents.find((e) => e.name === 'guildAuditLogEntryCreate');
  await audit.execute(env.client, { action: AuditLogEvent.MemberKick, executorId: MOD, targetId: 'raider' }, env.guild);
  await audit.execute(env.client, { action: AuditLogEvent.MemberKick, executorId: MOD, targetId: 'raider' }, env.guild);
  assert.equal(env.alerts.length, 0, 'raider expulsé : non compté');
  await audit.execute(env.client, { action: AuditLogEvent.MemberKick, executorId: MOD, targetId: 'a' }, env.guild);
  await audit.execute(env.client, { action: AuditLogEvent.MemberKick, executorId: MOD, targetId: 'b' }, env.guild);
  assert.equal(env.alerts.length, 1);
  // Kick signé par le bot (fait via /kick) : ignoré ici, signalé par ModerationService.
  await audit.execute(env.client, { action: AuditLogEvent.MemberKick, executorId: 'bot', targetId: 'c' }, env.guild);
  assert.equal(banEvents.DESTRUCTIVE_AUDIT_ACTIONS[AuditLogEvent.MemberKick], 'kick');
});

test('ModerationService.kick signale le modérateur à l\'AntiRaid (jamais bloquant)', async () => {
  const { db, config } = configService();
  const calls = [];
  const moderation = new ModerationService({ sanctions: new SanctionRepository(db), config, logging: { send: async () => true }, antiraid: { handleDestructive: async (...a) => calls.push(a) } });
  const guild = { id: G, ownerId: 'owner', name: 'S' };
  const roles = (position) => ({ highest: { position }, cache: new Map() });
  const kicked = [];
  const target = { id: A, guild, roles: roles(1), kickable: true, joinedTimestamp: 1234, user: { id: A, toString: () => `<@${A}>`, send: async () => null }, kick: async () => kicked.push(A) };
  guild.members = { me: { id: 'bot', guild, roles: roles(100), permissions: new PermissionsBitField(['KickMembers']) }, cache: new Map([[A, target]]), fetch: async () => target };
  guild.roles = { cache: new Collection() };
  const moderator = { id: MOD, guild, roles: roles(50) };
  await moderation.kick(guild, target, moderator, 'raison');
  assert.deepEqual(kicked, [A]);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0][1], calls[0][2], calls[0][3].targetId, calls[0][3].targetJoinedAt], [MOD, 'kick', A, 1234]);
  moderation.antiraid = { handleDestructive: async () => { throw new Error('boom'); } };
  await moderation.kick(guild, target, moderator, 'raison');
});

test('/antiraid : seuil d\'expulsions dans la vue « destruction », le formulaire et le préréglage Strict', () => {
  assert.equal(antiraid.PRESETS.strict.patch.kickThreshold, 5);
  assert.equal(antiraid.PRESETS.equilibre.patch.kickThreshold, 0);
  assert.deepEqual(antiraid.BOUNDS.kickThreshold, [0, 100]);
  const cfg = { ...defaults, antiraid: { ...defaults.antiraid, kickThreshold: 4 } };
  const client = { services: { config: { get: () => cfg }, antiraid: { lastTriggerOf: () => null } } };
  const guild = { id: G, channels: { cache: new Collection() }, roles: { cache: new Collection() } };
  const view = antiraid.render(client, guild, 'destructive');
  const embed = json(view.embeds[0]);
  assert.ok(embed.fields.some((f) => /Expulsions/.test(f.name) && f.value === '**4**'));
  assert.match(antiraid.simulate(cfg.antiraid, null).lines.join('\n'), /4 expulsions/);
});

// ================================================================ 3. /backup restore

test('planRolePositions : ordre relatif de la sauvegarde, sous le bot, un seul lot', () => {
  const r = (id, name, position, managed = false) => ({ id: `30000000000000000${id}`, name, position, managed });
  // Serveur : Bot(10) > Haut(4) > Autre(3) > Bas(2) > Milieu(1, recréé tout en bas)
  const roles = [r(9, 'Bot', 10, true), r(1, 'Haut', 4), r(5, 'Autre', 3), r(3, 'Bas', 2), r(2, 'Milieu', 1)];
  const changes = planRolePositions(roles, ['Haut', 'Milieu', 'Bas'], 10);
  const pos = Object.fromEntries(changes.map((c) => [c.role.slice(-1), c.position]));
  // Emplacements des rôles de la sauvegarde : 4, 2, 1 → Haut 4, Milieu 2, Bas 1 ; « Autre » reste en 3.
  assert.deepEqual(pos, { 3: 1, 2: 2 });
  assert.ok(!changes.some((c) => c.role.endsWith('9')), 'rôle du bot jamais déplacé');
  // Déjà dans l'ordre : aucun appel.
  assert.deepEqual(planRolePositions([r(1, 'Haut', 3), r(2, 'Milieu', 2), r(3, 'Bas', 1)], ['Haut', 'Milieu', 'Bas'], 10), []);
  // Rôles au-dessus du bot : intouchables.
  assert.deepEqual(planRolePositions([r(1, 'Haut', 12), r(2, 'Bas', 1)], ['Bas', 'Haut'], 10), []);
  // Égalités de position (cache périmé) : départagées par identifiant, positions normalisées.
  const tie = planRolePositions([r(1, 'Haut', 1), r(2, 'Bas', 1)], ['Bas', 'Haut'], 10);
  assert.deepEqual(tie.map((c) => [c.role.slice(-1), c.position]), [['2', 2]], 'Bas passe au-dessus de Haut (resté en 1)');
});

function backupGuild({ positionsFail = false, setFails = false } = {}) {
  const perm = (bits) => new PermissionsBitField(bits);
  const calls = { positions: [], overwrites: [] };
  const role = (id, name, position, managed = false) => ({ id, name, position, managed, permissions: perm(0n), toString: () => `<@&${id}>` });
  const roles = new Collection([
    ['1', role('1', '@everyone', 0)],
    ['2', role('2', 'Bot', 10, true)],
    ['3', role('3', 'Modo', 2)],
  ]);
  let next = 100;
  const overwrite = (id, type, allow = 0n, deny = 0n) => ({ id, type, allow: perm(allow), deny: perm(deny) });
  const channel = (id, name, overwrites) => ({
    id,
    name,
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: new Collection(overwrites.map((o) => [o.id, o])),
      set: async (list, reason) => {
        if (setFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        calls.overwrites.push({ id, list, reason });
      },
    },
  });
  const general = channel('c1', 'general', [overwrite('1', OverwriteType.Role, 0n, 1024n), overwrite('2', OverwriteType.Role, 1024n, 0n)]);
  const same = channel('c2', 'regles', [overwrite('1', OverwriteType.Role, 0n, 2048n)]);
  const guild = {
    id: '1',
    roles: {
      everyone: roles.get('1'),
      cache: roles,
      create: async (opts) => {
        const id = String(next++);
        for (const r of roles.values()) if (r.position >= 1 && r.id !== '1') r.position += 1;
        const created = role(id, opts.name, 1);
        roles.set(id, created);
        return created;
      },
      setPositions: async (list) => {
        if (positionsFail) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        calls.positions.push(list);
        for (const { role: id, position } of list) roles.get(id).position = position;
      },
    },
    members: { me: { id: 'bot', permissions: perm(PermissionsBitField.All), roles: { highest: roles.get('2') } }, cache: new Collection() },
    channels: { cache: new Collection([['c1', general], ['c2', same]]), create: async (opts) => ({ id: String(next++), ...opts }) },
  };
  const data = {
    roles: [{ name: 'Admin', color: 0, permissions: '0' }, { name: 'Modo', color: 0, permissions: '0' }, { name: 'Membre', color: 0, permissions: '0' }],
    channels: [
      { name: 'general', type: ChannelType.GuildText, overwrites: [{ everyone: true, allow: '0', deny: '3072' }, { role: 'Modo', allow: '1024', deny: '0' }, { role: 'Inconnu', allow: '1', deny: '0' }] },
      { name: 'regles', type: ChannelType.GuildText, overwrites: [{ everyone: true, allow: '0', deny: '2048' }] },
    ],
  };
  return { guild, calls, data, roles };
}

test('BackupService.restore : rôles recréés replacés dans l\'ordre de la sauvegarde (un appel)', async () => {
  const { guild, calls, data, roles } = backupGuild();
  const service = new BackupService({ backups: null });
  service.get = () => ({ data });
  const res = await service.restore(guild, 'b1');
  assert.equal(res.roles, 2);
  assert.equal(calls.positions.length, 1, 'un seul appel setPositions');
  const order = [...roles.values()].filter((r) => r.id !== '1' && !r.managed).sort((a, b) => b.position - a.position).map((r) => r.name);
  assert.deepEqual(order, ['Admin', 'Modo', 'Membre']);
  assert.ok(res.reordered >= 1);
  assert.equal(calls.overwrites.length, 0, 'permissions des salons existants intactes par défaut');
  assert.equal(res.syncPermissions, false);

  // Échec du replacement : signalé, la restauration continue.
  const failing = backupGuild({ positionsFail: true });
  service.get = () => ({ data: failing.data });
  const res2 = await service.restore(failing.guild, 'b1');
  assert.ok(res2.failed.some((f) => f.kind === 'order' && f.code === 50013));
  assert.equal(res2.reordered, 0);
});

test('BackupService.restore (option) : permissions des salons existants rétablies, intégrations conservées', async () => {
  const { guild, calls, data } = backupGuild();
  const service = new BackupService({ backups: null });
  service.get = () => ({ data });
  const res = await service.restore(guild, 'b1', { syncPermissions: true });
  assert.equal(res.permissionsSynced, 1, '« regles » déjà identique : non réécrit');
  assert.equal(calls.overwrites.length, 1);
  const { id, list } = calls.overwrites[0];
  assert.equal(id, 'c1');
  const byId = Object.fromEntries(list.map((o) => [o.id, o]));
  assert.equal(byId['1'].deny, 3072n, '@everyone d\'après la sauvegarde');
  assert.equal(byId['3'].allow, 1024n, 'rôle Modo retrouvé par son nom');
  assert.equal(byId['2'].allow, 1024n, 'surcharge du rôle géré (bot) conservée');
  assert.ok(res.skippedOverwrites.includes('@Inconnu'));

  const failing = backupGuild({ setFails: true });
  service.get = () => ({ data: failing.data });
  const res2 = await service.restore(failing.guild, 'b1', { syncPermissions: true });
  assert.ok(res2.failed.some((f) => f.kind === 'permissions' && f.name === 'general'));
  assert.equal(sameOverwrites([{ id: 'a', type: 0, allow: 1n, deny: 0n }], [{ id: 'a', type: 0, allow: '1', deny: '0' }]), true);
});

test('/backup : carte de résultat (rôles replacés, permissions, échecs) et avertissements', () => {
  const b = { id: 'abc123', name: 'Ma sauvegarde' };
  const card = json(backupCmd.restoreResultCard(b, { roles: 2, channels: 0, failed: [{ kind: 'permissions', name: 'general', code: 50013 }, { kind: 'order', name: 'Ordre des rôles', code: 50013 }], skippedOverwrites: [], reparented: 0, reordered: 2, permissionsSynced: 1, syncPermissions: true }));
  const text = card.fields.map((f) => `${f.name}=${f.value}`).join('\n');
  assert.match(text, /Rôles replacés=\*\*2\*\*/);
  assert.match(text, /Permissions rétablies=\*\*1\*\* salon/);
  assert.match(text, /general.*\(permissions\)/);
  assert.match(card.description, /Permissions rétablies dans \*\*1\*\* salon/);
  const only = json(backupCmd.restoreResultCard(b, { roles: 0, channels: 0, failed: [], skippedOverwrites: [], reordered: 0, permissionsSynced: 3, syncPermissions: true }));
  assert.equal(only.title.includes('terminée'), true);
  assert.match(only.description, /Permissions rétablies dans \*\*3\*\* salons/);
  assert.match(backupCmd.restoreWarning(true).join(' '), /seront \*\*remplacées\*\*/);
  assert.doesNotMatch(backupCmd.restoreWarning(false).join(' '), /remplacées/);
});

// ================================================================ 4. défi anti-robot en toutes lettres

test('défi anti-robot : nombres en lettres, aucune réponse lisible dans le libellé', () => {
  assert.equal(W.numberToFrench(7), 'sept');
  assert.equal(W.numberToFrench(17), 'dix-sept');
  assert.equal(W.numberToFrench(21), 'vingt et un');
  assert.equal(W.numberToFrench(30), 'trente');
  assert.throws(() => W.numberToFrench(70));
  // Toutes les variantes : libellé ≤ 45 caractères, sans chiffre, réponse retrouvable.
  const kinds = new Set();
  for (let v = 0; v <= 4; v += 1) {
    for (let a = 2; a <= 29; a += 1) {
      for (let b = 2; b <= 15; b += 1) {
        const seq = [v, a, b];
        const { label, answer } = W.challengeFor((min, max) => Math.min(max, Math.max(min, seq.shift() ?? min)));
        kinds.add(label.split(' ').slice(0, 3).join(' '));
        assert.ok(label.length <= 45, label);
        assert.doesNotMatch(label, /\d/, label);
        assert.match(answer, /^\d+$/);
        assert.equal(W.answerMatches(W.numberToFrench(Number(answer)), answer), true);
      }
    }
  }
  assert.ok(kinds.size >= 4, 'plusieurs formulations');
  assert.equal(W.answerMatches(' 12 ', '12'), true);
  assert.equal(W.answerMatches('Vingt-et-un', '21'), true);
  assert.equal(W.answerMatches('vingt et un', '21'), true);
  assert.equal(W.answerMatches('DIX SEPT', '17'), true);
  assert.equal(W.answerMatches('zero', '0'), true);
  assert.equal(W.answerMatches('treize', '12'), false);
  assert.equal(W.answerMatches('', '12'), false);
});

test('défi anti-robot : usage unique, TTL et verrouillage conservés', () => {
  let t = 1_000_000;
  const { config } = configService();
  const svc = new W.WelcomeService({ config, now: () => t });
  const { label } = svc.createChallenge(G, A);
  assert.doesNotMatch(label, /\d/);
  const { answer } = svc.challenges.get(`${G}:${A}`);
  assert.equal(svc.checkChallenge(G, A, W.numberToFrench(Number(answer))), 'ok', 'réponse en lettres');
  assert.equal(svc.checkChallenge(G, A, answer), 'expired', 'usage unique');
  svc.createChallenge(G, A);
  t += 6 * 60_000;
  assert.equal(svc.checkChallenge(G, A, '1'), 'expired');
  for (let i = 0; i < 5; i += 1) {
    svc.createChallenge(G, A);
    assert.equal(svc.checkChallenge(G, A, 'faux'), 'wrong');
  }
  svc.createChallenge(G, A);
  assert.equal(svc.checkChallenge(G, A, svc.challenges.get(`${G}:${A}`).answer), 'locked');
});

// ================================================================ 5. pièces jointes des transcripts

const MB = 1024 * 1024;
const cdn = (name) => `https://cdn.discordapp.com/attachments/1/2/${name}`;
const attMsg = (id, files, author = 'alice') => ({
  id,
  author: { tag: author },
  attachments: new Collection(files.map((f, i) => [`${id}-${i}`, { name: f.name, url: f.url ?? cdn(f.name), size: f.size }])),
  embeds: [],
});
/** Faux fetch : corps de `size` octets (ou erreur HTTP). */
function fakeFetch(sizes = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    const name = url.split('/').pop();
    if (sizes[name] === 404) return { ok: false, status: 404 };
    if (sizes[name] === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const size = sizes[name] ?? 10;
    return { ok: true, status: 200, headers: { get: () => String(size) }, arrayBuffer: async () => new ArrayBuffer(size) };
  };
}

test('archive : pièces jointes collectées dans les bornes (8 Mo / 24 Mo), échecs listés', async () => {
  const calls = [];
  const messages = [
    attMsg('1', [{ name: 'a.png', size: 1 * MB }, { name: 'gros.zip', size: 9 * MB }]),
    attMsg('2', [{ name: 'b.pdf', size: 7 * MB }, { name: 'c.pdf', size: 7 * MB }, { name: 'd.pdf', size: 7 * MB }, { name: 'e.pdf', size: 7 * MB }]),
    attMsg('3', [{ name: 'perdu.png', size: 5 }, { name: 'lent.png', size: 5 }, { name: 'x.png', size: 5, url: 'https://exemple.com/x.png' }]),
  ];
  const sizes = { 'a.png': 1 * MB, 'b.pdf': 7 * MB, 'c.pdf': 7 * MB, 'd.pdf': 7 * MB, 'perdu.png': 404, 'lent.png': 'timeout' };
  const { files, skipped } = await T.collectAttachments(messages, { fetchImpl: fakeFetch(sizes, calls) });
  assert.deepEqual(files.map((f) => f.name), ['01-a.png', '02-b.pdf', '03-c.pdf', '04-d.pdf'].slice(0, files.length));
  assert.ok(files.reduce((n, f) => n + f.size, 0) <= T.ARCHIVE_TOTAL_MAX);
  const reasons = Object.fromEntries(skipped.map((s) => [s.name, s.reason]));
  assert.match(reasons['gros.zip'], /plus de 8 Mo/);
  assert.match(reasons['e.pdf'], /limite totale de 24 Mo/);
  assert.match(reasons['perdu.png'], /HTTP 404/);
  assert.match(reasons['lent.png'], /délai/);
  assert.match(reasons['x.png'], /hors de Discord/);
  assert.ok(!calls.some((u) => u.includes('exemple.com')), 'aucune requête hors de Discord');
  assert.ok(!calls.some((u) => u.includes('gros.zip')), 'fichier trop lourd non téléchargé');
});

test('archive : lots de 10 fichiers au plus et sous la limite d\'envoi du serveur', () => {
  const files = Array.from({ length: 23 }, (_, i) => ({ name: `f${i}`, size: 100 }));
  const batches = T.batchFiles(files, { maxBytes: 10 * MB, reservedBytes: 1000, reservedSlots: 1 });
  assert.deepEqual(batches.map((b) => b.length), [9, 10, 4]);
  const big = [{ size: 6 * MB }, { size: 6 * MB }, { size: 3 * MB }];
  assert.deepEqual(T.batchFiles(big, { maxBytes: 10 * MB, reservedBytes: 5 * MB }).map((b) => b.length), [0, 1, 2]);
  assert.equal(T.uploadLimit({ premiumTier: 0 }), 10 * MB);
  assert.equal(T.uploadLimit({ premiumTier: 2 }), 50 * MB);
  assert.equal(T.archiveName('../../etc/passwd', 0), '01-etc_passwd');
});

test('archive : liens « Pièces jointes » des cartes ModMail relayées', () => {
  const msg = { id: '9', author: { tag: 'bot' }, attachments: new Collection(), embeds: [{ author: { name: 'bob a écrit' }, fields: [{ name: '📎 Pièces jointes', value: `[photo.png](${cdn('photo.png')})\n[doc.pdf](${cdn('doc.pdf')})` }, { name: 'Autre', value: `[x](${cdn('x')})` }] }] };
  const list = T.attachmentsOf(msg);
  assert.deepEqual(list.map((a) => [a.name, a.author]), [['photo.png', 'bob'], ['doc.pdf', 'bob']]);
});

test('archive : option désactivée = comportement historique ; activée = fichiers joints, repli si refus', async () => {
  const sent = [];
  const channel = { guild: { premiumTier: 0 }, send: async (p) => { sent.push(p); return { edit: async () => {} }; } };
  const card = (summary) => ({ title: 'Archive', fields: attachmentFields(summary) });
  const messages = [attMsg('1', [{ name: 'a.png', size: 10 }])];
  const off = await T.sendTranscriptArchive(channel, { transcript: { name: 't.txt', content: 'log' }, messages, archiveAttachments: false, card, fetchImpl: () => assert.fail('aucun téléchargement') });
  assert.equal(off, null);
  assert.deepEqual(sent[0].files.map((f) => f.name), ['t.txt']);

  sent.length = 0;
  const on = await T.sendTranscriptArchive(channel, { transcript: { name: 't.txt', content: 'log' }, messages, archiveAttachments: true, card, fetchImpl: fakeFetch() });
  assert.deepEqual(on, { archived: 1, skipped: [] });
  assert.deepEqual(sent[0].files.map((f) => f.name), ['t.txt', '01-a.png']);
  assert.match(sent[0].files[0].attachment.toString(), /Pièces jointes archivées \(1\)[\s\S]*01-a\.png ← « a\.png » \(alice\)/);
  assert.ok(JSON.stringify(sent[0].embeds).includes('archivée'));

  // Envoi refusé avec les fichiers : le transcript part seul, l'échec est listé.
  sent.length = 0;
  let first = true;
  const picky = { guild: {}, send: async (p) => { if (first && p.files.length > 1) { first = false; throw Object.assign(new Error('Request entity too large'), { code: 40005 }); } sent.push(p); return {}; } };
  const res = await T.sendTranscriptArchive(picky, { transcript: { name: 't.txt', content: 'log' }, messages, archiveAttachments: true, card, fetchImpl: fakeFetch() });
  assert.equal(res.archived, 0);
  assert.deepEqual(res.skipped, [{ name: 'a.png', reason: 'envoi refusé par Discord' }]);
  assert.deepEqual(sent[0].files.map((f) => f.name), ['t.txt']);
  assert.match(sent[0].files[0].attachment.toString(), /non archivées \(1\)/);
});

test('tickets.archiveAttachments : désactivé par défaut', () => {
  assert.equal(defaults.tickets.archiveAttachments, false);
  assert.deepEqual(attachmentFields(null), []);
  assert.deepEqual(attachmentFields({ archived: 0, skipped: [] }), []);
  const fields = attachmentFields({ archived: 2, skipped: [{ name: 'gros.zip', reason: 'plus de 8 Mo' }] });
  assert.match(fields[0].value, /\*\*2\*\* archivées\n1 non archivée/);
  assert.match(fields[1].value, /gros\.zip.*plus de 8 Mo/);
});
