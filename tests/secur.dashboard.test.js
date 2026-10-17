'use strict';

/**
 * SEC2 — panneau /secur (sections panneau, on, max, off, module, owner, confiance), intégration à
 * /antiraid et /whitelist (verrou, accès en attente, journal), rendus purs (utils/securViews).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SecurityIncidentRepository } = require('../src/database/repositories/SecurityIncidentRepository');
const { SecurityGrantRepository } = require('../src/database/repositories/SecurityGrantRepository');
const { SecurityBlacklistRepository } = require('../src/database/repositories/SecurityBlacklistRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { AntiRaidService } = require('../src/services/AntiRaidService');
const { SecurService } = require('../src/services/SecurService');
const { BlacklistService } = require('../src/services/BlacklistService');
const { SecurRegistry } = require('../src/services/secur/registry');
const S = require('../src/utils/secur');
const V = require('../src/utils/securViews');
const { defaultGuildConfig } = require('../src/config/defaults');
const secur = require('../src/commands/security/secur');
const antiraid = require('../src/commands/security/antiraid');
const whitelist = require('../src/commands/security/whitelist');

const G = '100000000000000001';
const BOT = '100000000000000010';
const OWNER = '100000000000000011';
const ADMIN = '100000000000000012';
const SECOWNER = '100000000000000013';
const MEMBER = '100000000000000014';
const OTHERBOT = '100000000000000015';
const HUMAN2 = '100000000000000016';
const SEC_CH = '100000000000000020';
const R_ADMIN = '100000000000000030';
const R_PING = '100000000000000031';
const R_MANAGED = '100000000000000032';
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const ALL = PermissionsBitField.All;

function makeRole(id, { position = 1, perms = 0n, managed = false, mentionable = false } = {}) {
  return { id, position, managed, mentionable, editable: !managed, members: new Collection(), permissions: new PermissionsBitField(perms), toString: () => `<@&${id}>` };
}

/** Monde : vraie base, vraie configuration, vrais AntiRaid et SecurService, faux serveur. */
function world({ modules = [], cfg = {} } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const incidents = new SecurityIncidentRepository(db);
  const grants = new SecurityGrantRepository(db);
  const logged = [];
  const posts = [];
  const dms = [];
  const roles = new Collection();
  const everyone = makeRole(G, { position: 0 });
  roles.set(G, everyone);
  for (const r of [makeRole(R_ADMIN, { position: 5, perms: P.Administrator }), makeRole(R_PING, { position: 2, mentionable: true }), makeRole(R_MANAGED, { position: 3, managed: true })]) roles.set(r.id, r);
  const members = new Collection();
  const channels = new Collection([[SEC_CH, { id: SEC_CH, guildId: G, send: async (p) => { posts.push(p); return { id: `m${posts.length}`, edit: async () => {} }; } }]]);
  const guild = {
    id: G,
    name: 'Serveur',
    ownerId: OWNER,
    memberCount: 0,
    roles: { cache: roles, everyone },
    channels: { cache: channels },
    members: { cache: members, me: null, fetch: async (id) => members.get(id) ?? Promise.reject(Object.assign(new Error('Unknown Member'), { code: 10007 })) },
    client: { user: { id: BOT } },
  };
  const client = {
    user: { id: BOT },
    config: { ownerIds: [], securTrustBotOwners: false },
    guilds: { cache: new Map([[G, guild]]) },
    channels: { fetch: async () => null },
    users: { fetch: async (id) => ({ id, bot: false, send: async (p) => void dms.push([id, p]) }) },
    repositories: { securityIncidents: incidents },
    services: {},
  };
  const logging = { send: async (...a) => { logged.push(a); return true; } };
  const antiraidService = new AntiRaidService({ client, config, logging });
  const registry = new SecurRegistry();
  for (const key of modules) registry.register({ key, auditTypes: S.SECUR_MODULES[key].auditTypes, priority: 3, classify: () => ({ weight: 1, record: null }), undo: async () => ({ ok: true }), targetKey: () => 'x' });
  const securService = new SecurService({ client, config, logging, antiraid: antiraidService, incidents, grants, registry });
  // Liste noire réelle (SEC3) : ses actions font partie des gestionnaires de la coquille /secur.
  const blacklistService = new BlacklistService({ client, config, logging, repo: new SecurityBlacklistRepository(db) });
  client.services = { config, antiraid: antiraidService, secur: securService, logging, blacklist: blacklistService };
  config.update(G, { logChannels: { security: SEC_CH }, ...cfg });

  const addMember = (id, { roleIds = [], bot = false, perms = 0n } = {}) => {
    const roleCache = new Collection(roleIds.map((r) => [r, roles.get(r)]));
    let bits = perms;
    for (const r of roleCache.values()) bits |= r.permissions.bitfield;
    const member = {
      id,
      guild,
      user: { id, bot, tag: `u${id}`, username: `u${id}`, toString: () => `<@${id}>` },
      roles: { cache: roleCache, highest: [...roleCache.values()].sort((a, b) => b.position - a.position)[0] ?? everyone },
      permissions: new PermissionsBitField(id === OWNER ? ALL : bits),
      toString: () => `<@${id}>`,
    };
    members.set(id, member);
    for (const r of roleCache.values()) r.members.set(id, member);
    guild.memberCount = members.size;
    return member;
  };
  addMember(OWNER);
  addMember(ADMIN, { roleIds: [R_ADMIN] });
  addMember(MEMBER);
  addMember(BOT, { bot: true, perms: P.Administrator });
  guild.members.me = members.get(BOT);
  return { db, config, incidents, grants, secur: securService, antiraid: antiraidService, client, guild, members, roles, logged, posts, dms, addMember };
}

/** Fausse interaction (bouton, menu, formulaire ou commande). */
function fake(w, { user = OWNER, perms = ALL, values, fields, options, users, members: resolved } = {}) {
  const calls = { update: [], reply: [], modal: [], editReply: [], followUp: [], deferReply: 0, deferUpdate: 0 };
  const uid = typeof user === 'string' ? user : user.id;
  return {
    calls,
    guildId: G,
    guild: w.guild,
    client: w.client,
    user: { id: uid, tag: `u${uid}`, username: `u${uid}`, bot: false, toString: () => `<@${uid}>` },
    member: w.members.get(uid) ?? null,
    memberPermissions: new PermissionsBitField(perms),
    values,
    users,
    members: resolved,
    fields: fields ? { getTextInputValue: (id) => fields[id] ?? '' } : undefined,
    options,
    isFromMessage: () => true,
    async update(p) { calls.update.push(p); },
    async reply(p) { calls.reply.push(p); },
    async showModal(m) { calls.modal.push(m); },
    async deferReply() { calls.deferReply += 1; this.deferred = true; },
    async deferUpdate() { calls.deferUpdate += 1; this.deferred = true; },
    async editReply(p) { calls.editReply.push(p); },
    async followUp(p) { calls.followUp.push(p); },
  };
}

/** Options d'une commande : sous-commande (et groupe), valeurs. */
function opts(sub, values = {}, group = null) {
  return {
    getSubcommand: () => sub,
    getSubcommandGroup: () => group,
    getString: (n) => values[n] ?? null,
    getInteger: (n) => values[n] ?? null,
    getBoolean: (n) => values[n] ?? null,
    getUser: (n) => values[n]?.user ?? null,
    getMember: (n) => values[n]?.member ?? null,
    getRole: (n) => values[n] ?? null,
  };
}

const lastPayload = (i) => i.calls.update.at(-1) ?? i.calls.editReply.at(-1) ?? i.calls.reply.at(-1);
const text = (p) => JSON.stringify((p?.embeds ?? []).map(json));
const ids = (p) => (p?.components ?? []).map(json).flatMap((r) => r.components ?? []).map((c) => c.custom_id).filter(Boolean);

/** Limites Discord et routage : chaque cmd:secur:<action> vise un gestionnaire existant. */
function assertValid(payload, label) {
  const rows = (payload.components ?? []).map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const seen = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, `${label} : rangée trop longue`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      seen.push(c.custom_id);
      assert.ok(c.custom_id.length <= 100, `${label} : ${c.custom_id}`);
      const [, cmd, action] = c.custom_id.split(':');
      if (cmd === 'secur') assert.equal(typeof secur.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25 && c.options.length >= 1, `${label} : ${c.options.length} options`);
      if (c.default_values) assert.ok(c.default_values.length <= 25);
      if (c.label) assert.ok(c.label.length <= 80);
    }
  }
  assert.equal(new Set(seen).size, seen.length, `${label} : identifiants en double`);
  for (const e of (payload.embeds ?? []).map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096, `${label} : description`);
    assert.ok((e.fields ?? []).length <= 25);
    for (const f of e.fields ?? []) assert.ok(f.value.length <= 1024 && f.name.length <= 256, `${label} : champ ${f.name}`);
    const total = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `${label} : ${total} caractères`);
  }
}

const panel = () => secur.sections.get('panneau');
const stateOf = (w, user = OWNER, notice = null) => panel().panelState(w.client, fake(w, { user }), notice);
const ALL_VIEWS = [...V.VIEWS, ...S.MODULE_KEYS.map((k) => `module.${k}`), 'inconnue', 'module.__proto__', 'module.constructor'];

// ---------------------------------------------------------------- commande

test('/secur : 10 options de premier niveau au plus 25, sections chargées (panneau, on, max, off, module, owner, confiance, statut)', () => {
  const data = secur.data.toJSON();
  const names = data.options.map((o) => o.name);
  for (const n of ['panneau', 'on', 'max', 'off', 'module', 'owner', 'confiance', 'statut']) assert.ok(names.includes(n), n);
  assert.ok(data.options.length <= 25);
  assert.equal(data.default_member_permissions, String(P.Administrator));
  const module = data.options.find((o) => o.name === 'module');
  assert.equal(module.options.find((o) => o.name === 'module').choices.length, S.MODULE_KEYS.length);
  for (const o of data.options) assert.ok(o.description.length <= 100 && o.description.length > 0);
});

// ---------------------------------------------------------------- vues

test('chaque vue (vue inconnue et serveur minimal compris) respecte les limites et route vers un gestionnaire', () => {
  const w = world({ modules: ['channelDelete', 'ban', 'messagePurge'] });
  w.addMember(OTHERBOT, { bot: true, roleIds: [R_ADMIN] });
  for (const user of [OWNER, ADMIN]) {
    for (const v of ALL_VIEWS) assertValid(V.renderView(stateOf(w, user, 'Notification'), v), `${v} (${user === OWNER ? 'propriétaire' : 'admin'})`);
    for (const p of ['on', 'max', 'off']) assertValid(V.presetConfirmView(stateOf(w, user), p, S.presetPatch(p, defaultGuildConfig.secur.modules)), `preset ${p}`);
  }
  // Listes pleines : 25 owners / bots, 40 accès en attente, 30 incidents, 60 exposés.
  const many = (base, n) => Array.from({ length: n }, (_, i) => String(BigInt(base) + BigInt(i)));
  for (const id of many('300000000000000000', 60)) w.addMember(id, { roleIds: [R_ADMIN], bot: id.endsWith('7') });
  w.config.update(G, { secur: { owners: many('300000000000000000', 25), trustedBots: many('300000000000000100', 25), raidPingRoleId: R_PING, verrou: true } });
  for (const [i, id] of many('300000000000000000', 40).entries()) w.grants.create({ guildId: G, kind: i % 2 ? 'user' : 'wlrole', subjectId: id, grantedBy: ADMIN });
  for (let i = 0; i < 30; i += 1) w.incidents.create({ guildId: G, executorId: ADMIN, modules: ['channelDelete', 'ban'], actions: 3, punishment: i % 2 ? 'ban' : 'derank', removedRoles: i % 2 ? null : [R_ADMIN] });
  for (const v of ALL_VIEWS) assertValid(V.renderView(stateOf(w, OWNER, 'x'.repeat(300)), v), `${v} (plein)`);
  for (const p of ['on', 'max', 'off']) assertValid(V.presetConfirmView(stateOf(w), p, S.presetPatch(p, defaultGuildConfig.secur.modules)), `preset ${p} (plein)`);
  // Serveur minimal : aucun cache, aucun service Secur.
  const bare = { id: G, ownerId: OWNER };
  const client = { user: { id: BOT }, services: { config: w.config }, repositories: {} };
  for (const v of ALL_VIEWS) assertValid(V.renderView(panel().panelState(client, { guild: bare, user: { id: ADMIN } }), v), `${v} (minimal)`);
  // Vues ouvrables par cmd:secur:open:<vue>.
  for (const name of V.VIEWS) assert.equal(typeof secur.views[name], 'function', name);
});

test('module non chargé : « non disponible », aucun composant de réglage ; chargé : mode, sanction, annulation, seuil', () => {
  const w = world({ modules: ['channelDelete'] });
  const off = V.renderView(stateOf(w), 'module.roleDelete');
  assert.match(text(off), /Non disponible/);
  assert.deepEqual(ids(off).filter((id) => /:(mode|punish|undo|limits):/.test(id)), []);
  const on = V.renderView(stateOf(w), 'module.channelDelete');
  for (const re of [/^cmd:secur:mode:channelDelete$/, /^cmd:secur:punish:channelDelete$/, /^cmd:secur:undo:channelDelete:off$/, /^cmd:secur:limits:channelDelete$/]) assert.ok(ids(on).some((id) => re.test(id)), String(re));
  // Administrateur non owner : lecture seule, aucun composant de modification.
  const ro = V.renderView(stateOf(w, ADMIN), 'module.channelDelete');
  assert.match(text(ro), /Lecture seule/);
  assert.deepEqual(ids(ro).filter((id) => /:(mode|punish|undo|limits):/.test(id)), []);
  const home = V.renderView(stateOf(w, ADMIN), 'home');
  assert.deepEqual(ids(home).filter((id) => /preview/.test(id)), []);
  // Statut du module non chargé dans l'accueil.
  assert.match(text(V.renderView(stateOf(w), 'home')), /non disponible/);
});

// ---------------------------------------------------------------- permissions

test('tous les gestionnaires refusent sans Administrateur ; les modifications refusent un administrateur non-owner', async () => {
  const w = world({ modules: ['channelDelete'] });
  const args = { nav: [], go: ['home'], preview: ['on'], apply: ['on'], trustbots: ['on'], mode: ['channelDelete'], punish: ['channelDelete'], undo: ['channelDelete', 'off'], limits: ['channelDelete'], limitsubmit: ['channelDelete'], verrou: ['on'], raidping: [], notify: ['on'], ownersdm: ['off'], botexec: [], restore: [], grantdecide: [], owners: [], trust: [], statut: [], open: ['home'], blpage: ['0'], blrpage: ['0'], blask: [HUMAN2], blremove: [HUMAN2, '1'], blcancel: [] };
  for (const perms of [0n, P.ManageGuild]) {
    for (const [name, handler] of Object.entries(secur.buttons)) {
      const i = fake(w, { user: OWNER, perms, values: ['on'], fields: { limit: '3' } });
      await assert.rejects(handler(i, w.client, args[name] ?? []), { name: 'UserError' }, name);
      assert.equal(i.calls.update.length + i.calls.reply.length + i.calls.modal.length, 0, name);
    }
  }
  // Lecture seule : navigation (SEC2) et pages / annulation de la liste noire et du blrank (SEC3).
  const readOnly = ['nav', 'go', 'statut', 'open', 'blpage', 'blrpage', 'blcancel'];
  const before = JSON.stringify(w.config.get(G).secur);
  for (const [name, handler] of Object.entries(secur.buttons)) {
    if (readOnly.includes(name)) continue;
    const i = fake(w, { user: ADMIN, values: ['on'], fields: { limit: '3' } });
    await assert.rejects(handler(i, w.client, args[name] ?? []), (e) => e.name === 'UserError' && /owner|propriétaire/i.test(e.message), name);
  }
  assert.equal(JSON.stringify(w.config.get(G).secur), before, 'un administrateur non-owner a modifié Secur');
  // Lecture : un administrateur navigue.
  const nav = fake(w, { user: ADMIN, values: ['journal'] });
  await secur.buttons.nav(nav, w.client);
  assert.match(text(nav.calls.update[0]), /Journal/);
  // Commandes de modification : refusées à l'administrateur non-owner, avant tout deferReply.
  for (const sub of ['on', 'max', 'off']) {
    const i = fake(w, { user: ADMIN, options: opts(sub) });
    await assert.rejects(secur.execute(i, w.client), { name: 'UserError' });
    assert.equal(i.calls.deferReply, 0);
  }
});

test('own() refuse __proto__ et constructor ; clés de module et préréglages inconnus refusés', async () => {
  assert.equal(S.own(S.SECUR_MODULES, '__proto__'), false);
  assert.equal(S.own(S.SECUR_MODULES, 'constructor'), false);
  assert.equal(S.own(S.SECUR_MODULES, 'channelDelete'), true);
  const w = world({ modules: ['channelDelete'] });
  for (const key of ['__proto__', 'constructor', 'toString', 'inconnu']) {
    await assert.rejects(secur.buttons.mode(fake(w, { values: ['on'] }), w.client, [key]), { name: 'UserError' });
    await assert.rejects(secur.buttons.limits(fake(w), w.client, [key]), { name: 'UserError' });
    await assert.rejects(secur.buttons.apply(fake(w), w.client, [key]), { name: 'UserError' });
  }
  await assert.rejects(secur.buttons.mode(fake(w, { values: ['__proto__'] }), w.client, ['channelDelete']), { name: 'UserError' });
  // Module non chargé : aucun réglage possible.
  await assert.rejects(secur.buttons.mode(fake(w, { values: ['on'] }), w.client, ['roleDelete']), /pas disponible/);
});

// ---------------------------------------------------------------- préréglages

test('préréglages : exacts, idempotents (double clic → une seule écriture et un seul journal), punitions et annulations conservées', async () => {
  const w = world({ modules: ['channelDelete', 'ban'] });
  const journals = [];
  w.secur.journal = async (_g, entry) => void journals.push(entry);
  w.config.update(G, { secur: { modules: { channelDelete: { punish: 'ban', undo: false }, ban: { punish: 'kick' } } } });
  // Slash : deferReply puis confirmation (rien n'est encore appliqué).
  const slash = fake(w, { options: opts('max') });
  await secur.execute(slash, w.client);
  assert.equal(slash.calls.deferReply, 1);
  assert.match(text(slash.calls.editReply[0]), /Protection maximale/);
  assert.equal(S.moduleMode(w.config.get(G), 'channelDelete'), 'off');
  // Double clic : une seule écriture.
  const [a, b] = [fake(w), fake(w)];
  await Promise.all([secur.buttons.apply(a, w.client, ['max']), secur.buttons.apply(b, w.client, ['max'])]);
  const cfg = w.config.get(G);
  for (const key of S.MODULE_KEYS) assert.equal(S.moduleMode(cfg, key), 'max', key);
  assert.equal(S.moduleConfig(cfg, 'channelDelete').punish, 'ban', 'sanction conservée');
  assert.equal(S.moduleConfig(cfg, 'channelDelete').undo, false, 'annulation conservée');
  assert.equal(S.moduleConfig(cfg, 'ban').punish, 'kick');
  assert.equal(S.moduleConfig(cfg, 'ban').limit, S.MAX_LIMITS.ban, 'limite resserrée en max');
  assert.equal(S.moduleConfig(cfg, 'channelUpdate').ignoreBenign, false, 'options tolérantes coupées en max');
  assert.equal(journals.length, 1, `${journals.length} journal(aux) pour un double clic`);
  assert.match(text(b.calls.update[0]) + text(a.calls.update[0]), /déjà appliqué/);
  // Encore : idempotent, aucun journal.
  await secur.buttons.apply(fake(w), w.client, ['max']);
  assert.equal(journals.length, 1);
  // on : limites et options par défaut, sanctions toujours conservées.
  await secur.buttons.apply(fake(w), w.client, ['on']);
  assert.equal(S.moduleConfig(w.config.get(G), 'ban').limit, null, 'limite héritée en on');
  assert.equal(S.moduleConfig(w.config.get(G), 'channelUpdate').ignoreBenign, true);
  assert.equal(S.moduleConfig(w.config.get(G), 'channelDelete').punish, 'ban');
  // off : journalisé avec les tranches avant / après (critique).
  await secur.buttons.apply(fake(w), w.client, ['off']);
  assert.equal(journals.length, 3);
  assert.ok(journals[2].before.secur.modules && journals[2].after.secur.modules);
  assert.ok(S.MODULE_KEYS.every((k) => S.moduleMode(w.config.get(G), k) === 'off'));
});

test('préréglage : « Appliquer » désactivé tant qu\'un bot dangereux n\'est pas traité ; bots de confiance → actif ; force → appliqué', async () => {
  const w = world({ modules: ['channelDelete'] });
  w.secur.journal = async () => {};
  w.addMember(OTHERBOT, { bot: true, roleIds: [R_ADMIN] });
  const applyBtn = (p, preset) => (p.components ?? []).map(json).flatMap((r) => r.components).find((c) => c.custom_id === `cmd:secur:apply:${preset}`);
  const preview = fake(w);
  await secur.buttons.preview(preview, w.client, ['on']);
  const p1 = preview.calls.update[0];
  assert.equal(applyBtn(p1, 'on').disabled, true, 'Appliquer actif malgré un bot Administrateur non traité');
  assert.ok(ids(p1).includes('cmd:secur:trustbots:on') && ids(p1).includes('cmd:secur:apply:on:force'));
  assert.match(text(p1), new RegExp(OTHERBOT));
  // Clic forgé sur « Appliquer » : refusé.
  await assert.rejects(secur.buttons.apply(fake(w), w.client, ['on']), /pas traités/);
  assert.equal(S.moduleMode(w.config.get(G), 'channelDelete'), 'off');
  // « Ajouter les bots listés aux bots de confiance » (niveau owner) → Appliquer actif.
  await assert.rejects(secur.buttons.trustbots(fake(w, { user: ADMIN }), w.client, ['on']), { name: 'UserError' });
  const trust = fake(w);
  await secur.buttons.trustbots(trust, w.client, ['on']);
  assert.deepEqual(w.config.get(G).secur.trustedBots, [OTHERBOT]);
  assert.equal(applyBtn(trust.calls.update[0], 'on').disabled ?? false, false);
  // Whitelisté : exempté en on, mais PAS en max (la whitelist ne protège pas en max).
  w.config.update(G, { secur: { trustedBots: [] }, whitelist: { users: [OTHERBOT] } });
  assert.equal(V.blockingBots(stateOf(w).exposure, 'on').length, 0);
  assert.equal(V.blockingBots(stateOf(w).exposure, 'max').length, 1);
  assert.equal(V.blockingBots(stateOf(w).exposure, 'off').length, 0);
  // force : appliqué malgré le bot non traité.
  await secur.buttons.apply(fake(w), w.client, ['max', 'force']);
  assert.equal(S.moduleMode(w.config.get(G), 'channelDelete'), 'max');
});

// ---------------------------------------------------------------- owners et confiance

test('owners : seul le propriétaire modifie, bots et absents refusés, 25 au plus ; confiance : humains refusés', async () => {
  const w = world();
  w.secur.journal = async () => {};
  w.addMember(SECOWNER);
  w.addMember(OTHERBOT, { bot: true });
  const member = (id) => ({ user: w.members.get(id)?.user ?? { id, bot: false, toString: () => `<@${id}>` }, member: w.members.get(id) ?? null });
  const run = (group, sub, user, target) => secur.execute(fake(w, { user, options: opts(sub, { membre: target, bot: target }, group) }), w.client);
  // Propriétaire : ajoute un humain présent.
  await run('owner', 'ajouter', OWNER, member(SECOWNER));
  assert.deepEqual(w.config.get(G).secur.owners, [SECOWNER]);
  // Un owner de sécurité (ou un admin) ne nomme pas d'owner.
  await assert.rejects(run('owner', 'ajouter', SECOWNER, member(ADMIN)), /propriétaire du serveur/);
  await assert.rejects(run('owner', 'ajouter', ADMIN, member(ADMIN)), /propriétaire du serveur/);
  await assert.rejects(run('owner', 'ajouter', OWNER, member(OTHERBOT)), /bot/);
  await assert.rejects(run('owner', 'ajouter', OWNER, member(HUMAN2)), /pas sur le serveur/);
  // 25 au plus.
  const many = Array.from({ length: 25 }, (_, i) => String(BigInt('300000000000000000') + BigInt(i)));
  w.config.update(G, { secur: { owners: many } });
  await assert.rejects(run('owner', 'ajouter', OWNER, member(MEMBER)), /25/);
  await run('owner', 'retirer', OWNER, member(many[0]));
  assert.equal(w.config.get(G).secur.owners.length, 24);
  w.config.update(G, { secur: { owners: [SECOWNER] } });
  // Confiance : niveau owner, bots présents seulement.
  await assert.rejects(run('confiance', 'ajouter', ADMIN, member(OTHERBOT)), { name: 'UserError' });
  await assert.rejects(run('confiance', 'ajouter', SECOWNER, member(MEMBER)), /n'est pas un bot/);
  await run('confiance', 'ajouter', SECOWNER, member(OTHERBOT));
  assert.deepEqual(w.config.get(G).secur.trustedBots, [OTHERBOT]);
  // Liste : lecture (administrateur).
  const list = fake(w, { user: ADMIN, options: opts('liste', {}, 'confiance') });
  await secur.execute(list, w.client);
  assert.match(text(list.calls.reply[0]), new RegExp(OTHERBOT));
  // Menus du panneau : owners (propriétaire, humains) et confiance (bots).
  const users = new Collection([[OTHERBOT, w.members.get(OTHERBOT).user], [MEMBER, w.members.get(MEMBER).user]]);
  const resolved = new Collection([[OTHERBOT, w.members.get(OTHERBOT)], [MEMBER, w.members.get(MEMBER)]]);
  await assert.rejects(secur.buttons.owners(fake(w, { values: [OTHERBOT], users, members: resolved }), w.client), /bot/);
  await assert.rejects(secur.buttons.owners(fake(w, { user: SECOWNER, values: [MEMBER], users, members: resolved }), w.client), /propriétaire du serveur/);
  await secur.buttons.owners(fake(w, { values: [MEMBER], users, members: resolved }), w.client);
  assert.deepEqual(w.config.get(G).secur.owners, [MEMBER]);
  await assert.rejects(secur.buttons.trust(fake(w, { values: [MEMBER], users, members: resolved }), w.client), /n'est pas un bot/);
  await assert.rejects(secur.buttons.owners(fake(w, { values: [HUMAN2], users, members: resolved }), w.client), /pas sur le serveur/);
});

// ---------------------------------------------------------------- accès et alertes

test('raid ping : @everyone et rôles gérés refusés ; avertissement si non mentionnable ou plus de 50 membres', async () => {
  const w = world();
  w.secur.journal = async () => {};
  await assert.rejects(secur.buttons.raidping(fake(w, { values: [G] }), w.client), /@everyone/);
  await assert.rejects(secur.buttons.raidping(fake(w, { values: [R_MANAGED] }), w.client), /géré/);
  assert.equal(w.config.get(G).secur.raidPingRoleId, null);
  const ok = fake(w, { values: [R_PING] });
  await secur.buttons.raidping(ok, w.client);
  assert.equal(w.config.get(G).secur.raidPingRoleId, R_PING);
  const role = w.roles.get(R_PING);
  role.mentionable = false;
  for (let i = 0; i < 51; i += 1) role.members.set(String(i), {});
  const warn = V.raidPingWarnings({ raidRole: { id: R_PING, mention: `<@&${R_PING}>`, mentionable: false, members: 51 }, botPerms: new PermissionsBitField(0n) });
  assert.equal(warn.length, 2);
  assert.equal(V.raidPingWarnings({ raidRole: { id: R_PING, mention: 'x', mentionable: false, members: 3 }, botPerms: new PermissionsBitField(P.MentionEveryone) }).length, 0);
  // Vide : retiré.
  await secur.buttons.raidping(fake(w, { values: [] }), w.client);
  assert.equal(w.config.get(G).secur.raidPingRoleId, null);
});

test('accès : verrou, MP (seul le propriétaire coupe les siens), bot auteur ; journal appelé APRÈS la réponse', async () => {
  const w = world();
  w.config.update(G, { secur: { owners: [SECOWNER] } });
  w.addMember(SECOWNER);
  const order = [];
  w.secur.journal = async (_g, entry) => void order.push(['journal', entry]);
  const i = fake(w, { user: SECOWNER });
  i.update = async (p) => void order.push(['update', p]);
  await secur.buttons.verrou(i, w.client, ['on']);
  assert.equal(w.config.get(G).secur.verrou, true);
  assert.deepEqual(order.map(([k]) => k), ['update', 'journal']);
  assert.deepEqual(order[1][1].before, { secur: { verrou: false } });
  assert.deepEqual(order[1][1].after, { secur: { verrou: true } });
  await assert.rejects(secur.buttons.notify(fake(w, { user: SECOWNER }), w.client, ['off']), /propriétaire du serveur/);
  await secur.buttons.notify(fake(w, { user: OWNER }), w.client, ['off']);
  assert.equal(w.config.get(G).secur.notifyOwner, false);
  await secur.buttons.notify(fake(w, { user: SECOWNER }), w.client, ['on']);
  assert.equal(w.config.get(G).secur.notifyOwner, true);
  await secur.buttons.botexec(fake(w, { values: ['never'] }), w.client);
  assert.equal(w.config.get(G).secur.botExecutor, 'never');
  await assert.rejects(secur.buttons.botexec(fake(w, { values: ['toString'] }), w.client), { name: 'UserError' });
  await assert.rejects(secur.buttons.verrou(fake(w), w.client, ['peut-être']), { name: 'UserError' });
});

test('module : mode, sanction, annulation, seuil et fenêtre (formulaire), slash /secur module', async () => {
  const w = world({ modules: ['channelDelete', 'kick', 'messagePurge'] });
  const journals = [];
  w.secur.journal = async (_g, e) => void journals.push(e);
  await secur.buttons.mode(fake(w, { values: ['on'] }), w.client, ['channelDelete']);
  await secur.buttons.punish(fake(w, { values: ['kick'] }), w.client, ['channelDelete']);
  await secur.buttons.undo(fake(w), w.client, ['channelDelete', 'off']);
  const modal = fake(w);
  await secur.buttons.limits(modal, w.client, ['channelDelete']);
  const m = json(modal.calls.modal[0]);
  assert.equal(m.custom_id, 'cmd:secur:limitsubmit:channelDelete');
  for (const row of m.components) for (const c of row.components) assert.ok(c.label.length <= 45, c.label);
  await secur.buttons.limitsubmit(fake(w, { fields: { limit: '4', windowSeconds: '' } }), w.client, ['channelDelete']);
  let mc = S.moduleConfig(w.config.get(G), 'channelDelete');
  assert.deepEqual([mc.mode, mc.punish, mc.undo, mc.limit, mc.windowSeconds], ['on', 'kick', false, 4, 10]);
  for (const bad of [{ limit: '0' }, { limit: '101' }, { windowSeconds: '3601' }, { limit: '2.5' }]) {
    await assert.rejects(secur.buttons.limitsubmit(fake(w, { fields: bad }), w.client, ['channelDelete']), { name: 'UserError' });
  }
  await assert.rejects(secur.buttons.limitsubmit(fake(w, { fields: {} }), w.client, ['channelDelete']), /Aucune valeur/);
  // Module non annulable : pas de bouton d'annulation, refus du forgé.
  await assert.rejects(secur.buttons.undo(fake(w), w.client, ['kick', 'on']), /annulées/);
  // Formulaire du module messagePurge : messages minimum.
  const mp = fake(w);
  await secur.buttons.limits(mp, w.client, ['messagePurge']);
  assert.ok(json(mp.calls.modal[0]).components.some((r) => r.components[0].custom_id === 'minMessages'));
  // Slash.
  const slash = fake(w, { options: opts('module', { module: 'kick', mode: 'max', punition: 'ban', seuil: 2, fenetre: 30 }) });
  await secur.execute(slash, w.client);
  mc = S.moduleConfig(w.config.get(G), 'kick');
  assert.deepEqual([mc.mode, mc.punish, mc.limit, mc.windowSeconds], ['max', 'ban', 2, 30]);
  assert.equal(slash.calls.reply[0].ephemeral, true);
  await assert.rejects(secur.execute(fake(w, { options: opts('module', { module: 'roleDelete', mode: 'on' }) }), w.client), /pas disponible/);
  await assert.rejects(secur.execute(fake(w, { options: opts('module', { module: 'kick', mode: 'on', annulation: true }) }), w.client), /annulées/);
  assert.ok(journals.length >= 5);
  assert.ok(journals.every((j) => j.before.secur.modules && j.after.secur.modules));
});

test('journal et accès en attente du panneau : gestionnaires de SEC1 (restore, decideGrant)', async () => {
  const w = world();
  const called = [];
  w.secur.restore = async (_i, id) => void called.push(['restore', id]);
  w.secur.decideGrant = async (_i, id, action) => void called.push([action, id]);
  const id = w.incidents.create({ guildId: G, executorId: ADMIN, modules: ['channelDelete'], actions: 3, punishment: 'derank', removedRoles: [R_ADMIN] });
  const g = w.grants.create({ guildId: G, kind: 'user', subjectId: MEMBER, grantedBy: ADMIN });
  const journal = V.renderView(stateOf(w), 'journal');
  assert.ok(ids(journal).includes('cmd:secur:restore'));
  const pending = V.renderView(stateOf(w), 'attente');
  assert.ok(ids(pending).includes('cmd:secur:grantdecide'));
  await secur.buttons.restore(fake(w, { values: [String(id)] }), w.client);
  await secur.buttons.grantdecide(fake(w, { values: [`approve.${g.id}`] }), w.client);
  await secur.buttons.grantdecide(fake(w, { values: [`revoke.${g.id}`] }), w.client);
  assert.deepEqual(called, [['restore', id], ['approve', g.id], ['revoke', g.id]]);
  for (const bad of ['abc', '-1', '__proto__']) await assert.rejects(secur.buttons.restore(fake(w, { values: [bad] }), w.client), { name: 'UserError' });
  for (const bad of ['approve.x', 'delete.1', 'approve']) await assert.rejects(secur.buttons.grantdecide(fake(w, { values: [bad] }), w.client), { name: 'UserError' });
  // Lecture seule : aucun menu pour un administrateur non-owner.
  assert.ok(!ids(V.renderView(stateOf(w, ADMIN), 'journal')).includes('cmd:secur:restore'));
  assert.ok(!ids(V.renderView(stateOf(w, ADMIN), 'attente')).includes('cmd:secur:grantdecide'));
  // Incident restauré : plus proposé.
  assert.equal(V.restorable({ punishment: 'derank', removed_roles: [R_ADMIN], restored_at: 1 }), false);
  assert.equal(V.restorable({ punishment: 'derank', removed_roles: [] }), false);
  assert.equal(V.restorable({ punishment: 'ban' }), true);
});

// ---------------------------------------------------------------- /antiraid et /whitelist

/** Interaction /whitelist add. */
function wlAdd(w, user, target) {
  const u = { id: target, toString: () => `<@${target}>` };
  return fake(w, { user, options: { getSubcommand: () => 'add', getUser: () => u, getRole: () => null } });
}

test('verrou : /whitelist add et antiraid toggle refusés à un admin, acceptés pour le propriétaire ; navigation ouverte', async () => {
  const w = world();
  w.config.update(G, { secur: { verrou: true }, antiraid: { enabled: true } });
  await assert.rejects(whitelist.execute(wlAdd(w, ADMIN, MEMBER), w.client), /Verrou de Secur actif/);
  await assert.rejects(antiraid.buttons.toggle(fake(w, { user: ADMIN }), w.client, ['off']), /Verrou de Secur actif/);
  for (const name of ['antibot', 'action', 'newaccount', 'executor', 'set', 'setsubmit', 'alertch', 'wlusers', 'wlroles', 'preset']) {
    await assert.rejects(antiraid.buttons[name](fake(w, { user: ADMIN, values: ['kick'], fields: {} }), w.client, ['joins']), /Verrou/, name);
  }
  assert.equal(w.config.get(G).antiraid.enabled, true);
  assert.deepEqual(w.config.get(G).whitelist.users, []);
  // Navigation, simulation : ouvertes.
  await antiraid.buttons.go(fake(w, { user: ADMIN }), w.client, ['whitelist']);
  await antiraid.buttons.simulate(fake(w, { user: ADMIN }), w.client);
  // Propriétaire : accepté.
  await antiraid.buttons.toggle(fake(w), w.client, ['off']);
  assert.equal(w.config.get(G).antiraid.enabled, false);
  await whitelist.execute(wlAdd(w, OWNER, MEMBER), w.client);
  assert.deepEqual(w.config.get(G).whitelist.users, [MEMBER]);
  // /whitelist list reste ouvert.
  const list = fake(w, { user: ADMIN, options: { getSubcommand: () => 'list' } });
  await whitelist.execute(list, w.client);
  assert.equal(list.calls.reply.length, 1);
});

test('accès en attente : /whitelist add par un admin → recordGrant (n\'exempte pas) ; par le propriétaire → aucun ; blacklisté refusé', async () => {
  const w = world();
  const grants = [];
  const real = w.secur.recordGrant.bind(w.secur);
  w.secur.recordGrant = (guild, g) => {
    grants.push(g);
    return real(guild, g);
  };
  const add = wlAdd(w, ADMIN, MEMBER);
  await whitelist.execute(add, w.client);
  assert.deepEqual(grants, [{ kind: 'user', subjectId: MEMBER, grantedBy: ADMIN }]);
  assert.match(text(add.calls.reply[0]), /attente d'approbation/);
  assert.deepEqual(w.config.get(G).whitelist.users, [MEMBER], 'whitelist écrite normalement');
  assert.equal(w.antiraid.isWhitelisted(G, MEMBER, [], { excludePending: true }), false, 'accès en attente exemptant');
  assert.ok(w.posts.some((p) => /Accès de whitelist en attente/.test(text(p))), 'carte critique absente');
  // Propriétaire : aucun accès en attente.
  await whitelist.execute(wlAdd(w, OWNER, HUMAN2), w.client);
  assert.equal(grants.length, 1);
  // Menus du tableau de bord /antiraid.
  await antiraid.buttons.wlroles(fake(w, { user: ADMIN, values: [R_PING] }), w.client);
  assert.deepEqual(grants[1], { kind: 'wlrole', subjectId: R_PING, grantedBy: ADMIN });
  // Blacklist (SEC3, optionnelle) : refusée.
  w.client.services.blacklist = { has: (g, id) => g === G && id === OTHERBOT };
  await assert.rejects(whitelist.execute(wlAdd(w, OWNER, OTHERBOT), w.client), /blacklist/);
  await assert.rejects(antiraid.buttons.wlusers(fake(w, { values: [OTHERBOT] }), w.client), /blacklist/);
});

test('/antiraid : bouton « Anti-nuke » (5e de la rangée d\'index 1), mention « géré par Secur » et « la whitelist ne protège pas en mode max »', async () => {
  const w = world({ modules: ['channelDelete'] });
  const home = antiraid.render(w.client, w.guild, 'home');
  const row = json(home.components[1]).components;
  assert.equal(row.length, 5);
  assert.equal(row[4].custom_id, 'cmd:secur:open:home');
  assert.equal(typeof secur.buttons.open, 'function');
  assert.doesNotMatch(text(antiraid.render(w.client, w.guild, 'destructive')), /Géré par Secur/);
  w.config.update(G, { secur: { modules: { channelDelete: { mode: 'max' } } } });
  const destructive = text(antiraid.render(w.client, w.guild, 'destructive'));
  assert.match(destructive, /Géré par Secur/);
  assert.match(destructive, /mode max/);
  assert.match(destructive, /whitelist ne protège pas en mode max/);
  assert.match(text(antiraid.render(w.client, w.guild, 'whitelist')), /whitelist ne protège pas en mode max/);
});

test('journal /antiraid : tranches avant / après passées au journal de Secur (désactivation critique)', async () => {
  const w = world();
  const entries = [];
  w.secur.journal = async (_g, e) => void entries.push(e);
  w.config.update(G, { antiraid: { enabled: true } });
  await antiraid.buttons.toggle(fake(w, { user: ADMIN }), w.client, ['off']);
  assert.deepEqual(entries[0].before, { antiraid: { enabled: true } });
  assert.deepEqual(entries[0].after, { antiraid: { enabled: false } });
  assert.equal(entries[0].actorId, ADMIN);
  const { classifyCritical } = require('../src/services/secur/journal');
  assert.deepEqual(classifyCritical(entries[0].before, entries[0].after), ['AntiRaid désactivé']);
  await antiraid.buttons.setsubmit(fake(w, { user: ADMIN, fields: { channelDeleteThreshold: '0' } }), w.client, ['destructive']);
  assert.match(classifyCritical(entries[1].before, entries[1].after).join(), /désactivé \(0\)/);
});
