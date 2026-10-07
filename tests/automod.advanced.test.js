'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, Collection, ChannelType } = require('discord.js');
const automod = require('../src/commands/automod/automod');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { AutomodEventRepository } = require('../src/database/repositories/AutomodEventRepository');
const { AutoModService, effectiveFilters, isFilterExempt, attachmentsFingerprint, mostSevere } = require('../src/services/AutoModService');
const { phishingScore, maskedLinks } = require('../src/utils/automod/phishing');
const { matchingWords } = require('../src/utils/automod/words');
const { PRESETS } = require('../src/utils/automod/presets');
const { defaultGuildConfig } = require('../src/config/defaults');
const native = require('../src/services/NativeAutoMod');

const G = '100000000000000001';
const U = '200000000000000001';
const MOD = '200000000000000009';
const BOT = '999999999999999999';
const C1 = '300000000000000001';
const C2 = '300000000000000002';
const C3 = '300000000000000003';
const R1 = '400000000000000001';
const R2 = '400000000000000002';
const LOG = '500000000000000001';

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const ids = (rows) => (rows ?? []).flatMap((r) => json(r).components.map((c) => c.custom_id).filter(Boolean));
const perms = (...flags) => new PermissionsBitField(flags.length ? flags.map((f) => PermissionsBitField.Flags[f]) : 0n);

// ---------------------------------------------------------------- 1. liens masqués

test('liens masqués : texte affichant un autre domaine que la cible → +3 avec raison claire', () => {
  const r = phishingScore('[discord.com/gift](https://evil.ru)');
  assert.ok(r.score >= 3);
  assert.ok(r.reasons.some((x) => /lien masqué.*discord\.com.*evil\.ru/.test(x)), r.reasons.join(' | '));
  assert.deepEqual(maskedLinks('[www.steamcommunity.com](<https://steamcommunity.com.evil.ru/trade>)'), [{ shown: 'steamcommunity.com', host: 'steamcommunity.com.evil.ru' }]);
  // Seul, le lien masqué atteint le seuil par défaut de l'anti-arnaques.
  assert.ok(phishingScore('[site.com](https://autre-site.net/x)').score >= 3);
});

test('liens masqués : texte libre, même domaine ou cible officielle → rien', () => {
  for (const t of [
    '[clique ici](https://youtube.com)',
    '[youtube.com](https://www.youtube.com/watch?v=1)',
    '[site.fr/page](https://blog.site.fr/page)',
    '[discord.gg/abc](https://discord.com/invite/abc)',
    '[ma vidéo](<https://youtu.be/x>)',
  ]) {
    assert.deepEqual(maskedLinks(t), [], t);
    assert.equal(phishingScore(t).score, 0, t);
  }
  // Cible autorisée par le serveur : pas de tromperie dangereuse.
  assert.deepEqual(maskedLinks('[google.com](https://monsite.fr)', ['monsite.fr']), []);
});

test('moteur : un lien masqué déclenche l\'anti-arnaques', () => {
  const s = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const hit = s.inspect({ id: 'm', guild: { id: G }, author: { id: U }, channel: { id: C1 }, content: 'Nitro : [discord.com/nitro](https://claim-now.xyz)' }, { antiPhishing: { enabled: true, threshold: 3 } }, { temporal: false });
  assert.equal(hit?.filter, 'antiPhishing');
  assert.match(hit.detail, /lien masqué/);
});

// ---------------------------------------------------------------- 4. exemptions par filtre

test('exemptions par filtre : salon, fil d\'un salon exempté et rôle', () => {
  const fc = { enabled: true, exemptChannels: [C1], exemptRoles: [R1] };
  const roles = (list) => ({ cache: { some: (fn) => list.some((id) => fn({ id })) } });
  assert.ok(isFilterExempt(fc, { channel: { id: C1 } }));
  assert.ok(isFilterExempt(fc, { channel: { id: 'fil', parentId: C1 } }));
  assert.ok(isFilterExempt(fc, { channel: { id: C2 }, member: { roles: roles([R1]) } }));
  assert.ok(!isFilterExempt(fc, { channel: { id: C2 }, member: { roles: roles([R2]) } }));
  assert.ok(!isFilterExempt({ enabled: true }, { channel: { id: C1 } }));
  const filters = { antiLink: fc, antiCaps: { enabled: true } };
  const eff = effectiveFilters(filters, { channel: { id: C1 } });
  assert.equal(eff.antiLink.enabled, false);
  assert.equal(eff.antiCaps.enabled, true);
  assert.equal(filters.antiLink.enabled, true, 'la configuration n\'est jamais modifiée');
  assert.equal(effectiveFilters(filters, { channel: { id: C2 } }), filters, 'aucune copie inutile');
});

test('exemptions par filtre : liens autorisés dans #médias, toujours bloqués ailleurs', () => {
  const s = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const filters = { antiLink: { enabled: true, exemptChannels: [C1] }, antiInvite: { enabled: true } };
  const m = (channelId, content) => ({ id: 'x', guild: { id: G }, author: { id: U }, channel: { id: channelId }, content });
  assert.equal(s.inspect(m(C1, 'https://evil.ru/x'), filters, { temporal: false }), null);
  assert.equal(s.inspect(m(C2, 'https://evil.ru/x'), filters, { temporal: false })?.filter, 'antiLink');
  // Les autres filtres restent actifs dans le salon exempté de l'anti-liens.
  assert.equal(s.inspect(m(C1, 'discord.gg/arnaque'), filters, { temporal: false })?.filter, 'antiInvite');
});

// ---------------------------------------------------------------- 3. compte piraté

test('empreinte des pièces jointes : nom + taille + type, ordre indifférent', () => {
  const a = { name: 'Free.png', size: 10, contentType: 'image/png' };
  const b = { name: 'nitro.exe', size: 99, contentType: 'application/octet-stream' };
  assert.equal(attachmentsFingerprint(new Map([['1', a], ['2', b]])), attachmentsFingerprint([b, { ...a, name: 'free.png' }]));
  assert.notEqual(attachmentsFingerprint([a]), attachmentsFingerprint([{ ...a, size: 11 }]));
  assert.equal(attachmentsFingerprint(new Map()), '');
  assert.equal(attachmentsFingerprint(undefined), '');
});

let seq = 0;
const nextId = () => String(600000000000000000n + BigInt(++seq));
function hmsg(content, channelId, extra = {}) {
  return { id: nextId(), guild: { id: G }, author: { id: U, createdTimestamp: 0 }, channel: { id: channelId }, content, ...extra };
}

test('compte piraté : même lot de fichiers dans 3 salons → quarantaine (copies jointes)', () => {
  const s = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const filters = { antiHacked: { enabled: true, channels: 3, windowSeconds: 60 } };
  const files = () => new Map([['a', { name: 'screen.png', size: 1234, contentType: 'image/png' }]]);
  assert.equal(s.inspect(hmsg('', C1, { attachments: files() }), filters), null);
  assert.equal(s.inspect(hmsg('', C2, { attachments: files() }), filters), null);
  const hit = s.inspect(hmsg('', C3, { attachments: files() }), filters);
  assert.equal(hit.filter, 'antiHacked');
  assert.equal(hit.action, 'quarantine', 'action par défaut');
  assert.equal(hit.related.length, 2);
  // Fichier différent dans chaque salon : rien.
  const s2 = new AutoModService({ config: {}, logging: {}, moderation: {} });
  for (const [i, c] of [C1, C2, C3].entries()) {
    assert.equal(s2.inspect(hmsg('', c, { attachments: new Map([['a', { name: `img${i}.png`, size: i, contentType: 'image/png' }]]) }), filters), null);
  }
});

test('compte piraté : même message dans N salons, ou lien d\'arnaque à score élevé', () => {
  const s = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const filters = {
    antiHacked: { enabled: true, channels: 3, windowSeconds: 60, minLength: 20, scamScore: 5, action: 'quarantine', duration: '1d' },
    antiCrossChannel: { enabled: true, channels: 3, windowSeconds: 60, minLength: 12, action: 'timeout', duration: '1h' },
  };
  const text = 'Salut tout le monde, regardez ce super site incroyable';
  s.inspect(hmsg(text, C1), filters);
  s.inspect(hmsg(text, C2), filters);
  const hit = s.inspect(hmsg(text, C3), filters);
  assert.equal(hit.filter, 'antiHacked', 'la quarantaine l\'emporte sur le spam multi-salons');
  assert.equal(hit.related.length, 2);
  assert.equal(mostSevere([{ action: 'kick' }, { action: 'quarantine' }]).action, 'quarantine');

  const scam = s.inspect(hmsg('@everyone free nitro https://discord-gift.com/claim', C1), { antiHacked: filters.antiHacked }, { temporal: false });
  assert.equal(scam?.filter, 'antiHacked');
  assert.match(scam.detail, /lien d'arnaque \(score \d+\)/);
  // Score insuffisant : pas de quarantaine.
  assert.equal(s.inspect(hmsg('https://bit.ly/abc', C1), { antiHacked: filters.antiHacked }, { temporal: false }), null);
});

test('compte piraté seul : le spam multi-salons garde son comportement sans le nouveau filtre', () => {
  const s = new AutoModService({ config: {}, logging: {}, moderation: {} });
  const filters = { antiCrossChannel: { enabled: true, channels: 2, windowSeconds: 60, minLength: 5, action: 'delete' } };
  s.inspect(hmsg('bonjour à tous', C1), filters);
  const hit = s.inspect(hmsg('bonjour à tous', C2), filters);
  assert.equal(hit.filter, 'antiCrossChannel');
  assert.equal(s.tracker.get(`${G}:${U}`).posted, undefined, 'pas de suivi des messages si antiHacked est coupé');
});

/** Faux serveur pour la quarantaine : salons avec suppression unitaire / groupée, rôles. */
function quarantineWorld({ removeRoles = false, purgeMinutes = 10 } = {}) {
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
  const channels = new Collection([[C1, channel(C1)], [C2, channel(C2)], [C3, channel(C3)]]);
  const roleRemoved = [];
  const memberRoles = new Collection([
    [G, { id: G }],
    [R1, { id: R1, managed: false, editable: true }],
    [R2, { id: R2, managed: true, editable: true }],
  ]);
  const member = {
    id: U,
    permissions: { has: () => false },
    roles: { cache: memberRoles, remove: async (list) => roleRemoved.push(...list) },
  };
  const calls = { timeout: [] };
  const moderation = { timeout: async (...a) => { calls.timeout.push(a); return { id: 77 }; } };
  const logs = [];
  const cfg = {
    enabled: true, ignoredChannels: [], ignoredRoles: [], notify: 'none',
    escalation: { enabled: true, windowMinutes: 30, steps: [{ count: 2, action: 'kick' }] },
    filters: { antiHacked: { enabled: true, channels: 3, windowSeconds: 60, minLength: 20, scamScore: 5, action: 'quarantine', duration: '1d', purgeMinutes, removeRoles } },
  };
  const { db } = memoryDb();
  const events = new AutomodEventRepository(db);
  const service = new AutoModService({
    config: { get: () => ({ moderation: { dmOnSanction: true }, automod: cfg }) },
    logging: { send: async (...a) => logs.push(a), suppressMessage: () => {} },
    moderation,
    events,
  });
  const guild = { id: G, members: { me: { id: BOT } }, channels: { cache: channels } };
  const make = (content, channelId) => ({
    id: nextId(),
    guild,
    author: { id: U, bot: false, createdTimestamp: 0, toString: () => `<@${U}>`, displayAvatarURL: () => null },
    member,
    channel: channels.get(channelId),
    content,
    delete: async function del() { deleted.push([channelId, this.id]); },
  });
  return { service, make, deleted, calls, logs, roleRemoved, events };
}

test('quarantaine : timeout 1 j, messages récents supprimés partout, log d\'alerte avec boutons', async () => {
  const w = quarantineWorld();
  const normal = w.make('message normal sans rapport', C2);
  await w.service.handleMessage(normal);
  await w.service.handleMessage(w.make('un autre message tout à fait normal', C3));
  assert.equal(w.logs.length, 0);
  await w.service.handleMessage(w.make('@everyone free nitro https://discord-gift.com/claim', C1));

  assert.equal(w.calls.timeout.length, 1);
  assert.equal(w.calls.timeout[0][4], 86_400_000);
  assert.match(w.calls.timeout[0][3], /quarantaine/);
  // Message déclencheur + 2 messages récents dans 2 autres salons.
  assert.equal(w.deleted.length, 3);
  assert.ok(w.deleted.some(([c, m]) => c === C2 && m === normal.id));
  assert.equal(w.logs.length, 1);
  const [, category, embed, components] = w.logs[0];
  assert.equal(category, 'automod');
  const e = embed.toJSON();
  assert.match(e.title, /quarantaine/);
  assert.match(e.fields.find((f) => f.name.includes('Messages supprimés')).value, /\*\*3\*\* · 2 salon/);
  assert.deepEqual(ids(components), [`cmd:automod:qlift:${U}`, `cmd:automod:qban:${U}`, `cmd:sanctions:history:${U}`]);
  for (const id of ids(components).filter((x) => x.startsWith('cmd:automod:'))) assert.equal(typeof automod.buttons[id.split(':')[2]], 'function');
  assert.equal(w.events.stats(G, 0).byAction[0].action, 'quarantine');
  assert.ok(!e.fields.some((f) => f.name.includes('Rôles retirés')), 'rôles conservés par défaut');
});

test('quarantaine : rôles retirés (option) et mémorisés dans le log ; rafale fusionnée', async () => {
  const w = quarantineWorld({ removeRoles: true });
  const scam = '@everyone free nitro https://discord-gift.com/claim';
  await Promise.all([w.service.handleMessage(w.make(scam, C1)), w.service.handleMessage(w.make(scam, C2))]);
  assert.deepEqual(w.roleRemoved, [R1], 'ni @everyone ni les rôles gérés');
  assert.equal(w.calls.timeout.length, 1, 'une seule quarantaine pour la rafale');
  assert.equal(w.logs.length, 1);
  const roles = w.logs[0][2].toJSON().fields.find((f) => f.name.includes('Rôles retirés'));
  assert.equal(roles.value, `<@&${R1}>`);
});

// ---------------------------------------------------------------- 2. faux positif

function dashboardWorld() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const events = new AutomodEventRepository(db);
  const guild = {
    id: G,
    name: 'Serveur test',
    ownerId: '200000000000000000',
    autoModerationRules: { fetch: async () => new Map() },
    members: { me: { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache: new Collection([[C1, { id: C1, type: ChannelType.GuildText }], [C2, { id: C2, type: ChannelType.GuildText }]]) },
    roles: { cache: new Collection([[R1, { id: R1, position: 1, managed: false, editable: true }], [R2, { id: R2, position: 50, managed: false, editable: true }]]) },
  };
  const calls = { removeTimeout: [], ban: [], dm: [], rolesAdded: [] };
  const target = {
    id: U,
    isCommunicationDisabled: () => true,
    roles: { cache: new Collection(), add: async (list) => calls.rolesAdded.push(...list) },
  };
  guild.members.fetch = async (id) => (id === U ? target : null);
  const user = { id: U, username: 'bob', toString: () => `<@${U}>`, send: async (p) => calls.dm.push(p) };
  const automodService = new AutoModService({ config, logging: {}, moderation: {}, events });
  const client = {
    user: { id: BOT },
    services: {
      config,
      automod: automodService,
      moderation: {
        removeTimeout: async (...a) => { calls.removeTimeout.push(a); return { ok: true }; },
        ban: async (...a) => { calls.ban.push(a); return { id: 5 }; },
      },
    },
    repositories: { automodEvents: events },
    guilds: { cache: new Map([[G, guild]]) },
    users: { fetch: async (id) => (id === U ? user : null) },
  };
  return { client, guild, config, events, calls, automodService };
}

/** Fausse interaction de bouton (réponses enregistrées). */
function fakeInteraction(w, { customId, message, permissions, values, fields } = {}) {
  const out = { updates: [], edits: [], replies: [], followUps: [] };
  const i = {
    customId,
    guildId: G,
    guild: w.guild,
    user: { id: MOD, username: 'modo', tag: 'modo' },
    member: { id: MOD, roles: { highest: { position: 10 } } },
    memberPermissions: permissions,
    message,
    values,
    fields,
    channel: { messages: { fetch: async () => null } },
    deferred: false,
    deferUpdate: async () => { i.deferred = true; },
    update: async (p) => out.updates.push(p),
    editReply: async (p) => out.edits.push(p),
    reply: async (p) => out.replies.push(p),
    followUp: async (p) => out.followUps.push(p),
    showModal: async (m) => out.replies.push({ modal: m }),
  };
  return { i, out };
}

/** Carte de log AutoMod réelle (produite par le service) pour un message et un filtre. */
async function realLog(w, { content, filter, action = 'delete' }) {
  const logs = [];
  const svc = new AutoModService({
    config: { get: () => ({ moderation: { dmOnSanction: false }, automod: { enabled: true, ignoredChannels: [], ignoredRoles: [], notify: 'none', escalation: { enabled: false }, filters: { [filter]: { enabled: true, action, duration: '10m', words: ['con', 'arnaque*'] } } } }) },
    logging: { send: async (...a) => logs.push(a) },
    moderation: { timeout: async () => ({ id: 3 }) },
    events: w.events,
  });
  await svc.handleMessage({
    id: nextId(),
    guild: { id: G, members: { me: { id: BOT } }, channels: { cache: new Map() } },
    author: { id: U, bot: false, createdTimestamp: 0, toString: () => `<@${U}>`, displayAvatarURL: () => null },
    member: { permissions: { has: () => false }, roles: { cache: { some: () => false } } },
    channel: { id: C1, toString: () => `<#${C1}>` },
    content,
    delete: async () => {},
  });
  const [, , embed, components] = logs[0];
  const fpId = ids(components).find((x) => x.startsWith('cmd:automod:fp:'));
  return { message: { id: LOG, embeds: [embed.toJSON()], components: components.map(json) }, fpId };
}

test('faux positif : bouton présent sur le log seulement quand l\'infraction est enregistrée', async () => {
  const w = dashboardWorld();
  const { fpId, message } = await realLog(w, { content: 'regarde https://monblog.fr/post', filter: 'antiLink' });
  assert.match(fpId, /^cmd:automod:fp:\d+$/);
  assert.equal(typeof automod.buttons.fp, 'function');
  assert.equal(automod.logMessageContent(message), 'regarde https://monblog.fr/post');
  assert.equal(automod.footerUserId(message), U);
});

test('faux positif : infraction supprimée, timeout levé, domaine proposé puis autorisé, message renvoyé en MP', async () => {
  const w = dashboardWorld();
  w.config.update(G, { automod: { filters: { antiLink: { enabled: true, allowedDomains: ['youtube.com'] } } } });
  const { fpId, message } = await realLog(w, { content: 'regarde https://monblog.fr/post et https://youtube.com/x', filter: 'antiLink', action: 'timeout' });
  assert.equal(w.events.countRecent(G, U, 0), 1);
  w.automodService.lastSanction.set(`${G}:${U}`, { at: Date.now(), severity: 1 });

  const { i, out } = fakeInteraction(w, { customId: fpId, message, permissions: perms('ManageGuild', 'ModerateMembers') });
  await automod.buttons.fp(i, w.client, fpId.split(':').slice(3));
  assert.equal(w.events.countRecent(G, U, 0), 0, 'infraction retirée du compteur de récidive');
  assert.equal(w.automodService.lastSanction.size, 0);
  assert.equal(w.calls.removeTimeout.length, 1);
  assert.equal(w.calls.removeTimeout[0][2].id, MOD, 'levé au nom du modérateur (hiérarchie vérifiée)');
  // Bouton du log figé, vue éphémère envoyée.
  const settled = out.edits[0].components.flatMap((r) => r.components).find((c) => c.custom_id === fpId);
  assert.ok(settled.disabled);
  const view = out.followUps[0];
  assert.equal(view.ephemeral, true);
  const viewIds = ids(view.components);
  assert.deepEqual(viewIds, ['cmd:automod:fpfix:1', `cmd:automod:fpdm:${U}`], 'youtube.com déjà autorisé : seul monblog.fr est proposé');
  for (const id of viewIds) assert.equal(typeof automod.buttons[id.split(':')[2]], 'function');
  const viewEmbed = json(view.embeds[0]);
  assert.match(viewEmbed.description, /Timeout \*\*levé\*\*/);

  // Deuxième clic sur le log : l'infraction n'existe plus.
  await assert.rejects(automod.buttons.fp(fakeInteraction(w, { customId: fpId, message, permissions: perms('ManageMessages') }).i, w.client, fpId.split(':').slice(3)), { name: 'UserError' });

  // Correctif en un clic (relu dans la vue éphémère, pas dans le customId).
  const viewMessage = { embeds: [viewEmbed], components: view.components.map(json) };
  const fix = fakeInteraction(w, { customId: 'cmd:automod:fpfix:1', message: viewMessage, permissions: perms('ManageGuild') });
  await automod.buttons.fpfix(fix.i, w.client, ['1']);
  assert.deepEqual(w.config.get(G).automod.filters.antiLink.allowedDomains, ['youtube.com', 'monblog.fr']);
  await assert.rejects(automod.buttons.fpfix(fix.i, w.client, ['1']), { name: 'UserError' }, 'déjà autorisé');
  await assert.rejects(automod.buttons.fpfix(fix.i, w.client, ['9']), { name: 'UserError' });
  await assert.rejects(automod.buttons.fpfix(fakeInteraction(w, { message: viewMessage, permissions: perms('ManageMessages') }).i, w.client, ['1']), { name: 'UserError' }, 'liste blanche : « Gérer le serveur »');

  // Renvoi en MP.
  const dm = fakeInteraction(w, { customId: `cmd:automod:fpdm:${U}`, message: viewMessage, permissions: perms('ManageMessages') });
  await automod.buttons.fpdm(dm.i, w.client, [U]);
  assert.equal(w.calls.dm.length, 1);
  assert.match(json(w.calls.dm[0].embeds[0]).fields[0].value, /monblog\.fr/);
  await assert.rejects(automod.buttons.fpdm(dm.i, w.client, ['200000000000000002']), { name: 'UserError' }, 'membre différent de la vue');
});

test('faux positif : mot interdit retiré de la liste en un clic ; sans « Exclure » le timeout reste', async () => {
  const w = dashboardWorld();
  w.config.update(G, { automod: { filters: { badWords: { enabled: true, words: ['con', 'arnaque*', 'autre'] } } } });
  const { fpId, message } = await realLog(w, { content: 'quel c0n, cette arnaqueuse', filter: 'badWords', action: 'timeout' });
  const { i, out } = fakeInteraction(w, { customId: fpId, message, permissions: perms('ManageGuild') });
  await automod.buttons.fp(i, w.client, fpId.split(':').slice(3));
  assert.equal(w.calls.removeTimeout.length, 0);
  const view = out.followUps[0];
  assert.match(json(view.embeds[0]).description, /Exclure temporairement/);
  assert.deepEqual(ids(view.components), ['cmd:automod:fpfix:1', 'cmd:automod:fpfix:2', `cmd:automod:fpdm:${U}`]);
  const viewMessage = { embeds: [json(view.embeds[0])], components: view.components.map(json) };
  await automod.buttons.fpfix(fakeInteraction(w, { customId: 'cmd:automod:fpfix:2', message: viewMessage, permissions: perms('ManageGuild') }).i, w.client, ['2']);
  assert.deepEqual(w.config.get(G).automod.filters.badWords.words, ['con', 'autre']);
});

test('faux positif : refusé sans permission, avec un identifiant invalide ou sur un autre log', async () => {
  const w = dashboardWorld();
  const { fpId, message } = await realLog(w, { content: 'https://monblog.fr', filter: 'antiLink' });
  const args = fpId.split(':').slice(3);
  await assert.rejects(automod.buttons.fp(fakeInteraction(w, { message, permissions: perms() }).i, w.client, args), { name: 'UserError' });
  await assert.rejects(automod.buttons.fp(fakeInteraction(w, { message, permissions: perms('ManageMessages') }).i, w.client, ['abc']), { name: 'UserError' });
  const other = { ...message, embeds: [{ ...message.embeds[0], footer: { text: 'Gadget • ID : 200000000000000005' } }] };
  await assert.rejects(automod.buttons.fp(fakeInteraction(w, { message: other, permissions: perms('ManageMessages') }).i, w.client, args), { name: 'UserError' });
  assert.equal(w.events.countRecent(G, U, 0), 1, 'rien n\'a été supprimé');
});

test('suggestions de correctifs : domaines hors liste blanche, mots de la liste ; rien sans contenu', () => {
  const cfg = { filters: { antiLink: { allowedDomains: ['ok.fr'] }, badWords: { words: ['con'] } } };
  assert.deepEqual(automod.fixSuggestions(cfg, 'antiPhishing', 'https://tenor.com/x https://ok.fr https://www.Mal.com/x'), [{ kind: 'domain', value: 'mal.com' }]);
  assert.deepEqual(automod.fixSuggestions(cfg, 'badWords', 'gros c.o.n'), [{ kind: 'word', value: 'con' }]);
  assert.deepEqual(automod.fixSuggestions(cfg, 'antiCaps', 'https://mal.com'), []);
  assert.deepEqual(automod.fixSuggestions(cfg, 'antiLink', null), []);
  assert.deepEqual(matchingWords('arnaqueur et con', ['con', 'arnaque*', 'rien']), ['con', 'arnaque*']);
});

// ---------------------------------------------------------------- quarantaine : boutons

test('lever la quarantaine : timeout retiré et rôles relus dans le log rendus (sous le modérateur)', async () => {
  const w = dashboardWorld();
  const message = {
    id: LOG,
    embeds: [{ footer: { text: `Gadget • ID : ${U}` }, fields: [{ name: '🎭 Rôles retirés', value: `<@&${R1}> <@&${R2}>` }] }],
    components: [{ type: 1, components: [{ type: 2, custom_id: `cmd:automod:qlift:${U}`, style: 3, label: 'Lever' }] }],
  };
  const { i, out } = fakeInteraction(w, { customId: `cmd:automod:qlift:${U}`, message, permissions: perms('ModerateMembers', 'ManageRoles') });
  await automod.buttons.qlift(i, w.client, [U]);
  assert.equal(w.calls.removeTimeout.length, 1);
  assert.deepEqual(w.calls.rolesAdded, [R1], 'R2 est au-dessus du modérateur');
  assert.ok(out.edits[0].components[0].components[0].disabled);
  assert.equal(out.followUps[0].ephemeral, true);
  await assert.rejects(automod.buttons.qlift(fakeInteraction(w, { message, permissions: perms('ManageMessages') }).i, w.client, [U]), { name: 'UserError' });
  await assert.rejects(automod.buttons.qlift(fakeInteraction(w, { message, permissions: perms('ModerateMembers') }).i, w.client, ['../x']), { name: 'UserError' });
});

test('bannir depuis la quarantaine : confirmation éphémère, puis bannissement via ModerationService', async () => {
  const w = dashboardWorld();
  const message = { id: LOG, embeds: [], components: [] };
  const ask = fakeInteraction(w, { customId: `cmd:automod:qban:${U}`, message, permissions: perms('BanMembers') });
  await automod.buttons.qban(ask.i, w.client, [U]);
  const prompt = ask.out.replies[0];
  assert.equal(prompt.ephemeral, true);
  assert.deepEqual(ids(prompt.components), [`cmd:automod:qbanok:${U}:${LOG}`, 'cmd:automod:qcancel']);
  assert.equal(w.calls.ban.length, 0, 'rien avant confirmation');

  const ok = fakeInteraction(w, { customId: `cmd:automod:qbanok:${U}:${LOG}`, permissions: perms('BanMembers') });
  await automod.buttons.qbanok(ok.i, w.client, [U, LOG]);
  assert.equal(w.calls.ban.length, 1);
  assert.equal(w.calls.ban[0][1].id, U);
  assert.equal(w.calls.ban[0][4].deleteMessageSeconds, 3600);
  assert.match(json(ok.out.edits[0].embeds[0]).description ?? json(ok.out.edits[0].embeds[0]).title, /banni/i);

  const cancel = fakeInteraction(w, { permissions: perms('BanMembers') });
  await automod.buttons.qcancel(cancel.i, w.client, []);
  assert.deepEqual(cancel.out.updates[0].components, []);
  for (const name of ['qban', 'qbanok', 'qcancel']) {
    await assert.rejects(automod.buttons[name](fakeInteraction(w, { permissions: perms('ModerateMembers') }).i, w.client, [U]), { name: 'UserError' }, name);
  }
});

// ---------------------------------------------------------------- tableau de bord

function assertValid(payload, label) {
  const rows = payload.components.map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const seen = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, `${label} : rangée trop longue`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      seen.push(c.custom_id);
      assert.ok(c.custom_id.length <= 100);
      const [, cmd, action] = c.custom_id.split(':');
      if (cmd === 'automod') assert.equal(typeof automod.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25);
    }
  }
  assert.equal(new Set(seen).size, seen.length, `${label} : identifiants en double`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256));
  }
}

const FILTER_KEYS = Object.keys(defaultGuildConfig.automod.filters);

test('vue de chaque filtre : ≤ 5 rangées, exemptions propres, sanction « Expulsion » proposée', async () => {
  const w = dashboardWorld();
  const many = Array.from({ length: 40 }, (_, k) => String(700000000000000000n + BigInt(k)));
  for (const key of FILTER_KEYS) w.config.update(G, { automod: { filters: { [key]: { exemptChannels: many, exemptRoles: many } } } });
  for (const key of FILTER_KEYS) {
    const view = await automod.render(w.client, w.guild, `filter:${key}`, 'Notification');
    assertValid(view, key);
    const rows = view.components.map(json);
    const actionMenu = rows[0].components[0];
    const values = actionMenu.options.map((o) => o.value);
    assert.ok(values.includes('kick'), `${key} : kick`);
    assert.equal(values.includes('quarantine'), key === 'antiHacked', `${key} : quarantaine`);
    const menuIds = rows.flatMap((r) => r.components.map((c) => c.custom_id));
    assert.ok(menuIds.includes(`cmd:automod:fexch:${key}`) && menuIds.includes(`cmd:automod:fexrole:${key}`), key);
  }
  for (const v of ['home', 'grp:security', 'presets', 'native', 'stats:7']) assertValid(await automod.render(w.client, w.guild, v), v);
  const security = (await automod.render(w.client, w.guild, 'grp:security')).components.map(json)[1].components[0];
  assert.ok(security.options.some((o) => o.value === 'antiHacked'));
});

test('exemptions par filtre, sanction et réglages de « Compte piraté » enregistrés', async () => {
  const w = dashboardWorld();
  const admin = perms('ManageGuild');
  const run = async (action, args, extra = {}) => {
    const { i, out } = fakeInteraction(w, { permissions: admin, ...extra });
    await automod.buttons[action](i, w.client, args);
    return out;
  };
  await run('fexch', ['antiLink'], { values: [C1, 'pas-un-id'] });
  assert.deepEqual(w.config.get(G).automod.filters.antiLink.exemptChannels, [C1]);
  await run('fexrole', ['antiLink'], { values: [R1, G] });
  assert.deepEqual(w.config.get(G).automod.filters.antiLink.exemptRoles, [R1], '@everyone refusé');
  await assert.rejects(run('fexch', ['inconnu'], { values: [] }), { name: 'UserError' });

  await run('faction', ['antiCaps'], { values: ['kick'] });
  assert.equal(w.config.get(G).automod.filters.antiCaps.action, 'kick');
  await assert.rejects(run('faction', ['antiCaps'], { values: ['quarantine'] }), { name: 'UserError' });
  await run('faction', ['antiHacked'], { values: ['quarantine'] });
  assert.equal(w.config.get(G).automod.filters.antiHacked.action, 'quarantine');

  await run('hkroles', ['on']);
  assert.equal(w.config.get(G).automod.filters.antiHacked.removeRoles, true);
  await run('hkroles', ['off']);
  assert.equal(w.config.get(G).automod.filters.antiHacked.removeRoles, false);

  const modal = (await run('fset', ['antiHacked'])).replies[0].modal.toJSON();
  assert.ok(modal.components.length <= 5);
  assert.ok(modal.components.every((r) => r.components[0].label.length <= 45));
  const fields = { duration: '2d', threshold: '4', window: '120', purgeMinutes: '30', scamScore: '6' };
  await run('fsetsubmit', ['antiHacked'], { fields: { getTextInputValue: (k) => fields[k] } });
  const hk = w.config.get(G).automod.filters.antiHacked;
  assert.deepEqual([hk.duration, hk.channels, hk.windowSeconds, hk.purgeMinutes, hk.scamScore], ['2d', 4, 120, 30, 6]);
  fields.purgeMinutes = '999';
  await assert.rejects(run('fsetsubmit', ['antiHacked'], { fields: { getTextInputValue: (k) => fields[k] } }), { name: 'UserError' });
});

test('nouveaux gestionnaires refusés sans permission', async () => {
  const w = dashboardWorld();
  for (const name of ['fexch', 'fexrole', 'hkroles', 'fp', 'fpfix', 'fpdm', 'qlift', 'qban', 'qbanok', 'qcancel']) {
    await assert.rejects(automod.buttons[name](fakeInteraction(w, { permissions: perms() }).i, w.client, ['antiLink']), { name: 'UserError' }, name);
  }
});

// ---------------------------------------------------------------- préréglages, natif, journal

test('préréglages : le filtre « Compte piraté » est réglé sans toucher aux exemptions ni aux rôles', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const hk = p.patch.filters.antiHacked;
    assert.ok(hk?.enabled, name);
    assert.equal(hk.action, 'quarantine');
    for (const f of Object.values(p.patch.filters)) assert.ok(!('exemptChannels' in f) && !('exemptRoles' in f), name);
    assert.ok(!('removeRoles' in hk), name);
  }
});

test('AutoMod natif : exemptions du filtre ajoutées aux exemptions globales', () => {
  const rules = native.desiredRules({
    ignoredRoles: [R1],
    ignoredChannels: [C1],
    filters: { antiSpam: { enabled: true, exemptChannels: [C2], exemptRoles: [R1, R2] }, antiMassMention: { enabled: true, limit: 5 } },
  });
  const spam = rules.find((r) => r.name === native.NAMES.spam);
  assert.deepEqual(spam.exemptChannels, [C1, C2]);
  assert.deepEqual(spam.exemptRoles, [R1, R2]);
  const mentions = rules.find((r) => r.name === native.NAMES.mentions);
  assert.deepEqual(mentions.exemptChannels, [C1]);
});

test('journal : identifiant renvoyé, lecture et suppression limitées au serveur', () => {
  const { db } = memoryDb();
  const repo = new AutomodEventRepository(db);
  const id = repo.add({ guildId: G, userId: U, filter: 'antiLink', action: 'delete' });
  assert.ok(Number.isInteger(id) && id > 0);
  assert.equal(repo.get('autre', id), null);
  assert.equal(repo.get(G, id).user_id, U);
  assert.equal(repo.remove('autre', id), false);
  assert.equal(repo.remove(G, id), true);
  assert.equal(repo.get(G, id), null);
});
