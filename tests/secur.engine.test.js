'use strict';

/**
 * Secur (SEC1) : moteur anti-nuke — niveaux, fenêtre sur l'horodatage, incident unique, file
 * d'annulation et disjoncteur, politique « bot auteur », pré-contrôle, accès en attente, remise
 * hors filtres, journal, coquille /secur, EventHandler (prepend), étape security du scheduler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SecurityIncidentRepository } = require('../src/database/repositories/SecurityIncidentRepository');
const { SecurityGrantRepository } = require('../src/database/repositories/SecurityGrantRepository');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { AntiRaidService, burstCount } = require('../src/services/AntiRaidService');
const { SecurService, bestWindow, auditTimestamp } = require('../src/services/SecurService');
const { SecurRegistry } = require('../src/services/secur/registry');
const { SecurNotifier } = require('../src/services/secur/notify');
const { UndoQueue, UndoBreaker } = require('../src/services/secur/undoQueue');
const { classifyCritical } = require('../src/services/secur/journal');
const S = require('../src/utils/secur');
const { defaultGuildConfig } = require('../src/config/defaults');
const { snowflakeAt } = require('./e2e/lib/ids');

const G = '100000000000000001';
const BOT = '100000000000000010';
const OWNER = '100000000000000011';
const BOT_OWNER = '100000000000000012';
const SECOWNER = '100000000000000013';
const MOD = '100000000000000014';
const OTHERBOT = '100000000000000015';
const TARGET = '100000000000000016';
const SEC_CH = '100000000000000020';
const R_MOD = '100000000000000030';
const R_WL = '100000000000000031';
const R_ADMIN = '100000000000000032';
const R_BOTMANAGED = '100000000000000033';
const DAY = 86_400_000;
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const tick = () => new Promise((r) => setImmediate(r));

function makeRole(id, { position = 1, perms = 0n, managed = false, editable = true } = {}) {
  return { id, position, managed, editable, permissions: new PermissionsBitField(perms), toString: () => `<@&${id}>` };
}

/** Module de test (classify : une action par entrée ; undo enregistré). */
function testModule(key, { undo, classify } = {}) {
  return {
    key,
    auditTypes: S.SECUR_MODULES[key].auditTypes,
    priority: 3,
    classify: classify ?? ((entry) => ({ weight: 1, record: { target: entry.targetId } })),
    undo,
    targetKey: (r) => r?.target ?? null,
    describe: (r) => String(r?.target),
  };
}

/** Monde de test : vraie base, vraie configuration, vrai AntiRaid, faux serveur. */
function world({ cfg = {}, modules = [], trust = false, now } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const incidents = new SecurityIncidentRepository(db);
  const grants = new SecurityGrantRepository(db);
  const sanctions = new SanctionRepository(db);
  const rest = [];
  const posts = [];
  const dms = [];
  const logged = [];
  const undone = [];
  const roles = new Collection();
  const everyone = makeRole(G, { position: 0 });
  roles.set(G, everyone);
  for (const r of [makeRole(R_MOD, { position: 5, perms: P.BanMembers | P.KickMembers }), makeRole(R_WL, { position: 2 }), makeRole(R_ADMIN, { position: 9, perms: P.Administrator, editable: false }), makeRole(R_BOTMANAGED, { position: 6, perms: P.Administrator, managed: true, editable: false })]) roles.set(r.id, r);
  const channels = new Collection();
  const message = (p) => {
    const msg = { id: `m${posts.length}`, payload: p, edit: async (q) => { rest.push({ op: 'edit' }); msg.payload = q; return msg; } };
    return msg;
  };
  channels.set(SEC_CH, { id: SEC_CH, guildId: G, send: async (p) => { posts.push(p); return message(p); } });
  const members = new Collection();
  const guild = {
    id: G,
    name: 'Serveur',
    ownerId: OWNER,
    roles: { cache: roles, everyone },
    channels: { cache: channels },
    members: {
      cache: members,
      me: null,
      fetch: async (id) => {
        rest.push({ op: 'fetchMember', id });
        const m = members.get(id);
        if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return m;
      },
    },
    bans: { create: async (id) => void rest.push({ op: 'ban', id }), remove: async (id) => void rest.push({ op: 'unban', id }) },
    systemChannel: null,
  };
  const client = {
    user: { id: BOT },
    config: { ownerIds: [BOT_OWNER], securTrustBotOwners: trust },
    guilds: { cache: new Map([[G, guild]]) },
    channels: { fetch: async () => null },
    users: { fetch: async (id) => ({ id, bot: false, send: async (p) => void dms.push([id, p]) }) },
    repositories: { sanctions, securityIncidents: incidents },
    services: {},
  };
  const logging = { send: async (...a) => { logged.push(a); return false; } };
  const antiraid = new AntiRaidService({ client, config, logging });
  const registry = new SecurRegistry();
  for (const m of modules) registry.register(typeof m === 'string' ? testModule(m, { undo: async (_g, rec) => { undone.push(rec); return { ok: true }; } }) : m);
  const secur = new SecurService({ client, config, logging, antiraid, incidents, grants, registry, ...(now ? { now } : {}) });
  client.services = { config, antiraid, secur, moderation: { markBotAction() {}, unmarkBotAction() {} } };
  config.update(G, { logChannels: { security: SEC_CH }, ...cfg });

  const addMember = (id, { roleIds = [], bot = false, joinedDaysAgo = 400, kickable = true, bannable = true } = {}) => {
    const member = {
      id,
      guild,
      user: { id, bot, tag: `u${id}`, username: `u${id}`, toString: () => `<@${id}>` },
      joinedTimestamp: Date.now() - joinedDaysAgo * DAY,
      kickable,
      bannable,
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        async remove(target) {
          const ids = typeof target === 'string' ? [target] : [...target.keys()];
          rest.push({ op: typeof target === 'string' ? 'removeRole' : 'stripPatch', id, roles: ids });
          for (const r of ids) member.roles.cache.delete(r);
        },
        async add(roleId) {
          rest.push({ op: 'addRole', id, roleId });
          member.roles.cache.set(roleId, roles.get(roleId));
        },
      },
      kick: async () => {
        rest.push({ op: 'kick', id });
        members.delete(id);
      },
    };
    members.set(id, member);
    return member;
  };
  const setModule = (key, patch) => config.update(G, { secur: { modules: { [key]: { mode: 'on', ...patch } } } });
  const entry = (action, executorId, { at = Date.now(), targetId = TARGET, changes = [] } = {}) => ({ id: snowflakeAt(at), action, executorId, targetId, changes });
  const drain = async () => {
    for (let i = 0; i < 500; i += 1) {
      if (![...secur.queues.values()].some((q) => q.busy)) break;
      await tick();
    }
    await Promise.all([...secur.open.values()].map((s) => s.chain));
  };
  return { db, config, incidents, grants, sanctions, secur, antiraid, registry, client, guild, members, roles, rest, posts, dms, logged, undone, addMember, setModule, entry, drain };
}

// ---------------------------------------------------------------- niveaux et exemptions

test('niveaux : matrice d\'exemption on / max (bot, propriétaire, OWNER_IDS, owner, confiance, whitelist, accès en attente, membre)', () => {
  const guild = { id: G, ownerId: OWNER, client: { user: { id: BOT } }, roles: { cache: new Collection([[R_WL, { id: R_WL, managed: false }], [R_BOTMANAGED, { id: R_BOTMANAGED, managed: true }]]) } };
  const cfg = { secur: { owners: [SECOWNER], trustedBots: [OTHERBOT] }, whitelist: { users: [MOD], roles: [R_WL, R_BOTMANAGED] } };
  const lvl = (id, roles = [], opts = {}) => S.securityLevel(guild, id, roles, cfg, { botOwnerIds: [BOT_OWNER], ...opts });
  assert.equal(lvl(BOT), 'bot');
  assert.equal(lvl(OWNER), 'proprietaire');
  assert.equal(lvl(BOT_OWNER), 'membre', 'OWNER_IDS sans SECUR_TRUST_BOT_OWNERS : aucun privilège');
  assert.equal(lvl(BOT_OWNER, [], { trustBotOwners: true }), 'proprietaire-bot');
  assert.equal(lvl(SECOWNER), 'owner');
  assert.equal(lvl(OTHERBOT, [], { isBot: true }), 'confiance');
  assert.equal(lvl(OTHERBOT, [], { isBot: false }), 'membre', 'bot de confiance : réservé aux bots');
  assert.equal(lvl(MOD), 'whitelist');
  assert.equal(lvl(TARGET, [R_WL]), 'whitelist');
  assert.equal(lvl(TARGET, [R_BOTMANAGED]), 'membre', 'rôle géré : jamais immunisant');
  assert.equal(lvl(MOD, [], { pending: { user: true, roles: new Set() } }), 'membre', 'accès utilisateur en attente');
  assert.equal(lvl(TARGET, [R_WL], { pending: { user: false, roles: new Set([R_WL]) } }), 'membre', 'rôle whitelisté en attente');
  assert.equal(lvl(TARGET), 'membre');
  const table = { bot: [true, true], proprietaire: [true, true], 'proprietaire-bot': [true, true], owner: [true, true], confiance: [true, true], whitelist: [true, false], membre: [false, false] };
  for (const [level, [on, max]] of Object.entries(table)) {
    assert.equal(S.isExempt(level, 'on'), on, `${level} en on`);
    assert.equal(S.isExempt(level, 'max'), max, `${level} en max`);
  }
  assert.equal(S.isExempt('membre', 'off'), true);
  assert.equal(S.hasOwnerLevel(guild, SECOWNER, cfg), true);
  assert.equal(S.hasOwnerLevel(guild, MOD, cfg), false);
  assert.throws(() => S.assertOwnerLevel(guild, MOD, cfg), /Réservé au propriétaire du serveur et aux owners de sécurité/);
  assert.equal(S.canManageOwners(guild, OWNER), true);
  assert.equal(S.canManageOwners(guild, BOT_OWNER, { botOwnerIds: [BOT_OWNER] }), false);
  assert.equal(S.canManageOwners(guild, BOT_OWNER, { botOwnerIds: [BOT_OWNER], trustBotOwners: true }), true);
  assert.equal(S.own({ a: 1 }, '__proto__'), false);
  assert.equal(S.own({ a: 1 }, 'constructor'), false);
  assert.equal(S.own({ a: 1 }, 'a'), true);
});

test('effectiveLimit : null hérite des seuils AntiRaid (3 si le seuil vaut 0), bornes appliquées', () => {
  const cfg = (secur, antiraid = {}) => ({ secur: { modules: secur }, antiraid: { banThreshold: 5, kickThreshold: 0, ...antiraid } });
  assert.equal(S.effectiveLimit(cfg({}), 'ban'), 5, 'ban : limit null → banThreshold');
  assert.equal(S.effectiveLimit(cfg({}), 'kick'), 3, 'kick : seuil 0 → 3');
  assert.equal(S.effectiveLimit(cfg({}, { banThreshold: 0 }), 'ban'), 3);
  assert.equal(S.effectiveLimit(cfg({ ban: { limit: 2 } }), 'ban'), 2);
  assert.equal(S.effectiveLimit(cfg({ channelDelete: { limit: 500 } }), 'channelDelete'), 100);
  assert.equal(S.effectiveLimit(cfg({}), 'channelDelete'), 1);
  assert.equal(S.effectiveLimit({ ...defaultGuildConfig }, 'roleRemove'), 3);
  assert.equal(S.effectiveLimit({ ...defaultGuildConfig }, 'ban'), defaultGuildConfig.antiraid.banThreshold);
});

test('configuration : les 20 modules déclarés ont leur bloc par défaut, tout coupé ; préréglages sans toucher punish ni undo', () => {
  assert.deepEqual(Object.keys(defaultGuildConfig.secur.modules).sort(), [...S.MODULE_KEYS].sort());
  assert.equal(S.MODULE_KEYS.length, 20); // revue 7 (S16) : + timeout, threadDelete
  for (const key of S.MODULE_KEYS) assert.equal(defaultGuildConfig.secur.modules[key].mode, 'off', key);
  assert.equal(defaultGuildConfig.secur.modules.everyone.punish, 'none');
  const max = S.presetPatch('max', defaultGuildConfig.secur.modules);
  assert.equal(max.ban.limit, 2);
  assert.equal(max.voiceKick.limit, 3);
  assert.equal(max.channelUpdate.ignoreBenign, false);
  assert.equal(max.webhook.ignoreFollowers, false);
  for (const key of S.MODULE_KEYS) {
    assert.equal(max[key].mode, 'max');
    assert.equal('punish' in max[key] || 'undo' in max[key], false, `${key} : punish/undo touchés`);
  }
  const on = S.presetPatch('on', defaultGuildConfig.secur.modules);
  assert.equal(on.ban.limit, null);
  assert.equal(on.roleUpdate.dangerousOnly, true);
  assert.equal(S.presetPatch('off', defaultGuildConfig.secur.modules).kick.mode, 'off');
});

// ---------------------------------------------------------------- registre

test('registre : clé inconnue, type d\'un autre module ou module en double refusés ; types partagés déclarés permis', () => {
  const r = new SecurRegistry();
  assert.throws(() => r.register({ key: 'antiNuke', auditTypes: [], classify() {} }), /clé inconnue/);
  assert.throws(() => r.register({ key: 'channelCreate', auditTypes: [12], classify() {} }), /appartient au module « channelDelete »/);
  assert.throws(() => r.register({ key: 'channelCreate', auditTypes: [999], classify() {} }), /n'est déclaré par aucun module/);
  assert.throws(() => r.register({ key: 'channelCreate', auditTypes: [10] }), /classify manquant/);
  r.register(testModule('roleAdd'));
  r.register(testModule('roleRemove'));
  assert.equal(r.forType(25).length, 2, 'roleAdd et roleRemove partagent l\'audit 25 (déclaré)');
  assert.throws(() => r.register(testModule('roleAdd')), /chargé deux fois/);
  const registry = new SecurRegistry().load(path.join(__dirname, '..', 'src', 'services', 'secur', 'modules'));
  assert.deepEqual(registry.failures, []);
  // Modules livrés par SEC4 / SEC5 : tous déclarés dans SECUR_MODULES.
  assert.ok(registry.keys().every((k) => S.MODULE_KEYS.includes(k)), 'module chargé hors SECUR_MODULES');
});

test('covers : faux pour un module déclaré mais non chargé (même en « on »), vrai pour un module chargé actif', () => {
  const w = world({ modules: ['channelDelete'] });
  w.setModule('channelCreate', {});
  w.setModule('channelDelete', {});
  assert.equal(w.secur.covers(G, 'channelCreate'), false);
  assert.equal(w.secur.covers(G, 'channelDelete'), true);
  const status = Object.fromEntries(w.secur.moduleStatus(G).map((m) => [m.key, m]));
  assert.equal(status.channelCreate.loaded, false);
  assert.equal(status.channelDelete.loaded, true);
  w.setModule('channelDelete', { mode: 'off' });
  assert.equal(w.secur.covers(G, 'channelDelete'), false);
});

test('tout en « off » : une entrée d\'audit ne provoque AUCUN appel (ni lecture de membre, ni message)', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.addMember(MOD, { roleIds: [R_MOD] });
  await w.secur.handleAuditEntry(w.entry(12, MOD), w.guild);
  await w.drain();
  assert.deepEqual(w.rest, []);
  assert.equal(w.posts.length + w.dms.length + w.logged.length, 0);
});

// ---------------------------------------------------------------- fenêtre sur l'horodatage

test('fenêtre sur l\'horodatage : -6, -4, -2 min → aucun incident ; 3 entrées des mêmes 10 s reçues 2 min plus tard → incident SANS annulation', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.setModule('channelDelete', { limit: 3, windowSeconds: 10 });
  w.addMember(MOD, { roleIds: [R_MOD] });
  const now = Date.now();
  for (const min of [6, 4, 2]) await w.secur.handleAuditEntry(w.entry(12, MOD, { at: now - min * 60_000, targetId: `c${min}` }), w.guild);
  await w.drain();
  assert.equal(w.incidents.recent(G, 5).length, 0, 'entrées étalées sur 4 min additionnées');
  assert.ok(w.members.get(MOD).roles.cache.has(R_MOD));
  for (const s of [120, 118, 116]) await w.secur.handleAuditEntry(w.entry(12, MOD, { at: now - s * 1000, targetId: `l${s}` }), w.guild);
  await w.drain();
  const [incident] = w.incidents.recent(G, 5);
  assert.ok(incident, 'rafale reçue en retard non détectée');
  assert.equal(w.undone.length, 0, 'une entrée de plus de 60 s ne doit JAMAIS être annulée');
  assert.match(incident.outcome, /plus de 60 s après coup/);
  assert.equal(incident.punishment, 'derank');
  // Fonctions pures de fenêtre.
  assert.equal(bestWindow([{ at: 0, weight: 1 }, { at: 5_000, weight: 1 }, { at: 30_000, weight: 1 }], 5_000, 10_000).sum, 2);
  assert.equal(burstCount([0, 120_000, 240_000], 240_000, 10_000), 1);
  assert.equal(auditTimestamp({ id: snowflakeAt(1_700_000_000_000) }), 1_700_000_000_000);
});

test('50 entrées concurrentes → UNE sanction (un seul PATCH), UNE ligne d\'incident, 50 tâches d\'annulation', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.setModule('channelDelete', { limit: 1 });
  w.addMember(MOD, { roleIds: [R_MOD] });
  const now = Date.now();
  await Promise.all(Array.from({ length: 50 }, (_, i) => w.secur.handleAuditEntry(w.entry(12, MOD, { at: now - 1_000 + i, targetId: `c${i}` }), w.guild)));
  await w.drain();
  assert.equal(w.rest.filter((r) => r.op === 'stripPatch').length, 1, 'plusieurs sanctions');
  const rows = w.incidents.recent(G, 50);
  assert.equal(rows.length, 1, 'plusieurs lignes d\'incident');
  assert.equal(rows[0].actions, 50);
  assert.equal(w.undone.length, 50);
  assert.equal(rows[0].undone, 50);
  assert.deepEqual(rows[0].removed_roles, [R_MOD]);
  assert.equal(w.posts.length, 1, 'une seule carte d\'incident');
  const card = json(w.posts[0].embeds[0]);
  assert.match(card.title, /Incident Secur/);
  assert.equal(w.posts[0].components.flatMap((r) => json(r).components).find((c) => c.custom_id === `secur:restore:${rows[0].id}`)?.label, 'Rendre les rôles');
  assert.ok(w.dms.some(([to]) => to === OWNER), 'MP au propriétaire (événement critique)');
});

test('escalade : derank puis ban quand un module plus sévère se déclenche — toujours une seule ligne', async () => {
  const w = world({ modules: ['channelDelete', 'roleDelete'] });
  w.setModule('channelDelete', { limit: 1, punish: 'derank' });
  w.setModule('roleDelete', { limit: 1, punish: 'ban' });
  w.addMember(MOD, { roleIds: [R_MOD] });
  await w.secur.handleAuditEntry(w.entry(12, MOD, { targetId: 'c1' }), w.guild);
  await w.secur.handleAuditEntry(w.entry(32, MOD, { targetId: 'r1' }), w.guild);
  await w.drain();
  assert.equal(w.rest.filter((r) => r.op === 'stripPatch').length, 1);
  assert.equal(w.rest.filter((r) => r.op === 'ban' && r.id === MOD).length, 1);
  const rows = w.incidents.recent(G, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].punishment, 'ban');
  assert.deepEqual(rows[0].modules.sort(), ['channelDelete', 'roleDelete']);
  assert.equal(w.sanctions.listByUser(G, MOD).length, 1, 'ban inscrit au casier');
});

test('punish « none » avec un exécutant BOT : aucune expulsion (la punition du module prime)', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.setModule('channelDelete', { limit: 1, punish: 'none' });
  w.addMember(OTHERBOT, { bot: true, roleIds: [R_BOTMANAGED], joinedDaysAgo: 1 });
  await w.secur.handleAuditEntry(w.entry(12, OTHERBOT), w.guild);
  await w.drain();
  assert.equal(w.rest.filter((r) => ['kick', 'ban', 'stripPatch'].includes(r.op)).length, 0);
  assert.equal(w.incidents.recent(G, 1)[0].punishment, 'none');
});

test('botExecutor : bot récent → expulsé ; bot ancien → carte + bouton ; « always » → expulsé ; « never » → carte', async () => {
  const run = async (policy, joinedDaysAgo) => {
    const w = world({ modules: ['channelDelete'], cfg: { secur: { botExecutor: policy } } });
    w.setModule('channelDelete', { limit: 1 });
    w.addMember(OTHERBOT, { bot: true, roleIds: [R_BOTMANAGED], joinedDaysAgo });
    await w.secur.handleAuditEntry(w.entry(12, OTHERBOT), w.guild);
    await w.drain();
    const kicked = w.rest.some((r) => r.op === 'kick' && r.id === OTHERBOT);
    const buttons = (w.posts[0]?.components ?? []).flatMap((r) => json(r).components).map((c) => c.custom_id);
    return { kicked, kickButton: buttons.includes(`secur:kickbot:${OTHERBOT}`), title: json(w.posts[0]?.embeds?.[0])?.title ?? '' };
  };
  assert.deepEqual(await run('recent', 2).then((r) => [r.kicked, r.kickButton]), [true, false], 'bot récent');
  const old = await run('recent', 200);
  assert.deepEqual([old.kicked, old.kickButton], [false, true], 'bot ancien : carte et bouton');
  assert.match(old.title, /Bot non neutralisé automatiquement/);
  assert.deepEqual(await run('always', 200).then((r) => [r.kicked, r.kickButton]), [true, false]);
  assert.deepEqual(await run('never', 2).then((r) => [r.kicked, r.kickButton]), [false, true]);
});

test('permission dangereuse résiduelle après le derank (rôle au-dessus du bot) → expulsion', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.setModule('channelDelete', { limit: 1 });
  w.addMember(MOD, { roleIds: [R_MOD, R_ADMIN] });
  await w.secur.handleAuditEntry(w.entry(12, MOD), w.guild);
  await w.drain();
  assert.ok(w.rest.some((r) => r.op === 'stripPatch'));
  assert.ok(w.rest.some((r) => r.op === 'kick' && r.id === MOD), 'auteur gardant Administrateur non expulsé');
  assert.equal(w.incidents.recent(G, 1)[0].punishment, 'kick');
});

// ---------------------------------------------------------------- file d'annulation et disjoncteur

test('disjoncteur : 3 annulations du même objet en 60 s → module suspendu 5 min, aucune 4ᵉ tentative, carte de conflit', async () => {
  const attempts = [];
  const mod = testModule('channelDelete', { undo: async (_g, rec) => { attempts.push(rec.target); return { ok: true }; } });
  const w = world({ modules: [mod] });
  w.setModule('channelDelete', { limit: 1 });
  w.addMember(OTHERBOT, { bot: true, roleIds: [], joinedDaysAgo: 400 });
  for (let i = 0; i < 6; i += 1) await w.secur.handleAuditEntry(w.entry(12, OTHERBOT, { at: Date.now() - 500 + i, targetId: 'same-channel' }), w.guild);
  await w.drain();
  assert.equal(attempts.length, 3, `${attempts.length} tentatives d'annulation du même objet`);
  assert.ok(w.secur.breaker.isSuspended(G, 'channelDelete'));
  assert.ok(w.secur.covers(G, 'channelDelete'), 'module suspendu : toujours couvert (pas de retour au chemin historique)');
  assert.ok(w.posts.some((p) => /Conflit d'annulation/.test(json(p.embeds[0]).title)));
  // Breaker pur : suspension levée après 5 min.
  let t = 0;
  const b = new UndoBreaker({ now: () => t });
  for (let i = 0; i < 2; i += 1) assert.equal(b.note(G, 'x', 'o'), false);
  assert.equal(b.note(G, 'x', 'o'), true);
  t = 5 * 60_000 + 1;
  assert.equal(b.isSuspended(G, 'x'), false);
});

test('file d\'annulation : priorités (rôles avant salons), plafond de 500, arrêt sans attente infinie', async () => {
  const order = [];
  const q = new UndoQueue({ execute: async (t) => order.push(t.priority) });
  q.lanes[2].push({ priority: 3 }, { priority: 3 });
  q.lanes[0].push({ priority: 1 });
  q.size = 3;
  q.push({ priority: 5 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, [1, 3, 3, 5]);
  const full = new UndoQueue({ execute: () => new Promise(() => {}), maxTasks: 2 });
  assert.equal(full.push({ priority: 1 }), true); // en cours
  assert.equal(full.push({ priority: 1 }), true); // en attente (1/2)
  assert.equal(full.push({ priority: 1 }), true); // en attente (2/2)
  assert.equal(full.push({ priority: 1 }), false, 'plafond de tâches en attente dépassé');
  const started = Date.now();
  await full.stop(50);
  assert.ok(Date.now() - started < 1_000, 'stop() attend la tâche bloquée sans fin');
  let paused = true;
  const p = new UndoQueue({ isPaused: () => paused, execute: async () => order.push('ran'), pauseRetryMs: 5 });
  p.push({ priority: 1 });
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(!order.includes('ran'), 'tâche exécutée pendant une restauration /backup');
  paused = false;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(order.includes('ran'));
});

// ---------------------------------------------------------------- pré-contrôle

test('assertAllowed (chemin historique) : 10 bans face à un seuil de 3 → refus ; whitelisté → accepté ; accès en attente → refusé ; 3 refus → sanction', async () => {
  const w = world({ cfg: { antiraid: { enabled: true, banThreshold: 3, punishExecutor: 'strip' } } });
  const mod = w.addMember(MOD, { roleIds: [R_MOD] });
  const ctx = { guild: w.guild, user: mod.user, member: mod };
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 10 }), /Action bloquée par la sécurité \(Bannissements\) : 10 action\(s\) atteindraient le seuil\. Demandez à un owner\./);
  assert.equal(w.secur.assertAllowed(ctx, 'ban', { count: 2 }), true);
  w.config.update(G, { whitelist: { users: [MOD] } });
  assert.equal(w.secur.assertAllowed(ctx, 'ban', { count: 10 }), true, 'whitelisté refusé');
  w.grants.create({ guildId: G, kind: 'user', subjectId: MOD, grantedBy: TARGET });
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 10 }), /Action bloquée/, 'accès en attente : exempté à tort');
  // Refus répétés (3 en 10 min) : l'auteur est traité comme l'auteur d'un incident.
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 10 }));
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 10 }));
  for (let i = 0; i < 50 && !w.rest.some((r) => r.op === 'stripPatch'); i += 1) await tick();
  assert.ok(w.rest.some((r) => r.op === 'stripPatch' && r.id === MOD), 'tentatives répétées non sanctionnées');
  assert.ok(w.logged.some(([, , e]) => /Action bloquée par la sécurité/.test(json(e).title)), 'tentative bloquée non journalisée');
});

test('assertAllowed (module Secur) : count ajouté à la fenêtre courante ; exempté selon le mode', async () => {
  const w = world({ modules: ['ban'] });
  w.setModule('ban', { limit: 3 });
  const mod = w.addMember(MOD, { roleIds: [R_MOD] });
  const ctx = { guild: w.guild, user: mod.user, member: mod };
  assert.equal(w.secur.assertAllowed(ctx, 'ban', { count: 2 }), true);
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 3 }), /Action bloquée par la sécurité \(Bannissements\)/);
  await w.secur.reportBotAction(w.guild, mod.user, 'ban', { count: 2, targetId: TARGET });
  assert.equal(w.secur.windowSum(G, MOD, 'ban'), 2);
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 1 }), /Action bloquée/);
  w.config.update(G, { whitelist: { users: [MOD] } });
  assert.equal(w.secur.assertAllowed(ctx, 'ban', { count: 50 }), true, 'whitelisté en « on »');
  w.setModule('ban', { mode: 'max', limit: 3 });
  assert.throws(() => w.secur.assertAllowed(ctx, 'ban', { count: 50 }), /Action bloquée/, 'whitelisté exempté en « max »');
});

// ---------------------------------------------------------------- restauration, accès en attente

test('« Rendre les rôles » : deux clics concurrents → un seul applyRoles ; deferUpdate appelé avant', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.setModule('channelDelete', { limit: 1 });
  w.addMember(MOD, { roleIds: [R_MOD] });
  await w.secur.handleAuditEntry(w.entry(12, MOD), w.guild);
  await w.drain();
  const [row] = w.incidents.recent(G, 1);
  const order = [];
  const interaction = () => ({
    guild: w.guild,
    user: { id: OWNER, tag: 'owner' },
    deferUpdate: async () => order.push('defer'),
    editReply: async () => order.push('edit'),
    followUp: async (p) => order.push(`followUp:${json(p.embeds[0]).description}`),
  });
  const before = w.rest.length;
  await Promise.all([w.secur.restore(interaction(), row.id), w.secur.restore(interaction(), row.id)]);
  const adds = w.rest.slice(before).filter((r) => r.op === 'addRole');
  assert.equal(adds.length, 1, `${adds.length} rôle(s) rendu(s)`);
  assert.equal(order[0], 'defer');
  assert.ok(order.indexOf('defer') < order.findIndex((o) => o === 'edit'));
  assert.ok(order.some((o) => /déjà été restauré/.test(o)));
  assert.ok(w.members.get(MOD).roles.cache.has(R_MOD));
  // Réservé au niveau owner.
  await assert.rejects(w.secur.restore({ ...interaction(), user: { id: MOD } }, row.id), /Réservé au propriétaire/);
});

test('accès en attente : rôle whitelisté donné par un non-owner (audit 25) → carte, MP, n\'exempte pas ; approuver → exempte ; révoquer → rôle retiré', async () => {
  const w = world({ cfg: { whitelist: { roles: [R_WL] }, antiraid: { enabled: true, channelDeleteThreshold: 2 } } });
  const mod = w.addMember(MOD, { roleIds: [R_MOD, R_WL] });
  await w.secur.handleAuditEntry(w.entry(25, MOD, { targetId: MOD, changes: [{ key: '$add', new: [{ id: R_WL, name: 'Confiance' }] }] }), w.guild);
  const [grant] = w.secur.pendingGrants(G);
  assert.ok(grant, 'accès non enregistré');
  assert.equal(grant.kind, 'role');
  assert.equal(w.secur.levelOf(w.guild, MOD, mod), 'membre', 'accès en attente : exempté à tort');
  assert.equal(w.antiraid.isWhitelisted(G, MOD, [R_WL], { excludePending: true }), false);
  assert.equal(w.antiraid.isWhitelisted(G, MOD, [R_WL]), true, 'les vagues d\'arrivées gardent l\'exemption immédiate');
  const card = w.posts.find((p) => /Accès de whitelist en attente/.test(json(p.embeds[0]).title));
  assert.ok(card, 'carte d\'accès absente');
  assert.deepEqual(card.components.flatMap((r) => json(r).components).map((c) => c.custom_id), [`secur:grant:${grant.id}:approve`, `secur:grant:${grant.id}:revoke`]);
  assert.ok(w.dms.some(([to]) => to === OWNER), 'MP au propriétaire');
  // Le même accès rejoué : pas de doublon.
  await w.secur.handleAuditEntry(w.entry(25, MOD, { targetId: MOD, changes: [{ key: '$add', new: [{ id: R_WL }] }] }), w.guild);
  assert.equal(w.secur.pendingGrants(G).length, 1);
  // Un owner attribue le rôle : pas d'attente.
  w.config.update(G, { secur: { owners: [SECOWNER] } });
  await w.secur.handleAuditEntry(w.entry(25, SECOWNER, { targetId: TARGET, changes: [{ key: '$add', new: [{ id: R_WL }] }] }), w.guild);
  assert.equal(w.secur.pendingGrants(G).length, 1);

  const click = (userId, action) => {
    const calls = [];
    return { calls, i: { guild: w.guild, user: { id: userId, tag: userId }, deferUpdate: async () => calls.push('defer'), editReply: async (p) => calls.push(['edit', p]), followUp: async (p) => calls.push(['followUp', json(p.embeds[0]).description]) }, action };
  };
  await assert.rejects(w.secur.decideGrant(click(MOD, 'approve').i, grant.id, 'approve'), /Réservé au propriétaire/);
  const a = click(OWNER);
  const b = click(SECOWNER);
  await Promise.all([w.secur.decideGrant(a.i, grant.id, 'approve'), w.secur.decideGrant(b.i, grant.id, 'revoke')]);
  const winners = [a, b].filter((c) => c.calls.some((x) => Array.isArray(x) && x[0] === 'followUp' && !/déjà été traité/.test(x[1])));
  assert.equal(winners.length, 1, 'approuver et révoquer en même temps : un seul gagnant');
  assert.equal(w.secur.pendingGrants(G).length, 0);

  // Révocation d'un autre accès : le rôle est retiré.
  const { id } = w.grants.create({ guildId: G, kind: 'role', subjectId: MOD, roleId: R_WL, grantedBy: TARGET });
  mod.roles.cache.set(R_WL, w.roles.get(R_WL));
  await w.secur.decideGrant(click(OWNER).i, id, 'revoke');
  assert.ok(w.rest.some((r) => r.op === 'removeRole' && r.roles.includes(R_WL)), 'rôle whitelisté non retiré');
});

// ---------------------------------------------------------------- remise des alertes

/** Notifier sur un faux serveur. */
function notifyWorld({ cfg = {}, security = true, now } = {}) {
  const posts = [];
  const dms = [];
  const logged = [];
  const channels = new Collection();
  if (security) channels.set(SEC_CH, { id: SEC_CH, send: async (p) => { posts.push(p); return { id: 'm', edit: async () => {} }; } });
  const guild = { id: G, name: 'Serveur', ownerId: OWNER, channels: { cache: channels }, members: { me: null }, roles: { cache: new Collection() }, systemChannel: null };
  const conf = { logChannels: { security: SEC_CH }, antiraid: { alertChannel: null }, logs: {}, secur: { notifyOwner: true, alertOwnersDm: true, owners: [] }, ...cfg };
  const client = { channels: { fetch: async () => null }, users: { fetch: async (id) => ({ id, send: async (p) => void dms.push([id, p]) }) } };
  const notifier = new SecurNotifier({ client, config: { get: () => conf }, logging: { send: async (...a) => { logged.push(a); return true; } }, ...(now ? { now } : {}) });
  const { card } = require('../src/utils/ui');
  const embed = (n = 0) => card({ title: `Alerte ${n}`, description: `cible ${n}` });
  return { notifier, guild, posts, dms, logged, embed, conf };
}

test('notify : catégorie Sécurité en pause ET logs coupés → la carte part quand même dans le salon des logs sécurité', async () => {
  const w = notifyWorld({ cfg: { logs: { enabled: false, disabledCategories: ['security'] } } });
  const res = await w.notifier.deliver(w.guild, { embed: w.embed() }, { fallback: true, event: 'secur' });
  assert.equal(res.delivered, true);
  assert.equal(w.posts.length, 1, 'alerte filtrée comme un log');
  assert.equal(w.logged.length, 0, 'log en double dans le même salon');
  assert.equal(w.dms.length, 1, 'logs en pause : le propriétaire est prévenu');
});

test('notify : aucun salon joignable → MP ; même empreinte → 1 seul MP ; 7 alertes distinctes → 5 MP + 1 message de plafond ; aucun minuteur', async () => {
  const realSetTimeout = global.setTimeout;
  let timers = 0;
  global.setTimeout = (...a) => { timers += 1; return realSetTimeout(...a); };
  try {
    const w = notifyWorld({ security: false, cfg: { logChannels: { security: null } } });
    w.notifier.logging.send = async () => false;
    await w.notifier.deliver(w.guild, { embed: w.embed(1) }, { fallback: true });
    await w.notifier.deliver(w.guild, { embed: w.embed(1) }, { fallback: true });
    assert.equal(w.dms.length, 1, 'même empreinte : MP en double');
    assert.match(w.dms[0][1].content, /ni le salon d'alerte ni les logs sécurité/);
    for (let i = 2; i <= 8; i += 1) await w.notifier.deliver(w.guild, { embed: w.embed(i) }, { fallback: true });
    const capped = w.dms.filter(([, p]) => /Trop d'alertes/.test(p.content));
    assert.equal(w.dms.length - capped.length, 5, `${w.dms.length - capped.length} MP d'alerte en 10 min`);
    assert.equal(capped.length, 1, 'message de plafond absent ou répété');
    assert.equal(timers, 0, 'minuteur créé par la remise des alertes');
  } finally {
    global.setTimeout = realSetTimeout;
  }
  // Fenêtre écoulée : les MP reprennent.
  let t = 0;
  const w = notifyWorld({ security: false, cfg: { logChannels: { security: null } }, now: () => t });
  w.notifier.logging.send = async () => false;
  for (let i = 0; i < 7; i += 1) await w.notifier.deliver(w.guild, { embed: w.embed(i) }, { fallback: true });
  t = 10 * 60_000 + 1;
  await w.notifier.deliver(w.guild, { embed: w.embed(99) }, { fallback: true });
  assert.match(w.dms.at(-1)[1].content, /Alerte de sécurité/);
});

test('notify : raid ping dans le salon d\'alerte seulement, allowedMentions { parse: [], roles: [id] }, au plus une fois par minute', async () => {
  const ROLE = '100000000000000099';
  const w = notifyWorld({ cfg: { secur: { raidPingRoleId: ROLE, notifyOwner: true } } });
  w.guild.roles.cache.set(ROLE, { id: ROLE });
  await w.notifier.deliver(w.guild, { embed: w.embed(1) }, { ping: true });
  await w.notifier.deliver(w.guild, { embed: w.embed(2) }, { ping: true });
  assert.equal(w.posts[0].content, `<@&${ROLE}>`);
  assert.deepEqual(w.posts[0].allowedMentions, { parse: [], roles: [ROLE] });
  assert.equal(w.posts[1].content, undefined, 'deux pings en moins d\'une minute');
  assert.deepEqual(w.posts[1].allowedMentions, { parse: [] });
  // @everyone jamais pingué.
  const e = notifyWorld({ cfg: { secur: { raidPingRoleId: G } } });
  await e.notifier.deliver(e.guild, { embed: e.embed() }, { ping: true });
  assert.equal(e.posts[0].content, undefined);
});

// ---------------------------------------------------------------- journal

test('classifyCritical : table complète des changements critiques', () => {
  const cases = [
    [{ antiraid: { enabled: true } }, { antiraid: { enabled: false } }, /AntiRaid désactivé/],
    [{ antiraid: { punishExecutor: 'strip' } }, { antiraid: { punishExecutor: 'none' } }, /Aucune/],
    [{ antiraid: { banThreshold: 5 } }, { antiraid: { banThreshold: 0 } }, /Bannissements/],
    [{ antiraid: { channelDeleteThreshold: 3 } }, { antiraid: { channelDeleteThreshold: 0 } }, /Salons supprimés/],
    [{ whitelist: { users: [] } }, { whitelist: { users: [MOD] } }, new RegExp(`<@${MOD}>`)],
    [{ whitelist: { roles: [] } }, { whitelist: { roles: [R_WL] } }, new RegExp(`<@&${R_WL}>`)],
    [{ secur: { modules: { ban: { mode: 'max' } } } }, { secur: { modules: { ban: { mode: 'on' } } } }, /Secur abaissé : .*Bannissements \(max → on\)/],
    [{ secur: { modules: { ban: { mode: 'on', punish: 'ban' } } } }, { secur: { modules: { ban: { mode: 'on', punish: 'none' } } } }, /sanction ban → none/],
    [{ secur: { modules: { kick: { mode: 'on', limit: 2 } } } }, { secur: { modules: { kick: { mode: 'on', limit: 9 } } } }, /limite 2 → 9/],
    [{ secur: { modules: { kick: { mode: 'on' } } } }, { secur: { modules: Object.fromEntries(S.MODULE_KEYS.map((k) => [k, { mode: 'off' }])) } }, /préréglage off/],
    [{ secur: { owners: [] } }, { secur: { owners: [SECOWNER] } }, /Owners de sécurité modifiés/],
    [{ secur: { trustedBots: [OTHERBOT] } }, { secur: { trustedBots: [] } }, /Bots de confiance modifiés/],
    [{ secur: { verrou: true } }, { secur: { verrou: false } }, /Verrou/],
    [{ secur: { notifyOwner: true } }, { secur: { notifyOwner: false } }, /Messages privés au propriétaire coupés/],
    [{ logs: { enabled: true } }, { logs: { enabled: false } }, /Logs désactivés/],
    [{ logs: { disabledCategories: [] } }, { logs: { disabledCategories: ['security'] } }, /Catégorie de logs Sécurité/],
    [{ logs: { disabledEvents: [] } }, { logs: { disabledEvents: ['antiraid', 'messageDelete'] } }, /Événements de sécurité coupés : antiraid$/],
    [{ logChannels: { security: SEC_CH } }, { logChannels: { security: null } }, /Salon des logs Sécurité modifié/],
    [{ antiraid: { alertChannel: SEC_CH } }, { antiraid: { alertChannel: MOD } }, /Salon d'alerte AntiRaid modifié/],
  ];
  for (const [before, after, re] of cases) {
    const out = classifyCritical(before, after);
    assert.ok(out.some((l) => re.test(l)), `${JSON.stringify(after)} : ${JSON.stringify(out)}`);
  }
  // Non critiques.
  assert.deepEqual(classifyCritical({ antiraid: { enabled: false } }, { antiraid: { enabled: true } }), []);
  assert.deepEqual(classifyCritical({ whitelist: { users: [MOD] } }, { whitelist: { users: [] } }), []);
  assert.deepEqual(classifyCritical({ secur: { modules: { ban: { mode: 'on' } } } }, { secur: { modules: { ban: { mode: 'max' } } } }), []);
  assert.deepEqual(classifyCritical({ logs: { disabledEvents: [] } }, { logs: { disabledEvents: ['messageDelete'] } }), []);
});

test('journal : changement critique → alerte dans le salon d\'AVANT, MP (sauf au propriétaire auteur) ; non critique → log seul', async () => {
  const w = world();
  const before = JSON.parse(JSON.stringify(w.config.get(G)));
  const OTHER_CH = '100000000000000021';
  await w.secur.journal(w.guild, { actorId: MOD, source: '/secur', before, after: { ...before, logChannels: { ...before.logChannels, security: OTHER_CH } } });
  assert.equal(w.posts.length, 1, 'carte critique absente du salon d\'avant');
  assert.match(json(w.posts[0].embeds[0]).title, /critique/);
  assert.ok(w.dms.some(([to]) => to === OWNER));
  w.dms.length = 0;
  await w.secur.journal(w.guild, { actorId: OWNER, before, after: { ...before, antiraid: { ...before.antiraid, enabled: false }, secur: { ...before.secur } } });
  assert.equal(w.dms.length, 0, 'MP au propriétaire auteur du changement');
  const logs = w.logged.length;
  await w.secur.journal(w.guild, { actorId: MOD, before, after: { ...before, antiraid: { ...before.antiraid, joinThreshold: 20 } } });
  assert.equal(w.logged.length, logs + 1);
  assert.equal(w.logged.at(-1)[4].event, 'securConfig');
});

// ---------------------------------------------------------------- coquille /secur

test('coquille /secur : section injectée fusionnée ; nom ou action en double, plus de 25 options → erreur ; open RÉPOND en éphémère', async () => {
  const shellCmd = require('../src/commands/security/secur');
  const section = (name, extra = {}) => ({ name, type: 'subcommand', build: (s) => s.setName(name).setDescription('Section de test'), execute: async () => {}, ...extra });
  const shell = shellCmd.buildShell([...shellCmd.loadSections(), section('factice', { buttons: { factice: async () => {} }, views: { factice: () => ({ embeds: [] }) } })]);
  // Sections livrées (statut, puis celles des paquets suivants), dans l'ordre de chargement, puis l'injectée.
  const names = shell.data.toJSON().options.map((o) => o.name);
  assert.deepEqual(names, [...shellCmd.loadSections().map((s) => s.name), 'factice']);
  assert.ok(names.includes('statut'));
  assert.ok(shell.buttons.factice && shell.buttons.statut);
  assert.throws(() => shellCmd.buildShell([section('a'), section('a')]), /en double/);
  assert.throws(() => shellCmd.buildShell([section('a', { buttons: { x: () => {} } }), section('b', { buttons: { x: () => {} } })]), /action « x » en double/);
  assert.throws(() => shellCmd.buildShell([section('a', { buttons: { open: () => {} } })]), /action « open » en double/);
  assert.throws(() => shellCmd.buildShell(Array.from({ length: 26 }, (_, i) => section(`s${i}`))), /25 au plus/);
  assert.throws(() => shellCmd.buildShell([{ ...section('a'), build: (s) => s.setName('b').setDescription('x') }]), /a déclaré le nom/);
  const groupShell = shellCmd.buildShell([{ name: 'groupe', type: 'group', build: (g) => g.setName('groupe').setDescription('Groupe').addSubcommand((s) => s.setName('voir').setDescription('Voir')), execute: async () => {} }]);
  assert.equal(groupShell.data.toJSON().options[0].type, 2);

  const w = world();
  const calls = [];
  const interaction = { guild: w.guild, user: { id: OWNER }, memberPermissions: new PermissionsBitField(P.Administrator), reply: async (p) => calls.push(['reply', p]), update: async () => calls.push(['update']) };
  await shellCmd.buttons.open(interaction, w.client, ['home']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'reply', 'open doit répondre, jamais modifier la carte publique');
  assert.equal(calls[0][1].ephemeral, true);
  assert.match(json(calls[0][1].embeds[0]).title, /Secur · statut/);
  const member = { ...interaction, memberPermissions: new PermissionsBitField(0n) };
  await assert.rejects(shellCmd.buttons.open(member, w.client, ['home']), /Administrateur/);
});

// ---------------------------------------------------------------- EventHandler, scheduler

test('EventHandler : fichiers triés ; un écouteur « prepend » s\'exécute avant un écouteur normal', () => {
  const { EventHandler } = require('../src/core/EventHandler');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gadget-events-'));
  const order = [];
  global.__securOrder = order;
  fs.writeFileSync(path.join(dir, 'a-normal.js'), "module.exports = { name: 'essai', execute() { global.__securOrder.push('normal'); } };");
  fs.writeFileSync(path.join(dir, 'b-prepend.js'), "module.exports = { name: 'essai', prepend: true, execute() { global.__securOrder.push('prepend'); } };");
  const client = new EventEmitter();
  new EventHandler(client).loadAll(dir);
  client.emit('essai');
  assert.deepEqual(order, ['prepend', 'normal']);
  delete global.__securOrder;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scheduler : étape « security » → processSecurityDue de chaque service ; purge des incidents (90 j) et des accès tranchés (30 j)', async () => {
  const { SchedulerService } = require('../src/services/SchedulerService');
  const seen = [];
  const client = { guilds: { cache: new Map() }, services: { a: { processSecurityDue: async ({ isStopping }) => seen.push(typeof isStopping) }, b: { processSecurityDue: async () => { throw new Error('boum'); } }, c: { processSecurityDue: async () => seen.push('c') } } };
  await new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] } }).tick();
  assert.deepEqual(seen, ['function', 'c'], 'un service en échec bloque les suivants');

  const now = Date.now();
  const w = world({ now: () => now });
  w.incidents.create({ guildId: G, executorId: MOD, createdAt: now - 91 * DAY });
  const recent = w.incidents.create({ guildId: G, executorId: MOD, createdAt: now - DAY });
  const decided = w.grants.create({ guildId: G, kind: 'user', subjectId: MOD, grantedBy: TARGET, grantedAt: now - 31 * DAY });
  w.grants.approve(G, decided.id, OWNER, now - 30.5 * DAY);
  // Revue 7 (S17) : un accès jamais tranché reste en attente (il n'est jamais purgé, donc jamais actif).
  w.grants.create({ guildId: G, kind: 'role', subjectId: MOD, roleId: R_WL, grantedBy: TARGET, grantedAt: now - 31 * DAY });
  await w.secur.processSecurityDue();
  assert.deepEqual(w.incidents.recent(G, 10).map((r) => r.id), [recent]);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM security_grants').get().n, 1);
  assert.equal(w.secur.pendingGrants(G).length, 1);
  // Serveur quitté : données et mémoire oubliées.
  w.secur.windows.set(`${G}:${MOD}:ban`, { windowMs: 1, entries: [{ at: now, weight: 1 }] });
  assert.equal(w.secur.purgeGuild(G), 2); // l'incident récent et l'accès en attente
  assert.equal(w.secur.windows.size, 0);
});

// ---------------------------------------------------------------- AntiRaid historique

test('AntiRaid historique : fenêtre sur `at` (rejeu -6/-4/-2 min ignoré) ; prune de 742 → sanction ; module Secur actif → le chemin historique s\'efface', async () => {
  const w = world({ cfg: { antiraid: { enabled: true, channelDeleteThreshold: 3, kickThreshold: 1, destructiveWindowSeconds: 10, punishExecutor: 'strip' } } });
  w.addMember(MOD, { roleIds: [R_MOD] });
  const now = Date.now();
  for (const min of [6, 4, 2]) await w.antiraid.handleDestructive(w.guild, MOD, 'channelDelete', { at: now - min * 60_000 });
  assert.ok(w.members.get(MOD).roles.cache.has(R_MOD), 'rejeu après RESUME : modérateur sanctionné');
  await w.antiraid.handleDestructive(w.guild, MOD, 'kick', { at: now, count: 742 });
  assert.ok(!w.members.get(MOD).roles.cache.has(R_MOD), 'prune de 742 membres non sanctionné');
  assert.ok(w.posts.some((m) => /×\*\*742\*\*/.test(JSON.stringify(m.embeds))), 'alerte du prune absente (hors filtres, salon des logs sécurité)');
  const covered = world({ modules: ['channelDelete'], cfg: { antiraid: { enabled: true, channelDeleteThreshold: 1 } } });
  covered.setModule('channelDelete', { limit: 50 });
  covered.addMember(MOD, { roleIds: [R_MOD] });
  await covered.antiraid.handleDestructive(covered.guild, MOD, 'channelDelete', {});
  assert.ok(covered.members.get(MOD).roles.cache.has(R_MOD), 'chemin historique ET module Secur sur le même type');
});
