'use strict';

/**
 * Review 2 — AutoMod et logs : non-régression des correctifs (quarantaine persistée,
 * levée partielle, faux positifs anti-arnaques, « Faux positif » ciblé, interrupteurs /logs…).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, Collection, ChannelType } = require('discord.js');
const automod = require('../src/commands/automod/automod');
const logs = require('../src/commands/configuration/logs');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { AutomodEventRepository } = require('../src/database/repositories/AutomodEventRepository');
const { AutomodQuarantineRepository } = require('../src/database/repositories/AutomodQuarantineRepository');
const { AutoModService } = require('../src/services/AutoModService');
const { LoggingService } = require('../src/services/LoggingService');
const { phishingScore, imitatesBrand, maskedLinks } = require('../src/utils/automod/phishing');
const { PRESETS } = require('../src/utils/automod/presets');
const native = require('../src/services/NativeAutoMod');
const logExtras = require('../src/events/logExtras');
const voiceStateUpdate = require('../src/events/voiceStateUpdate');

const G = '100000000000000001';
const U = '200000000000000001';
const MOD = '200000000000000009';
const BOT = '999999999999999999';
const C1 = '300000000000000001';
const C2 = '300000000000000002';
const C3 = '300000000000000003';
const C4 = '300000000000000004';
const R1 = '400000000000000001';
const R2 = '400000000000000002';
const R3 = '400000000000000003';
const LOG = '500000000000000001';

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const ids = (rows) => (rows ?? []).flatMap((r) => json(r).components.map((c) => c.custom_id).filter(Boolean));
const perms = (...flags) => new PermissionsBitField(flags.length ? flags.map((f) => PermissionsBitField.Flags[f]) : 0n);

let seq = 0;
const nextId = () => String(610000000000000000n + BigInt(++seq));

// ---------------------------------------------------------------- 1. migration 12

test('migration 12 : table automod_quarantines, colonne timeout_until et index', () => {
  const { db } = memoryDb();
  const cols = db.prepare('PRAGMA table_info(automod_quarantines)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'guild_id', 'user_id', 'roles', 'timeout_until', 'event_id', 'created_at', 'lifted_at', 'lifted_by']);
  assert.ok(db.prepare('PRAGMA table_info(automod_events)').all().some((c) => c.name === 'timeout_until'));
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  for (const name of ['idx_automod_quarantines_user', 'idx_automod_events_created', 'idx_role_menus_message']) assert.ok(indexes.includes(name), name);
  // La purge horaire utilise l'index (plus de parcours complet).
  const plan = db.prepare('EXPLAIN QUERY PLAN DELETE FROM automod_events WHERE created_at < ?').all(0).map((r) => r.detail).join(' ');
  assert.match(plan, /idx_automod_events_created/);
});

test('dépôt des quarantaines : rôles JSON, isolement par serveur, levée unique', () => {
  const { db } = memoryDb();
  const repo = new AutomodQuarantineRepository(db);
  const id = repo.add({ guildId: G, userId: U, roles: [R1, R2], timeoutUntil: 123, eventId: 7 });
  const row = repo.get(G, id);
  assert.deepEqual(row.roles, [R1, R2]);
  assert.equal(row.timeout_until, 123);
  assert.equal(row.event_id, 7);
  assert.equal(repo.get('100000000000000002', id), null, 'jamais la quarantaine d\'un autre serveur');
  repo.setRoles(G, id, []);
  assert.deepEqual(repo.get(G, id).roles, []);
  assert.equal(repo.lift(G, id, MOD), true);
  assert.equal(repo.lift(G, id, MOD), false, 'déjà levée');
  assert.equal(repo.get(G, id).lifted_by, MOD);
});

// ---------------------------------------------------------------- quarantaine : service

/** Faux serveur pour la quarantaine, avec le journal ET le dépôt des quarantaines. */
function quarantineWorld({ removeRoles = true, removeFails = false, logSent = true, withRepo = true } = {}) {
  const { db } = memoryDb();
  const events = new AutomodEventRepository(db);
  const quarantines = withRepo ? new AutomodQuarantineRepository(db) : null;
  const deleted = [];
  const channel = (id) => ({
    id,
    toString: () => `<#${id}>`,
    messages: { delete: async (mid) => deleted.push([id, mid]) },
    bulkDelete: async (list) => {
      for (const mid of list) deleted.push([id, mid]);
      return new Map(list.map((m) => [m, {}]));
    },
  });
  const channels = new Collection([C1, C2, C3, C4].map((id) => [id, channel(id)]));
  const seenAtRemove = [];
  const member = {
    id: U,
    communicationDisabledUntilTimestamp: 0,
    permissions: { has: () => false },
    roles: {
      cache: new Collection([[G, { id: G }], [R1, { id: R1, editable: true }], [R2, { id: R2, editable: true }]]),
      remove: async (list) => {
        // Trace en base AU MOMENT du retrait (doit déjà exister).
        seenAtRemove.push(quarantines ? db.prepare('SELECT roles FROM automod_quarantines').all() : null);
        if (removeFails) throw new Error('Missing Permissions');
        return list;
      },
    },
  };
  const logsSent = [];
  const service = new AutoModService({
    config: { get: () => ({ moderation: {}, automod: { enabled: true, notify: 'none', filters: { antiHacked: { enabled: true, channels: 3, windowSeconds: 60, minLength: 20, scamScore: 5, removeRoles, purgeMinutes: 10 } } } }) },
    logging: { suppressMessage: () => {}, send: async (...a) => { logsSent.push(a); return logSent; } },
    moderation: { timeout: async () => ({ id: 7 }) },
    events,
    quarantines,
  });
  const guild = { id: G, members: { me: { id: BOT } }, channels: { cache: channels } };
  const make = (content, channelId) => ({
    id: nextId(),
    guild,
    author: { id: U, bot: false, createdTimestamp: 0, toString: () => `<@${U}>`, displayAvatarURL: () => null },
    member,
    channel: channels.get(channelId),
    content,
    mentions: { everyone: false },
    delete: async function del() { deleted.push([channelId, this.id]); },
  });
  return { db, service, make, events, quarantines, logsSent, seenAtRemove, deleted };
}

const SCAM = '@everyone free nitro https://discord-gift.com/claim';

test('quarantaine : rôles enregistrés en base AVANT le retrait, id dans le bouton « Lever »', async () => {
  const w = quarantineWorld({ logSent: false });
  const before = Date.now();
  await w.service.handleMessage(w.make(SCAM, C1));
  assert.deepEqual(w.seenAtRemove, [[{ roles: JSON.stringify([R1, R2]) }]], 'la ligne existe déjà quand les rôles sont retirés');
  const [, , , components] = w.logsSent[0];
  const lift = ids(components).find((x) => x.startsWith('cmd:automod:qlift:'));
  const [, , , userId, qid] = lift.split(':');
  assert.equal(userId, U);
  const row = w.quarantines.get(G, Number(qid));
  assert.deepEqual(row.roles, [R1, R2]);
  assert.ok(row.timeout_until >= before + 86_400_000 - 1000, 'fin du timeout posé enregistrée');
  assert.equal(w.events.get(G, row.event_id).action, 'quarantine', 'infraction liée');
});

test('quarantaine : retrait refusé par Discord → aucun rôle à rendre en base', async () => {
  const w = quarantineWorld({ removeFails: true });
  await w.service.handleMessage(w.make(SCAM, C1));
  const qid = ids(w.logsSent[0][3]).find((x) => x.startsWith('cmd:automod:qlift:')).split(':')[4];
  assert.deepEqual(w.quarantines.get(G, Number(qid)).roles, []);
  assert.match(w.logsSent[0][2].toJSON().fields.find((f) => f.name.includes('Rôles retirés')).value, /Aucun/);
});

test('quarantaine : enregistrement impossible → rôles conservés (jamais retirés sans trace)', async () => {
  const w = quarantineWorld();
  w.quarantines.add = () => { throw new Error('SQLITE_BUSY'); };
  await w.service.handleMessage(w.make(SCAM, C1));
  assert.equal(w.seenAtRemove.length, 0, 'aucun retrait');
  assert.match(w.logsSent[0][2].toJSON().fields.find((f) => f.name.includes('Rôles retirés')).value, /conservés/);
  assert.deepEqual(ids(w.logsSent[0][3])[0], `cmd:automod:qlift:${U}`, 'bouton sans id (repli sur le log)');
});

test('quarantaine : le salon du message déclencheur compte dans le nombre de salons', async () => {
  const w = quarantineWorld({ removeRoles: false });
  await w.service.handleMessage(w.make(SCAM, C1));
  const field = w.logsSent[0][2].toJSON().fields.find((f) => f.name.includes('Messages supprimés'));
  assert.match(field.value, /\*\*1\*\* · 1 salon\(s\)/);
});

test('compte piraté : après détection, la copie suivante ne relance pas la quarantaine', () => {
  const s = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const filters = { antiHacked: { enabled: true, channels: 3, windowSeconds: 60, minLength: 20 } };
  const text = 'Salut tout le monde, regardez ce super site incroyable';
  const msg = (channelId) => ({ id: nextId(), guild: { id: G }, author: { id: U }, channel: { id: channelId }, content: text });
  assert.equal(s.inspect(msg(C1), filters), null);
  assert.equal(s.inspect(msg(C2), filters), null);
  assert.equal(s.inspect(msg(C3), filters)?.filter, 'antiHacked');
  assert.equal(s.inspect(msg(C4), filters), null, 'empreinte oubliée après détection');
});

// ---------------------------------------------------------------- quarantaine : boutons

function dashboardWorld({ untilOffset = 86_400_000 } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const events = new AutomodEventRepository(db);
  const quarantines = new AutomodQuarantineRepository(db);
  const roles = new Collection([
    [R1, { id: R1, position: 1, managed: false, editable: true }],
    [R2, { id: R2, position: 50, managed: false, editable: true }],
    [R3, { id: R3, position: 2, managed: false, editable: false }],
  ]);
  const guild = {
    id: G,
    name: 'Serveur test',
    ownerId: '200000000000000000',
    members: { me: { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache: new Collection([[C1, { id: C1, type: ChannelType.GuildText }]]) },
    roles: { cache: roles },
  };
  const calls = { removeTimeout: [], ban: [], rolesAdded: [] };
  const target = {
    id: U,
    isCommunicationDisabled: () => true,
    communicationDisabledUntilTimestamp: Date.now() + untilOffset,
    roles: { cache: new Collection(), add: async (list) => { calls.rolesAdded.push(...list); for (const id of list) target.roles.cache.set(id, { id }); } },
  };
  guild.members.fetch = async (id) => (id === U ? target : null);
  const client = {
    user: { id: BOT },
    services: {
      config,
      automod: new AutoModService({ config, logging: {}, moderation: {}, events, quarantines }),
      moderation: {
        removeTimeout: async (...a) => { calls.removeTimeout.push(a); return { ok: true }; },
        ban: async (...a) => { calls.ban.push(a); return { id: 5 }; },
      },
    },
    repositories: { automodEvents: events, automodQuarantines: quarantines },
    guilds: { cache: new Map([[G, guild]]) },
    users: { fetch: async (id) => (id === U ? { id: U, username: 'bob', toString: () => `<@${U}>` } : null) },
  };
  return { client, guild, config, events, quarantines, calls, target };
}

function fakeInteraction(w, { customId, message, permissions, topPosition = 10 } = {}) {
  const out = { updates: [], edits: [], replies: [], followUps: [] };
  const i = {
    customId,
    guildId: G,
    guild: w.guild,
    user: { id: MOD, username: 'modo', tag: 'modo' },
    member: { id: MOD, roles: { highest: { position: topPosition } } },
    memberPermissions: permissions,
    message,
    channel: { messages: { fetch: async () => null } },
    deferUpdate: async () => {},
    update: async (p) => out.updates.push(p),
    editReply: async (p) => out.edits.push(p),
    reply: async (p) => out.replies.push(p),
    followUp: async (p) => out.followUps.push(p),
  };
  return { i, out };
}

/** Log de quarantaine dont le champ des rôles est absent (log non envoyé, tronqué…). */
const liftMessage = (customId) => ({
  id: LOG,
  embeds: [{ footer: { text: `Gadget • ID : ${U}` }, fields: [] }],
  components: [{ type: 1, components: [{ type: 2, custom_id: customId, style: 3, label: 'Lever' }] }],
});

function seedQuarantine(w, { roles = [R1], untilOffset = 86_400_000 } = {}) {
  const eventId = w.events.add({ guildId: G, userId: U, filter: 'antiHacked', action: 'quarantine' });
  const qid = w.quarantines.add({ guildId: G, userId: U, roles, timeoutUntil: Date.now() + untilOffset, eventId });
  return { eventId, qid, customId: `cmd:automod:qlift:${U}:${qid}` };
}

test('lever la quarantaine : rôles relus en base (sans champ dans le log), infraction retirée, bouton figé', async () => {
  const w = dashboardWorld();
  const { qid, customId } = seedQuarantine(w);
  assert.equal(w.events.countRecent(G, U, 0), 1);
  const { i, out } = fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers', 'ManageRoles') });
  await automod.buttons.qlift(i, w.client, [U, String(qid)]);
  assert.deepEqual(w.calls.rolesAdded, [R1]);
  assert.equal(w.calls.removeTimeout.length, 1);
  assert.equal(w.events.countRecent(G, U, 0), 0, 'retirée du compteur d\'escalade');
  assert.ok(out.edits[0].components[0].components[0].disabled, 'tout est rendu : bouton figé');
  assert.equal(w.quarantines.get(G, qid).lifted_by, MOD);
  const embed = json(out.followUps[0].embeds[0]);
  assert.match(embed.title, /Quarantaine levée$/);
  assert.match(embed.description, /compteur de récidive/);
  // Deuxième clic : déjà levée.
  await assert.rejects(automod.buttons.qlift(fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers', 'ManageRoles') }).i, w.client, [U, String(qid)]), { name: 'UserError' });
});

test('lever la quarantaine : rôles non rendus listés, bouton laissé actif, puis second clic complet', async () => {
  const w = dashboardWorld();
  const { qid, customId } = seedQuarantine(w, { roles: [R1, R2, R3] });
  const first = fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers', 'ManageRoles') });
  await automod.buttons.qlift(first.i, w.client, [U, String(qid)]);
  assert.deepEqual(w.calls.rolesAdded, [R1]);
  assert.equal(first.out.edits.length, 0, 'bouton non figé');
  const desc = json(first.out.followUps[0].embeds[0]).description;
  assert.match(desc, new RegExp(`au-dessus de votre rôle le plus haut\\) : <@&${R2}>`));
  assert.match(desc, new RegExp(`au-dessus de mon rôle.*<@&${R3}>`));
  assert.match(desc, /reste actif/);
  assert.equal(w.quarantines.get(G, qid).lifted_at, null, 'quarantaine toujours ouverte');

  // Le problème est corrigé (rôle du bot remonté, modérateur plus haut) : second clic.
  w.guild.roles.cache.get(R3).editable = true;
  const second = fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers', 'ManageRoles'), topPosition: 99 });
  await automod.buttons.qlift(second.i, w.client, [U, String(qid)]);
  assert.deepEqual(w.calls.rolesAdded, [R1, R2, R3], 'R1 n\'est pas rajouté une seconde fois');
  assert.ok(second.out.edits[0].components[0].components[0].disabled);
  assert.ok(w.quarantines.get(G, qid).lifted_at);
});

test('lever la quarantaine : sans « Gérer les rôles », les rôles sont listés et le bouton reste actif', async () => {
  const w = dashboardWorld();
  const { qid, customId } = seedQuarantine(w, { roles: [R1, R2] });
  const { i, out } = fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers') });
  await automod.buttons.qlift(i, w.client, [U, String(qid)]);
  assert.equal(w.calls.rolesAdded.length, 0);
  assert.equal(out.edits.length, 0);
  assert.match(json(out.followUps[0].embeds[0]).description, new RegExp(`Gérer les rôles.*<@&${R1}> <@&${R2}>`));
});

test('lever la quarantaine : un autre timeout posé entre-temps n\'est pas levé', async () => {
  const w = dashboardWorld({ untilOffset: 7 * 86_400_000 }); // modérateur : 7 jours
  const { qid, customId } = seedQuarantine(w, { roles: [] });
  const { i, out } = fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers', 'ManageRoles') });
  await automod.buttons.qlift(i, w.client, [U, String(qid)]);
  assert.equal(w.calls.removeTimeout.length, 0);
  assert.match(json(out.followUps[0].embeds[0]).description, /autre timeout est en cours/);
  assert.ok(out.edits[0], 'rien d\'autre à faire : quarantaine levée');
});

test('lever la quarantaine : bouton d\'un autre membre ou identifiant invalide refusés', async () => {
  const w = dashboardWorld();
  const { qid, customId } = seedQuarantine(w);
  const other = '200000000000000002';
  await assert.rejects(automod.buttons.qlift(fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers') }).i, w.client, [other, String(qid)]), { name: 'UserError' });
  await assert.rejects(automod.buttons.qlift(fakeInteraction(w, { customId, message: liftMessage(customId), permissions: perms('ModerateMembers') }).i, w.client, [U, 'x1']), { name: 'UserError' });
});

// ---------------------------------------------------------------- 4. faux positif ciblé

/** Log AutoMod réel (timeout de 10 min) puis clic « Faux positif ». */
async function fpRun(w, { moderationTimeout = async () => ({ id: 3 }) } = {}) {
  const logsSent = [];
  const svc = new AutoModService({
    config: { get: () => ({ moderation: { dmOnSanction: false }, automod: { enabled: true, notify: 'none', escalation: { enabled: false }, filters: { antiLink: { enabled: true, action: 'timeout', duration: '10m' } } } }) },
    logging: { send: async (...a) => logsSent.push(a) },
    moderation: { timeout: moderationTimeout },
    events: w.events,
  });
  await svc.handleMessage({
    id: nextId(),
    guild: { id: G, members: { me: { id: BOT } }, channels: { cache: new Map() } },
    author: { id: U, bot: false, createdTimestamp: 0, toString: () => `<@${U}>`, displayAvatarURL: () => null },
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
    channel: { id: C1, toString: () => `<#${C1}>` },
    content: 'regarde https://monblog.fr/post',
    delete: async () => {},
  });
  const [, , embed, components] = logsSent[0];
  const fpId = ids(components).find((x) => x.startsWith('cmd:automod:fp:'));
  const message = { id: LOG, embeds: [embed.toJSON()], components: components.map(json) };
  const { i, out } = fakeInteraction(w, { customId: fpId, message, permissions: perms('ManageGuild', 'ModerateMembers') });
  const row = w.events.get(G, Number(fpId.split(':')[3]));
  await automod.buttons.fp(i, w.client, fpId.split(':').slice(3));
  return { out, row, description: json(out.followUps[0].embeds[0]).description };
}

test('faux positif : fin du timeout AutoMod enregistrée ; levé seulement si c\'est encore lui', async () => {
  const w = dashboardWorld({ untilOffset: 10 * 60_000 });
  const before = Date.now();
  const { row, description } = await fpRun(w);
  assert.ok(Math.abs(row.timeout_until - (before + 600_000)) < 5_000, 'timeout_until ≈ maintenant + 10 min');
  assert.equal(w.calls.removeTimeout.length, 1);
  assert.match(description, /Timeout \*\*levé\*\*/);
});

test('faux positif : un autre timeout en cours (posé par un modérateur) n\'est pas levé', async () => {
  const w = dashboardWorld({ untilOffset: 7 * 86_400_000 });
  const { description } = await fpRun(w);
  assert.equal(w.calls.removeTimeout.length, 0);
  assert.match(description, /autre timeout est en cours.*non levé/);
});

test('faux positif : timeout AutoMod impossible → rien à lever, même si le membre est en timeout', async () => {
  const w = dashboardWorld();
  const { row, description } = await fpRun(w, { moderationTimeout: async () => { throw new Error('hiérarchie'); } });
  assert.equal(row.timeout_until, 0);
  assert.equal(w.calls.removeTimeout.length, 0);
  assert.match(description, /Aucun timeout n'avait été posé/);
});

test('faux positif : ancien enregistrement (sans fin connue) → comportement précédent', async () => {
  const w = dashboardWorld();
  const id = w.events.add({ guildId: G, userId: U, filter: 'antiLink', action: 'timeout' });
  const message = { id: LOG, embeds: [{ footer: { text: `Gadget • ID : ${U}` }, fields: [] }], components: [] };
  const { i } = fakeInteraction(w, { customId: `cmd:automod:fp:${id}`, message, permissions: perms('ManageMessages', 'ModerateMembers') });
  await automod.buttons.fp(i, w.client, [String(id)]);
  assert.equal(w.calls.removeTimeout.length, 1);
});

// ---------------------------------------------------------------- 6. qbanok

test('bannir (confirmé) : membre absent seulement sur 10007, sinon erreur « réessayez »', async () => {
  const w = dashboardWorld();
  w.guild.members.fetch = async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); };
  await automod.buttons.qbanok(fakeInteraction(w, { permissions: perms('BanMembers') }).i, w.client, [U]);
  assert.equal(w.calls.ban.length, 1);
  assert.equal(w.calls.ban[0][4].targetMember, undefined);

  w.guild.members.fetch = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
  await assert.rejects(automod.buttons.qbanok(fakeInteraction(w, { permissions: perms('BanMembers') }).i, w.client, [U]), (err) => err.name === 'UserError' && /réessayez/.test(err.message));
  assert.equal(w.calls.ban.length, 1, 'pas de bannissement sans vérification de hiérarchie');
});

// ---------------------------------------------------------------- 7. vue « Faux positif » bornée

test('vue « Faux positif » : domaines > 253 et suggestions > 80 caractères ignorés, champ ≤ 1024', () => {
  const label = (c) => c.repeat(60);
  const long = `${label('a')}.${label('b')}.${label('c')}.${label('d')}.xyz`; // 248 caractères
  const huge = `${long.slice(0, -4)}.${label('e')}.xyz`; // > 253
  const medium = `${'m'.repeat(85)}.fr`;
  const cfg = { filters: { antiLink: { allowedDomains: [] }, badWords: { words: ['x'.repeat(90), 'con'] } } };
  const fixes = automod.fixSuggestions(cfg, 'antiLink', `https://${long}/ https://${huge}/ https://${medium} https://ok.fr`);
  assert.deepEqual(fixes, [{ kind: 'domain', value: 'ok.fr' }]);
  assert.deepEqual(automod.fixSuggestions(cfg, 'badWords', `${'x'.repeat(90)} et con`), [{ kind: 'word', value: 'con' }]);
  const many = Array.from({ length: 4 }, (_, k) => ({ kind: 'domain', value: `${String(k).repeat(70)}.com` }));
  const view = automod.falsePositiveView({ userId: U, filter: 'antiLink', action: 'timeout', content: 'x', fixes: many, canFix: true });
  const field = json(view.embeds[0]).fields.find((f) => f.name.includes('Correctifs'));
  assert.ok(field.value.length <= 1024);
  assert.ok(field.value.includes(many[3].value), 'rien de tronqué');
});

// ---------------------------------------------------------------- 3. anti-arnaques

test('anti-arnaques : marque + extension dans une phrase → indice faible (1 point)', () => {
  for (const t of ['je suis sur discord.de toute façon', 'tu es sur roblox.es ou pas ?', 'jouez sur twitch.fr', 'c\'est sur discord.in game']) {
    assert.equal(phishingScore(t).score, 1, t);
  }
  // Avec protocole, chemin, www ou homoglyphe : toujours une imitation forte.
  for (const t of ['https://discord.fr', 'discord.de/nitro', 'www.discord.de', 'disc0rd.de', 'https://discordapp.co/gift']) {
    assert.ok(phishingScore(t).score >= 3, t);
  }
});

test('anti-arnaques : services d\'invitation laissés à l\'anti-invitations', () => {
  for (const h of ['discord.me', 'discord.io', 'discord.li', 'discord.link', 'dsc.gg', 'invite.gg']) assert.equal(imitatesBrand(h), null, h);
  assert.equal(phishingScore('@everyone giveaway sur notre partenaire https://discord.io/partenaire', { mentionsEveryone: true }).score, 0);
  assert.equal(phishingScore('t\'es sur discord.me dit moi').score, 0);
});

test('anti-arnaques : lien masqué fort seulement s\'il affiche une marque ou vise un site suspect', () => {
  for (const t of ['[twitter.com/user/status/1](https://fxtwitter.com/user/status/1)', '[github.com/foo/bar](https://foo.github.io/bar)', '[www.amazon.fr](https://amzn.to/abc)']) {
    assert.equal(phishingScore(t).score, 1, t);
    assert.equal(maskedLinks(t)[0].strong, false, t);
  }
  for (const t of ['[discord.com/gift](https://evil.example.com)', '[steamcommunity.com/trade](https://trade-offer.com)', '[nitro.com](https://example.com)', '[google.com](https://free-gift.xyz)']) {
    assert.ok(phishingScore(t).score >= 3, t);
  }
});

test('anti-arnaques : vrais mots (« discorde », « nitrox ») non pris pour des imitations', () => {
  assert.equal(phishingScore('la-discorde.fr est un bon site').score, 0);
  assert.equal(phishingScore('https://nitrox.com plongée').score, 0);
});

test('anti-arnaques : les vraies arnaques restent détectées (seuil 3)', () => {
  for (const t of [
    'https://discord-gift.com',
    '@everyone free nitro https://discord-gift.com/claim',
    'https://dlscord.com/nitro',
    'https://steamcommunity.com.ru/x',
    'https://xn--discrd-zxa.com',
    'https://steam-trade.ru',
    'https://epicgame.com free',
    'https://bit.ly/abc free nitro @everyone',
    '[discord.com/nitro](https://claim-now.xyz)',
    'https://discord.com@evil.ru/gift',
  ]) assert.ok(phishingScore(t).score >= 3, t);
});

test('préréglage Strict : seuil anti-arnaques remonté à 3', () => {
  assert.equal(PRESETS.strict.patch.filters.antiPhishing.threshold, 3);
});

// ---------------------------------------------------------------- 9. purge en masse du bot

function bulkWorld() {
  const sent = [];
  const cfg = { logs: {}, logChannels: { messages: '700000000000000001' } };
  const logging = new LoggingService({ guilds: { cache: new Map() } }, { get: () => cfg });
  logging.send = async (...a) => sent.push(a);
  const client = { services: { logging } };
  const channel = { id: C1, guild: { id: G }, parentId: null, parent: null, toString: () => `<#${C1}>` };
  const handler = logExtras.find((e) => e.name === 'messageDeleteBulk');
  const batch = (list) => new Collection(list.map((id) => [id, { id, content: 'x', createdTimestamp: 0, author: { id: U, username: 'bob', tag: 'bob' } }]));
  return { logging, client, channel, handler, batch, sent };
}

test('suppression en masse faite par le bot (purge de quarantaine) : pas de log en double', async () => {
  const w = bulkWorld();
  w.logging.suppressMessage('m1');
  w.logging.suppressMessage('m2');
  await w.handler.execute(w.client, w.batch(['m1', 'm2']), w.channel);
  assert.equal(w.sent.length, 0);
  assert.equal(w.logging.suppressed.size, 0, 'marques consommées');
});

test('suppression en masse en partie manuelle : journalisée, marques intactes', async () => {
  const w = bulkWorld();
  w.logging.suppressMessage('m1');
  await w.handler.execute(w.client, w.batch(['m1', 'm9']), w.channel);
  assert.equal(w.sent.length, 1);
  assert.match(json(w.sent[0][2]).title, /Suppression en masse/);
  assert.equal(w.logging.suppressed.size, 1);
});

// ---------------------------------------------------------------- 10. AutoMod natif

test('AutoMod natif : exemptions au-delà des limites Discord signalées dans la synchronisation', async () => {
  const roles = Array.from({ length: 25 }, (_, k) => String(800000000000000000n + BigInt(k)));
  const chans = Array.from({ length: 55 }, (_, k) => String(810000000000000000n + BigInt(k)));
  const truncated = [];
  const rules = native.desiredRules({ ignoredRoles: roles, ignoredChannels: chans, filters: { antiSpam: { enabled: true } } }, null, null, truncated);
  assert.equal(rules[0].exemptRoles.length, 20);
  assert.equal(rules[0].exemptChannels.length, 50);
  assert.deepEqual(truncated, [{ name: native.NAMES.spam, detail: '5 rôle(s) au-delà de 20 ignoré(s), 5 salon(s) au-delà de 50 ignoré(s)' }]);

  // Bouton « Synchroniser » : l'avertissement est affiché.
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  config.update(G, { automod: { ignoredRoles: roles, filters: { antiSpam: { enabled: true } } } });
  const created = [];
  const guild = {
    id: G,
    name: 'Serveur',
    members: { me: { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache: new Collection() },
    roles: { cache: null },
    autoModerationRules: { fetch: async () => new Map(), create: async (r) => created.push(r) },
  };
  const client = { services: { config, automod: new AutoModService({ config, logging: {}, moderation: {} }) }, repositories: {} };
  let payload;
  const i = { guildId: G, guild, memberPermissions: perms('ManageGuild'), deferUpdate: async () => {}, editReply: async (p) => (payload = p) };
  await automod.buttons.native(i, client, ['sync']);
  assert.equal(created.length, 1);
  const text = JSON.stringify(payload.embeds.map(json));
  assert.match(text, /exemptions limitées par Discord : 5 rôle\(s\) au-delà de 20/);
});

// ---------------------------------------------------------------- 11. /logs : interrupteurs idempotents

function logsWorld() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const guild = {
    id: G,
    name: 'Test',
    roles: { cache: new Collection() },
    members: { me: { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache: new Collection() },
  };
  const client = { services: { config, logging: new LoggingService({ channels: { fetch: async () => null } }, config) } };
  const click = async (action, args) => {
    let payload;
    const i = { guildId: G, guild, memberPermissions: new PermissionsBitField(PermissionsBitField.All), values: [], update: async (p) => (payload = p) };
    await logs.buttons[action](i, client, args);
    return payload;
  };
  return { config, guild, client, click };
}

test('/logs : interrupteur global, pause et bots appliquent la valeur cible (double clic sans effet)', async () => {
  const w = logsWorld();
  await w.click('toggle', ['off']);
  await w.click('toggle', ['off']);
  assert.equal(w.config.get(G).logs.enabled, false);
  await w.click('toggle', ['on']);
  assert.equal(w.config.get(G).logs.enabled, true);

  await w.click('pause', ['messages', 'on']);
  await w.click('pause', ['messages', 'on']);
  assert.deepEqual(w.config.get(G).logs.disabledCategories, ['messages']);
  await w.click('pause', ['messages', 'off']);
  await w.click('pause', ['messages', 'off']);
  assert.deepEqual(w.config.get(G).logs.disabledCategories, []);

  await w.click('bots', ['on']);
  await w.click('bots', ['on']);
  assert.equal(w.config.get(G).logs.ignoreBots, false, 'bots journalisés');
  await w.click('bots', ['off']);
  assert.equal(w.config.get(G).logs.ignoreBots, true);

  // Anciens boutons sans valeur : inversion (compatibilité).
  await w.click('toggle', []);
  assert.equal(w.config.get(G).logs.enabled, false);
});

test('/logs : les boutons portent la valeur cible affichée', () => {
  const w = logsWorld();
  const all = (view) => ids(logs.render(w.client, w.guild, view).components);
  assert.ok(all('home').includes('cmd:logs:toggle:off'));
  assert.ok(all('cat:messages').includes('cmd:logs:pause:messages:on'));
  assert.ok(all('options').includes('cmd:logs:bots:on'));
  w.config.update(G, { logs: { enabled: false, disabledCategories: ['messages'], ignoreBots: false } });
  assert.ok(all('home').includes('cmd:logs:toggle:on'));
  assert.ok(all('cat:messages').includes('cmd:logs:pause:messages:off'));
  assert.ok(all('options').includes('cmd:logs:bots:off'));
});

// ---------------------------------------------------------------- 12. vocal : salon supprimé

test('logs vocaux : salon supprimé → mention par identifiant, jamais « null »', async () => {
  const sent = [];
  const client = { services: { tempVoice: { handleVoiceUpdate: async () => {} }, logging: { send: async (...a) => sent.push(a) } } };
  const member = { user: { id: U, bot: false, username: 'bob', toString: () => `<@${U}>`, displayAvatarURL: () => null } };
  const guild = { id: G };
  await voiceStateUpdate.execute(client, { channelId: C1, channel: null, member, guild }, { channelId: null, channel: null, member, guild });
  await voiceStateUpdate.execute(client, { channelId: C1, channel: null, member, guild }, { channelId: C2, channel: { toString: () => `<#${C2}>` }, member, guild });
  const leave = json(sent[0][2]);
  const move = json(sent[1][2]);
  assert.match(leave.description, new RegExp(`a quitté <#${C1}>`));
  assert.match(move.description, new RegExp(`de <#${C1}> à <#${C2}>`));
  for (const e of [leave, move]) assert.ok(!JSON.stringify(e).includes('null'), 'aucun « null »');
});
