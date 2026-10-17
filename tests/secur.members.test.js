'use strict';

/**
 * SEC5 — modules Secur « membres » et « messages » : bornes et exemptions des 7 modules (ban,
 * unban, kick + prune, bot selon l'inviteur, voiceKick, everyone, messagePurge), weight d'un
 * prune, delta des entrées regroupées (26/27), antiunban face à la liste noire, everyone
 * (crosspost, webhook, punish none prime), purge sous minMessages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Collection, PermissionsBitField, PermissionFlagsBits: P, AuditLogEvent, MessageFlags, MessageFlagsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SecurityIncidentRepository } = require('../src/database/repositories/SecurityIncidentRepository');
const { SecurityGrantRepository } = require('../src/database/repositories/SecurityGrantRepository');
const { SanctionRepository } = require('../src/database/repositories/SanctionRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { AntiRaidService } = require('../src/services/AntiRaidService');
const { SecurService } = require('../src/services/SecurService');
const { SecurRegistry } = require('../src/services/secur/registry');
const S = require('../src/utils/secur');
const members = require('../src/services/secur/modules/members');
const messages = require('../src/services/secur/modules/messages');
const securVoice = require('../src/events/securVoice');
const { snowflakeAt } = require('./e2e/lib/ids');

const MODULES_DIR = path.join(__dirname, '..', 'src', 'services', 'secur', 'modules');
const G = '200000000000000001';
const BOT = '200000000000000010';
const OWNER = '200000000000000011';
const MOD = '200000000000000014';
const WLUSER = '200000000000000015';
const VICTIM = '200000000000000016';
const NEWBOT = '200000000000000017';
const SEC_CH = '200000000000000020';
const GEN_CH = '200000000000000021';
const R_MOD = '200000000000000030';
const R_MEMBER = '200000000000000031';
const DAY = 86_400_000;
const MIN = 60_000;
const tick = () => new Promise((r) => setImmediate(r));

function makeRole(id, { position = 1, perms = 0n, managed = false, editable = true } = {}) {
  return { id, position, managed, editable, permissions: new PermissionsBitField(perms), toString: () => `<@&${id}>` };
}

/** Monde de test : vraie base, vraie configuration, vrai AntiRaid, VRAI registre (modules livrés), faux serveur. */
function world({ cfg = {} } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const incidents = new SecurityIncidentRepository(db);
  const grants = new SecurityGrantRepository(db);
  const sanctions = new SanctionRepository(db);
  const rest = [];
  const posts = [];
  const logged = [];
  const marks = [];
  const roles = new Collection();
  const everyone = makeRole(G, { position: 0 });
  roles.set(G, everyone);
  roles.set(R_MOD, makeRole(R_MOD, { position: 5, perms: P.BanMembers | P.KickMembers | P.MoveMembers }));
  roles.set(R_MEMBER, makeRole(R_MEMBER, { position: 1 }));
  const channels = new Collection();
  const sent = new Map();
  const channel = (id) => ({
    id,
    guildId: G,
    send: async (p) => {
      posts.push(p);
      return { id: `m${posts.length}`, edit: async () => {} };
    },
    messages: {
      fetch: async (mid) => {
        if (!sent.has(mid)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return { id: mid, delete: async () => { rest.push({ op: 'deleteMessage', id: mid }); sent.delete(mid); } };
      },
    },
  });
  channels.set(SEC_CH, channel(SEC_CH));
  channels.set(GEN_CH, channel(GEN_CH));
  const memberMap = new Collection();
  const bans = new Set([VICTIM]);
  const webhooks = new Map();
  let audit = [];
  const guild = {
    id: G,
    name: 'Serveur',
    ownerId: OWNER,
    roles: { cache: roles, everyone },
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    members: {
      cache: memberMap,
      me: null,
      fetch: async (id) => {
        const m = memberMap.get(id);
        if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return m;
      },
    },
    bans: {
      fetch: async ({ user }) => {
        if (!bans.has(user)) throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
        return { user: { id: user } };
      },
      create: async (id) => {
        rest.push({ op: 'ban', id });
        bans.add(id);
      },
      remove: async (id) => {
        rest.push({ op: 'unban', id });
        if (!bans.delete(id)) throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
      },
    },
    fetchAuditLogs: async ({ type, limit }) => {
      rest.push({ op: 'fetchAuditLogs', type, limit });
      return { entries: new Collection(audit.filter((e) => e.action === type).slice(0, limit).map((e) => [e.id, e])) };
    },
    systemChannel: null,
  };
  const client = {
    user: { id: BOT },
    config: { ownerIds: [], securTrustBotOwners: false },
    guilds: { cache: new Collection([[G, guild]]) },
    channels: { fetch: async () => null },
    users: { fetch: async (id) => ({ id, bot: false, send: async () => {} }) },
    repositories: { sanctions, securityIncidents: incidents },
    fetchWebhook: async (id) => {
      const hook = webhooks.get(id);
      if (!hook) throw Object.assign(new Error('Unknown Webhook'), { code: 10015 });
      return { ...hook, delete: async () => { rest.push({ op: 'deleteWebhook', id }); webhooks.delete(id); } };
    },
    services: {},
  };
  const logging = { send: async (...a) => { logged.push(a); return false; } };
  const antiraid = new AntiRaidService({ client, config, logging });
  const registry = new SecurRegistry().load(MODULES_DIR);
  const secur = new SecurService({ client, config, logging, antiraid, incidents, grants, registry });
  const blacklisted = new Set();
  client.services = {
    config,
    antiraid,
    secur,
    blacklist: { has: (gid, uid) => gid === G && blacklisted.has(uid) },
    moderation: { markBotAction: (...a) => marks.push(['mark', ...a]), unmarkBotAction: (...a) => marks.push(['unmark', ...a]) },
  };
  config.update(G, { logChannels: { security: SEC_CH }, ...cfg });

  const addMember = (id, { roleIds = [], bot = false, joinedAgo = 400 * DAY, kickable = true } = {}) => {
    const member = {
      id,
      guild,
      user: { id, bot, tag: `u${id}`, username: `u${id}`, toString: () => `<@${id}>` },
      joinedTimestamp: Date.now() - joinedAgo,
      kickable,
      bannable: true,
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        async remove(target) {
          const ids = typeof target === 'string' ? [target] : [...target.keys()];
          rest.push({ op: 'stripPatch', id, roles: ids });
          for (const r of ids) member.roles.cache.delete(r);
        },
      },
      kick: async () => {
        rest.push({ op: 'kick', id });
        memberMap.delete(id);
      },
    };
    memberMap.set(id, member);
    return member;
  };
  const setModule = (key, patch = {}) => config.update(G, { secur: { modules: { [key]: { mode: 'on', ...patch } } } });
  const entry = (action, executorId, { at = Date.now(), targetId = null, extra, options } = {}) => ({ id: snowflakeAt(at), action, executorId, targetId, ...(extra ? { extra } : {}), ...(options ? { options } : {}) });
  const drain = async () => {
    for (let i = 0; i < 500; i += 1) {
      if (![...secur.queues.values()].some((q) => q.busy)) break;
      await tick();
    }
    await Promise.all([...secur.open.values()].map((s) => s.chain));
    for (let i = 0; i < 20; i += 1) await tick();
  };
  const message = (over = {}) => {
    const id = snowflakeAt(Date.now());
    sent.set(id, true);
    return { id, guild, guildId: G, channelId: GEN_CH, createdTimestamp: Date.now(), author: { id: MOD, bot: false }, mentions: { everyone: true }, system: false, flags: new MessageFlagsBitField(0), webhookId: null, ...over };
  };
  return {
    config, incidents, grants, secur, antiraid, registry, client, guild, rest, posts, logged, marks, bans, webhooks, blacklisted, sent,
    setAudit: (list) => { audit = list; },
    addMember, setModule, entry, drain, message,
  };
}

const ops = (w, op) => w.rest.filter((r) => r.op === op);

// ---------------------------------------------------------------- registre

test('registre : les 7 modules de SEC5 chargés depuis le dossier, sans échec ; voiceKick et everyone hors pipeline', () => {
  const registry = new SecurRegistry().load(MODULES_DIR);
  assert.deepEqual(registry.failures, []);
  for (const key of ['ban', 'unban', 'kick', 'bot', 'voiceKick', 'everyone', 'messagePurge']) assert.ok(registry.has(key), `${key} non chargé`);
  assert.deepEqual(registry.forType(AuditLogEvent.MemberPrune).map((m) => m.key), ['kick']);
  assert.deepEqual(registry.forType(AuditLogEvent.MemberDisconnect), [], 'les entrées 27 regroupées passent par securVoice, pas par le pipeline');
  assert.deepEqual(registry.get('everyone').auditTypes, []);
  for (const key of ['kick', 'voiceKick', 'messagePurge']) assert.equal(S.SECUR_MODULES[key].undoable, false, `${key} : sanction seule`);
});

// ---------------------------------------------------------------- ban

test('ban : limite héritée de l\'AntiRaid (null → banThreshold), anciens membres comptés, arrivants récents exemptés (cache, AntiRaid, départs)', async () => {
  const w = world({ cfg: { antiraid: { banThreshold: 3 } } });
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setModule('ban', { limit: null });
  assert.equal(S.effectiveLimit(w.config.get(G), 'ban'), 3);
  const recent = ['200000000000000101', '200000000000000102', '200000000000000103'];
  // 1) arrivant encore en cache ; 2) départ mémorisé par securVoice (guildMemberRemove) ; 3) arrivée vue par l'AntiRaid.
  w.addMember(recent[0], { joinedAgo: 2 * MIN });
  assert.ok(members.rememberDeparture({ id: recent[1], guild: w.guild, joinedTimestamp: Date.now() - 3 * MIN }));
  assert.equal(members.rememberDeparture({ id: '200000000000000109', guild: w.guild, joinedTimestamp: Date.now() - 30 * MIN }), false, 'ancien membre : rien à mémoriser');
  w.config.update(G, { antiraid: { enabled: true, joinThreshold: 1000 } });
  await w.antiraid.handleJoin({ id: recent[2], guild: w.guild, user: { id: recent[2], bot: false, createdTimestamp: Date.now() - 400 * DAY }, roles: { cache: new Collection() } }).catch(() => {});
  w.config.update(G, { antiraid: { enabled: false } });
  for (const id of recent) await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MemberBanAdd, MOD, { targetId: id }), w.guild);
  await w.drain();
  assert.equal(w.incidents.recent(G, 5).length, 0, 'bans de raiders récents comptés');
  assert.equal(w.secur.windowSum(G, MOD, 'ban'), 0);

  for (const id of ['200000000000000201', '200000000000000202', '200000000000000203']) await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MemberBanAdd, MOD, { targetId: id }), w.guild);
  await w.drain();
  const [incident] = w.incidents.recent(G, 5);
  assert.ok(incident, '3 bans d\'anciens membres : aucun incident');
  assert.equal(incident.punishment, 'derank');
  assert.deepEqual(incident.modules, ['ban']);
  assert.equal(ops(w, 'unban').length, 0, 'annulation du ban désactivée par défaut');
});

test('ban : annulation activée → victimes débannies (markBotAction unban), sauf les blacklistés', async () => {
  const w = world();
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setModule('ban', { limit: 2, undo: true });
  const [a, b] = ['200000000000000301', '200000000000000302'];
  w.bans.add(a);
  w.bans.add(b);
  w.blacklisted.add(b);
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MemberBanAdd, MOD, { targetId: a }), w.guild);
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MemberBanAdd, MOD, { targetId: b }), w.guild);
  await w.drain();
  assert.deepEqual(ops(w, 'unban').map((r) => r.id), [a], 'seul le non-blacklisté est débanni');
  assert.ok(w.marks.some(([k, type, , id]) => k === 'mark' && type === 'unban' && id === a));
  assert.ok(w.bans.has(b));
});

// ---------------------------------------------------------------- unban

test('unban : débannissement non autorisé → rebanni (markBotAction ban) ; un blacklisté n\'est pas rebanni par Secur (la liste noire s\'en charge)', async () => {
  const w = world();
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setModule('unban');
  const target = '200000000000000401';
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MemberBanRemove, MOD, { targetId: target }), w.guild);
  await w.drain();
  assert.deepEqual(ops(w, 'ban').map((r) => r.id), [target]);
  assert.ok(w.marks.some(([k, type, , id]) => k === 'mark' && type === 'ban' && id === target), 'rebannissement non marqué (log en double)');
  assert.equal(w.incidents.recent(G, 5)[0].undone, 1);

  const w2 = world();
  w2.addMember(MOD, { roleIds: [R_MOD] });
  w2.setModule('unban');
  w2.blacklisted.add(target);
  await w2.secur.handleAuditEntry(w2.entry(AuditLogEvent.MemberBanRemove, MOD, { targetId: target }), w2.guild);
  await w2.drain();
  assert.equal(ops(w2, 'ban').length, 0, 'blacklisté rebanni deux fois (Secur + liste noire)');

  // Exempté (whitelist, mode on) : rien.
  const w3 = world({ cfg: { whitelist: { users: [MOD], roles: [] } } });
  w3.addMember(MOD, { roleIds: [R_MOD] });
  w3.setModule('unban');
  await w3.secur.handleAuditEntry(w3.entry(AuditLogEvent.MemberBanRemove, MOD, { targetId: target }), w3.guild);
  await w3.drain();
  assert.equal(ops(w3, 'ban').length, 0);
  assert.equal(w3.incidents.recent(G, 5).length, 0);
});

// ---------------------------------------------------------------- kick + prune

test('kick : weight 1, arrivant récent exempté ; prune : weight = members_removed (742 → limite dépassée d\'un coup), prune de 0 ignoré', async () => {
  const mod = registryModule('kick');
  const ctx = { client: { services: {} }, at: Date.now() };
  const g = { id: G, members: { cache: new Collection() } };
  assert.deepEqual(mod.classify({ action: AuditLogEvent.MemberKick, targetId: VICTIM }, g, ctx), { weight: 1, record: { userId: VICTIM } });
  assert.equal(mod.classify({ action: AuditLogEvent.MemberPrune, extra: { removed: 0, days: 7 } }, g, ctx), null);
  assert.equal(mod.classify({ action: AuditLogEvent.MemberPrune, extra: { removed: 742, days: 7 } }, g, ctx).weight, 742);
  assert.equal(members.pruneCount({ options: { members_removed: '12' } }), 12);
  assert.equal(members.pruneCount({ extra: { removed: Number.NaN } }), 0);
  g.members.cache.set(VICTIM, { joinedTimestamp: Date.now() - MIN });
  assert.equal(mod.classify({ action: AuditLogEvent.MemberKick, targetId: VICTIM }, g, ctx), null, 'raider récent compté');

  const w = world({ cfg: { antiraid: { kickThreshold: 3 } } });
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setModule('kick', { limit: null });
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MemberPrune, MOD, { extra: { removed: 742, days: 7 } }), w.guild);
  await w.drain();
  const [incident] = w.incidents.recent(G, 5);
  assert.ok(incident, 'prune de 742 membres sans incident');
  assert.equal(incident.actions, 742);
  assert.equal(incident.punishment, 'derank');
  assert.equal(ops(w, 'kick').length, 0, 'un kick ne s\'annule pas : sanction seule');
});

// ---------------------------------------------------------------- bot

test('bot : l\'INVITEUR est jugé — modérateur → bot expulsé et inviteur dérangé ; whitelisté (on) → conservé ; max → owner exigé ; bot de confiance ou whitelisté (on) autorisé', async () => {
  const w = world();
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.addMember(NEWBOT, { bot: true, joinedAgo: MIN });
  w.setModule('bot');
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.BotAdd, MOD, { targetId: NEWBOT }), w.guild);
  await w.drain();
  assert.deepEqual(ops(w, 'kick').map((r) => r.id), [NEWBOT], 'bot non expulsé');
  assert.ok(w.secur.wasBotRemoved(G, NEWBOT));
  const [incident] = w.incidents.recent(G, 5);
  assert.equal(incident.executor_id, MOD, 'l\'inviteur doit être l\'auteur de l\'incident');
  assert.equal(incident.punishment, 'derank');

  // Inviteur whitelisté (mode on) : le bot reste.
  const w2 = world({ cfg: { whitelist: { users: [WLUSER], roles: [] } } });
  w2.addMember(WLUSER, { roleIds: [R_MOD] });
  w2.addMember(NEWBOT, { bot: true, joinedAgo: MIN });
  w2.setModule('bot');
  await w2.secur.handleAuditEntry(w2.entry(AuditLogEvent.BotAdd, WLUSER, { targetId: NEWBOT }), w2.guild);
  await w2.drain();
  assert.equal(ops(w2, 'kick').length, 0);
  assert.equal(w2.incidents.recent(G, 5).length, 0);
  // Même inviteur en max : seul un owner peut ajouter un bot.
  w2.setModule('bot', { mode: 'max' });
  await w2.secur.handleAuditEntry(w2.entry(AuditLogEvent.BotAdd, WLUSER, { targetId: NEWBOT }), w2.guild);
  await w2.drain();
  assert.deepEqual(ops(w2, 'kick').map((r) => r.id), [NEWBOT], 'max : whitelisté accepté comme inviteur');

  // Bot lui-même autorisé : whitelist.users (on seulement) ou bots de confiance (on et max).
  const mod = registryModule('bot');
  const cfgOf = (secur, whitelist, mode) => ({ cfg: { secur, whitelist }, moduleCfg: { mode } });
  assert.equal(mod.classify({ targetId: NEWBOT }, {}, cfgOf({}, { users: [NEWBOT] }, 'on')), null);
  assert.ok(mod.classify({ targetId: NEWBOT }, {}, cfgOf({}, { users: [NEWBOT] }, 'max')), 'max : whitelist.users ne suffit pas');
  assert.equal(mod.classify({ targetId: NEWBOT }, {}, cfgOf({ trustedBots: [NEWBOT] }, {}, 'max')), null);

  // Déjà expulsé par l'AntiRaid : l'annulation ne refait rien.
  const w3 = world();
  w3.addMember(MOD, { roleIds: [R_MOD] });
  w3.addMember(NEWBOT, { bot: true, joinedAgo: MIN });
  w3.setModule('bot');
  w3.secur.noteBotRemoved(w3.guild, NEWBOT);
  await w3.secur.handleAuditEntry(w3.entry(AuditLogEvent.BotAdd, MOD, { targetId: NEWBOT }), w3.guild);
  await w3.drain();
  assert.equal(ops(w3, 'kick').length, 0, 'bot expulsé deux fois');
  assert.equal(w3.incidents.recent(G, 5)[0].undone, 1, '« déjà expulsé » compte comme annulé');
});

// ---------------------------------------------------------------- voiceKick

test('voiceKick : delta des entrées regroupées (26/27) — nouvelle entrée fraîche entière, puis différences ; entrée ancienne vue la 1re fois = référence', () => {
  securVoice.forgetGuild(G);
  const now = Date.now();
  const fresh = { id: snowflakeAt(now - 2_000), extra: { count: 6 } };
  assert.equal(securVoice.countDelta(G, fresh, now), 6);
  assert.equal(securVoice.countDelta(G, { ...fresh, extra: { count: 8 } }, now), 2);
  assert.equal(securVoice.countDelta(G, { ...fresh, extra: { count: 8 } }, now), 0);
  const old = { id: snowflakeAt(now - 5 * MIN), extra: { count: 30 } };
  assert.equal(securVoice.countDelta(G, old, now), 0, 'actions anciennes (bot redémarré) attribuées');
  assert.equal(securVoice.countDelta(G, { ...old, extra: { count: 31 } }, now), 1);
  securVoice.forgetGuild(G);
  assert.equal(securVoice.seenSize(G), 0);
});

test('voiceKick : lecture du journal (type 27, limit 10), entrée 27 avec count 6 → sanction (limite 5) ; bot et module coupé ignorés', async () => {
  securVoice.forgetGuild(G);
  const w = world();
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setAudit([{ id: snowflakeAt(Date.now() - 1_000), action: AuditLogEvent.MemberDisconnect, executorId: MOD, extra: { count: 6 } }]);
  assert.equal(await securVoice.readVoiceAudit(w.client, w.guild), 0, 'module coupé : aucune lecture');
  assert.equal(ops(w, 'fetchAuditLogs').length, 0);
  w.setModule('voiceKick');
  assert.equal(S.effectiveLimit(w.config.get(G), 'voiceKick'), 5);
  assert.equal(await securVoice.readVoiceAudit(w.client, w.guild), 1);
  assert.deepEqual(ops(w, 'fetchAuditLogs').map((r) => [r.type, r.limit]), [[27, 10]], 'déconnexions seulement (revue 7, S8)');
  await w.drain();
  const [incident] = w.incidents.recent(G, 5);
  assert.ok(incident, 'déconnexion de 6 membres sans sanction');
  assert.equal(incident.actions, 6);
  assert.deepEqual(incident.modules, ['voiceKick']);
  // Relecture sans changement : rien de neuf. Entrée du bot : jamais comptée.
  w.setAudit([{ id: snowflakeAt(Date.now() - 1_000), action: AuditLogEvent.MemberMove, executorId: BOT, extra: { count: 9, channel: { id: GEN_CH } } }]);
  assert.equal(await securVoice.readVoiceAudit(w.client, w.guild), 0);
  securVoice.forgetGuild(G);
});

// ---------------------------------------------------------------- everyone

test('everyone : crosspost, message système, ce bot ou sans @everyone → ignorés ; webhook jugé sous son identifiant', () => {
  const base = { guild: { id: G }, id: '1', channelId: GEN_CH, author: { id: MOD }, mentions: { everyone: true }, flags: new MessageFlagsBitField(0) };
  assert.deepEqual(messages.everyoneSignal(base, BOT).executorId, MOD);
  assert.equal(messages.everyoneSignal({ ...base, mentions: { everyone: false } }, BOT), null);
  assert.equal(messages.everyoneSignal({ ...base, system: true }, BOT), null);
  assert.equal(messages.everyoneSignal({ ...base, author: { id: BOT } }, BOT), null);
  assert.equal(messages.everyoneSignal({ ...base, flags: new MessageFlagsBitField(MessageFlags.IsCrosspost), webhookId: '200000000000000555' }, BOT), null, 'crosspost d\'un salon suivi');
  const hook = messages.everyoneSignal({ ...base, author: { id: '200000000000000556' }, webhookId: '200000000000000556' }, BOT);
  assert.equal(hook.executorId, '200000000000000556');
  assert.equal(hook.record.webhookId, '200000000000000556');
  assert.equal(messages.everyoneSignal({ ...base, webhookId: '200000000000000557', interactionMetadata: { id: 'x' } }, BOT).record.webhookId, null, 'réponse d\'interaction : jugée sous son bot');
});

test('everyone : punish « none » (défaut) → message supprimé SANS sanction ; exempté → rien ; max → webhook supprimé', async () => {
  const w = world();
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setModule('everyone');
  assert.equal(S.modulePunish(w.config.get(G), 'everyone'), 'none');
  const msg = w.message();
  await messages.handleMessage(w.client, msg);
  await w.drain();
  assert.deepEqual(ops(w, 'deleteMessage').map((r) => r.id), [msg.id]);
  assert.equal(ops(w, 'stripPatch').length + ops(w, 'kick').length, 0, 'punish none : aucune sanction');
  assert.equal(w.incidents.recent(G, 5)[0].punishment, 'none');

  // Exempté (whitelist en on) : rien n'est supprimé.
  w.config.update(G, { whitelist: { users: [MOD], roles: [] } });
  const kept = w.message();
  await messages.handleMessage(w.client, kept);
  await w.drain();
  assert.equal(ops(w, 'deleteMessage').length, 1);
  // Crosspost : rien.
  w.config.update(G, { whitelist: { users: [], roles: [] } });
  const cross = w.message({ flags: new MessageFlagsBitField(MessageFlags.IsCrosspost), author: { id: '200000000000000558', bot: true }, webhookId: '200000000000000558' });
  await messages.handleMessage(w.client, cross);
  await w.drain();
  assert.ok(w.sent.has(cross.id), 'crosspost supprimé');

  // Webhook non suivi : message supprimé, webhook supprimé seulement en max.
  const HOOK = '200000000000000559';
  w.webhooks.set(HOOK, { id: HOOK, type: 1 });
  w.setModule('everyone', { mode: 'on' });
  await messages.handleMessage(w.client, w.message({ author: { id: HOOK, bot: true }, webhookId: HOOK }));
  await w.drain();
  assert.equal(ops(w, 'deleteWebhook').length, 0, 'webhook supprimé en on');
  w.setModule('everyone', { mode: 'max' });
  await messages.handleMessage(w.client, w.message({ id: snowflakeAt(Date.now() + 5), author: { id: HOOK, bot: true }, webhookId: HOOK }));
  await w.drain();
  assert.deepEqual(ops(w, 'deleteWebhook').map((r) => r.id), [HOOK]);
});

// ---------------------------------------------------------------- messagePurge

test('messagePurge : sous minMessages (20) ignorée ; 50 messages ×2 en 10 s → sanction ; minMessages réglable', async () => {
  const mod = registryModule('messagePurge');
  const ctx = (minMessages) => ({ moduleCfg: { minMessages } });
  assert.equal(mod.classify({ extra: { count: 19 }, targetId: GEN_CH }, {}, ctx(20)), null);
  assert.deepEqual(mod.classify({ extra: { count: 20 }, targetId: GEN_CH }, {}, ctx(20)), { weight: 1, record: { channelId: GEN_CH, count: 20 } });
  assert.equal(mod.classify({ extra: { count: 25 } }, {}, ctx(30)), null);
  assert.ok(mod.classify({ extra: { count: 25 } }, {}, ctx(1)), 'minMessages borné à 2 au moins');

  const w = world();
  w.addMember(MOD, { roleIds: [R_MOD] });
  w.setModule('messagePurge');
  assert.equal(S.effectiveLimit(w.config.get(G), 'messagePurge'), 2);
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MessageBulkDelete, MOD, { targetId: GEN_CH, extra: { count: 5 } }), w.guild);
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MessageBulkDelete, MOD, { targetId: GEN_CH, extra: { count: 50 } }), w.guild);
  await w.drain();
  assert.equal(w.incidents.recent(G, 5).length, 0, 'une seule purge massive : sous la limite');
  await w.secur.handleAuditEntry(w.entry(AuditLogEvent.MessageBulkDelete, MOD, { targetId: GEN_CH, extra: { count: 50 } }), w.guild);
  await w.drain();
  const [incident] = w.incidents.recent(G, 5);
  assert.ok(incident);
  assert.equal(incident.actions, 2);
  assert.equal(incident.punishment, 'derank');
});

// ---------------------------------------------------------------- pré-contrôle

test('pré-contrôle (modules SEC5) : refus seulement à la limite, count transmis, jamais pour un exempté', () => {
  const w = world({ cfg: { whitelist: { users: [WLUSER], roles: [] } } });
  const mod = w.addMember(MOD, { roleIds: [R_MOD] });
  const wl = w.addMember(WLUSER, { roleIds: [R_MOD] });
  w.setModule('kick', { limit: 3 });
  const ctx = (member) => ({ guild: w.guild, user: member.user, member });
  assert.equal(w.secur.assertAllowed(ctx(mod), 'kick', { count: 2 }), true, 'sous la limite');
  assert.throws(() => w.secur.assertAllowed(ctx(mod), 'kick', { count: 3 }), /Action bloquée par la sécurité \(Expulsions\) : 3 action\(s\)/);
  assert.equal(w.secur.assertAllowed(ctx(wl), 'kick', { count: 50 }), true, 'whitelisté refusé en on');
  w.setModule('kick', { mode: 'max', limit: 3 });
  assert.throws(() => w.secur.assertAllowed(ctx(wl), 'kick', { count: 50 }), /Action bloquée/, 'max : whitelist non exemptée');
  assert.equal(w.secur.assertAllowed({ guild: w.guild, user: { id: OWNER } }, 'kick', { count: 50 }), true, 'propriétaire refusé');
});

/** Module chargé par le vrai registre. */
function registryModule(key) {
  return new SecurRegistry().load(MODULES_DIR).get(key);
}
