'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const bienvenue = require('../src/commands/configuration/bienvenue');
const guildMemberAdd = require('../src/events/guildMemberAdd');
const welcomeEvents = require('../src/events/welcome');
const W = require('../src/services/WelcomeService');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const DAY = 86_400_000;
const GUILD = '100000000000000001';
const ROLE = { member: '300000000000000001', bot: '300000000000000002', admin: '300000000000000003', managed: '300000000000000004', high: '300000000000000005', mod: '300000000000000006', verified: '300000000000000007' };
const CH = { welcome: '400000000000000001', panel: '400000000000000002', voice: '400000000000000003' };
const UID = '500000000000000001';

function fakeRole(id, { position = 1, managed = false, perms = 0n } = {}) {
  return { id, position, managed, permissions: new PermissionsBitField(perms), toString: () => `<@&${id}>` };
}

function fakeChannel(id, type = ChannelType.GuildText) {
  const ch = {
    id,
    type,
    sent: [],
    deleted: [],
    send: async (p) => {
      ch.sent.push(p);
      return { id: `6000000000000000${String(ch.sent.length).padStart(2, '0')}` };
    },
    messages: { delete: async (mid) => ch.deleted.push(mid) },
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    toString: () => `<#${id}>`,
  };
  return ch;
}

function fakeGuild() {
  const roles = new Collection([
    [GUILD, fakeRole(GUILD, { position: 0 })],
    [ROLE.member, fakeRole(ROLE.member)],
    [ROLE.bot, fakeRole(ROLE.bot)],
    [ROLE.admin, fakeRole(ROLE.admin, { perms: PermissionFlagsBits.Administrator })],
    [ROLE.managed, fakeRole(ROLE.managed, { managed: true })],
    [ROLE.high, fakeRole(ROLE.high, { position: 50 })],
    [ROLE.mod, fakeRole(ROLE.mod, { perms: PermissionFlagsBits.ManageMessages | PermissionFlagsBits.KickMembers })],
    [ROLE.verified, fakeRole(ROLE.verified, { position: 2 })],
  ]);
  const channels = new Collection([
    [CH.welcome, fakeChannel(CH.welcome)],
    [CH.panel, fakeChannel(CH.panel)],
    [CH.voice, fakeChannel(CH.voice, ChannelType.GuildVoice)],
  ]);
  return {
    id: GUILD,
    name: 'Le Repaire',
    memberCount: 42,
    roles: { cache: roles, everyone: roles.get(GUILD) },
    channels: { cache: channels },
    members: { me: { id: '999999999999999999', roles: { highest: { position: 10 } } }, fetch: async () => null },
  };
}

function fakeMember(guild, { id = UID, bot = false, pending = false, ageDays = 400, name = 'Alice', roles = [] } = {}) {
  const m = {
    id,
    guild,
    pending,
    displayName: name,
    joinedTimestamp: Date.now(),
    user: { id, bot, username: name.toLowerCase(), createdTimestamp: Date.now() - ageDays * DAY, displayAvatarURL: () => 'https://cdn.discordapp.com/a.png', toString: () => `<@${id}>` },
    roles: {
      cache: new Collection(roles.map((r) => [r, guild.roles.cache.get(r)])),
      add: async (ids) => [].concat(ids).forEach((r) => m.roles.cache.set(r, guild.roles.cache.get(r))),
      remove: async (ids) => [].concat(ids).forEach((r) => m.roles.cache.delete(r)),
    },
    dms: [],
    send: async (p) => m.dms.push(p),
  };
  return m;
}

function world({ randomInt } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const guild = fakeGuild();
  const logs = [];
  const logging = { send: async (guildId, category, embed, components, ctx) => logs.push({ category, ctx, embed: json(embed) }) };
  const client = { services: { config, logging, antiraid: { joinAlertAt: new Map() } }, guilds: { cache: new Map([[guild.id, guild]]) } };
  client.services.welcome = new W.WelcomeService({ client, config, logging, ...(randomInt ? { randomInt } : {}) });
  return { client, guild, config, logs, welcome: client.services.welcome };
}

const admin = (guild, extra = {}) => ({
  guildId: guild.id,
  guild,
  user: { id: UID, username: 'alice', globalName: 'Alice', createdTimestamp: Date.now() - 400 * DAY, displayAvatarURL: () => null },
  member: null,
  memberPermissions: new PermissionsBitField(PermissionsBitField.All),
  values: [],
  ...extra,
});

// ---------------------------------------------------------------- fonctions pures

test('rendu des variables : une seule passe, @everyone/@here neutralisés, titre sans markdown', () => {
  const vars = { id: UID, name: 'Bob_@here {membre}', server: 'Serveur *cool*', count: 12, age: '3 jours', avatar: null };
  const out = W.renderTemplate('Salut {membre} ({pseudo}) sur {serveur} : n°{nombre}, compte de {compte}. @everyone {inconnue}', vars);
  assert.ok(out.includes(`<@${UID}>`));
  assert.ok(out.includes('n°12') && out.includes('3 jours'));
  assert.ok(out.includes('{inconnue}'), 'variable inconnue laissée telle quelle');
  assert.ok(!/@(everyone|here)/.test(out), 'aucune mention de masse');
  assert.equal((out.match(/<@/g) ?? []).length, 1, 'le « {membre} » du pseudo n\'est pas réinterprété');
  assert.ok(out.includes('Serveur \\*cool\\*'), 'markdown échappé dans le texte');
  const title = W.renderTemplate('Bienvenue {membre} sur {serveur}', vars, { plain: true });
  assert.ok(!title.includes('<@') && title.includes('Serveur *cool*'));
  assert.deepEqual(W.unknownVariables('{membre} {Prenom} {nombre} {prenom}'), ['prenom']);
});

test('âge du compte lisible', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(W.accountAge(now - 3600_000, now), 'moins d\'un jour');
  assert.equal(W.accountAge(now - DAY, now), '1 jour');
  assert.equal(W.accountAge(now - 12 * DAY, now), '12 jours');
  assert.equal(W.accountAge(now - 95 * DAY, now), '3 mois');
  assert.equal(W.accountAge(now - 800 * DAY, now), '2 ans');
});

test('message : mention limitée au membre, jamais @everyone ni rôles', () => {
  const vars = { id: UID, name: 'Alice', server: 'S', count: 5, age: '1 an', avatar: null };
  const msg = { title: '@everyone Bienvenue', description: '<@&123456789012345678> {membre} @here', color: 0xff0000, image: 'https://x.y/b.png', mention: true };
  const p = W.messagePayload('join', msg, vars);
  assert.equal(p.content, `<@${UID}>`);
  assert.deepEqual(p.allowedMentions, { parse: [], users: [UID] });
  const e = json(p.embeds[0]);
  assert.equal(e.color, 0xff0000);
  assert.equal(e.image.url, 'https://x.y/b.png');
  assert.ok(!/@(everyone|here)/.test(e.title + e.description));
  const off = W.messagePayload('join', { ...msg, mention: false }, vars);
  assert.equal(off.content, undefined);
  assert.deepEqual(off.allowedMentions.users, []);
  assert.equal(W.messagePayload('leave', msg, vars).content, undefined, 'pas de mention au départ');
});

test('couleur et image : saisies validées', () => {
  assert.equal(W.parseColor('#5865F2'), 0x5865f2);
  assert.equal(W.parseColor('ff8800'), 0xff8800);
  assert.equal(W.parseColor('  '), null);
  assert.equal(W.colorHex(0x5865f2), '#5865F2');
  for (const bad of ['rouge', '#12345', '#GGGGGG']) assert.throws(() => W.parseColor(bad), { name: 'UserError' });
  assert.equal(W.parseImageUrl(''), null);
  assert.equal(W.parseImageUrl('https://exemple.com/b.png'), 'https://exemple.com/b.png');
  for (const bad of ['http://exemple.com/b.png', 'javascript:alert(1)', 'pas une url', `https://x.com/${'a'.repeat(600)}`]) {
    assert.throws(() => W.parseImageUrl(bad), { name: 'UserError' }, bad);
  }
});

test('rôles : hiérarchie, rôles gérés, @everyone, Administrateur refusés ; permissions sensibles signalées', () => {
  const guild = fakeGuild();
  const r = (id) => guild.roles.cache.get(id);
  assert.equal(W.roleIssue(r(ROLE.member), guild), null);
  assert.match(W.roleIssue(r(GUILD), guild), /everyone/);
  assert.match(W.roleIssue(r(ROLE.managed), guild), /intégration/);
  assert.match(W.roleIssue(r(ROLE.admin), guild), /Administrateur/);
  assert.match(W.roleIssue(r(ROLE.high), guild), /au-dessus/);
  assert.match(W.roleIssue(undefined, guild), /introuvable/);
  assert.deepEqual(W.dangerousPermissions(r(ROLE.mod)).sort(), ['Expulser des membres', 'Gérer les messages']);
  assert.deepEqual(W.dangerousPermissions(r(ROLE.member)), []);
});

test('rôles d\'arrivée et de vérification ; refus de vérification clairs', () => {
  const base = { autoRoles: { humans: [ROLE.member, ROLE.verified], bots: [ROLE.bot] }, verification: { enabled: false, mode: 'add', roleId: ROLE.verified } };
  const human = { user: { bot: false } };
  assert.deepEqual(W.joinRoles(base, human), [ROLE.member, ROLE.verified]);
  assert.deepEqual(W.joinRoles(base, { user: { bot: true } }), [ROLE.bot]);
  const on = { ...base, verification: { ...base.verification, enabled: true } };
  assert.deepEqual(W.joinRoles(on, human), [], 'rôles humains différés jusqu\'à la vérification');
  assert.deepEqual(W.verifyRoles(on), { add: [ROLE.verified, ROLE.member], remove: [] });
  const removeMode = { ...on, verification: { ...on.verification, mode: 'remove' } };
  assert.deepEqual(W.joinRoles(removeMode, human), [ROLE.verified], 'rôle « non vérifié » donné à l\'arrivée');
  assert.deepEqual(W.verifyRoles(removeMode), { add: [ROLE.member], remove: [ROLE.verified] });

  const guild = fakeGuild();
  const now = Date.now();
  const v = { enabled: true, mode: 'add', roleId: ROLE.verified, minAccountAgeDays: 7 };
  assert.equal(W.verifyRefusal(fakeMember(guild), v, now), null);
  assert.match(W.verifyRefusal(fakeMember(guild, { ageDays: 2 }), v, now), /trop récent.*7 jours.*<t:\d+:R>/s);
  assert.match(W.verifyRefusal(fakeMember(guild, { roles: [ROLE.verified] }), v, now), /déjà vérifié/);
  assert.match(W.verifyRefusal(fakeMember(guild, { pending: true }), v, now), /règlement/);
  assert.match(W.verifyRefusal(fakeMember(guild), { ...v, enabled: false }, now), /pas active/);
});

test('défi anti-robot : tiré côté serveur, usage unique, expiration, blocage après 5 erreurs', () => {
  let t = 1_000_000;
  const seq = [0, 7, 5, 0]; // calcul, 7, 5, addition
  const { config } = world();
  const svc = new W.WelcomeService({ config, now: () => t, randomInt: (min) => (seq.length ? seq.shift() : min) });
  const { label } = svc.createChallenge(GUILD, UID);
  assert.equal(label, 'Combien font 7 + 5 ?');
  assert.ok(label.length <= 45);
  assert.equal(svc.checkChallenge(GUILD, UID, ' 12 '), 'ok');
  assert.equal(svc.checkChallenge(GUILD, UID, '12'), 'expired', 'usage unique');
  assert.equal(svc.checkChallenge(GUILD, '500000000000000009', '12'), 'expired', 'défi propre à chaque membre');

  // Mot à recopier (insensible à la casse).
  const word = new W.WelcomeService({ config, now: () => t, randomInt: (min) => (min === 0 ? 1 : min) });
  const w = word.createChallenge(GUILD, UID).label;
  assert.match(w, /^Recopiez ce mot : [A-Z]{6}$/);
  assert.equal(word.checkChallenge(GUILD, UID, w.split(': ')[1].toLowerCase()), 'ok');

  // Expiration (5 min).
  svc.createChallenge(GUILD, UID);
  t += 6 * 60_000;
  assert.equal(svc.checkChallenge(GUILD, UID, '4'), 'expired');

  // 5 mauvaises réponses → blocage temporaire.
  for (let i = 0; i < 5; i++) {
    svc.createChallenge(GUILD, UID);
    assert.equal(svc.checkChallenge(GUILD, UID, 'faux'), 'wrong');
  }
  assert.ok(svc.lockedUntil(GUILD, UID) > t);
  svc.createChallenge(GUILD, UID);
  assert.equal(svc.checkChallenge(GUILD, UID, '4'), 'locked');
  t += 11 * 60_000;
  assert.equal(svc.lockedUntil(GUILD, UID), 0, 'blocage levé après 10 min');
});

// ---------------------------------------------------------------- service & événements

test('arrivée : rôles automatiques filtrés, message envoyé, MP ; bots : rôles seulement', async () => {
  const { guild, config, welcome } = world();
  config.update(guild.id, {
    welcome: {
      join: { enabled: true, channelId: CH.welcome, dm: true },
      autoRoles: { humans: [ROLE.member, ROLE.admin, ROLE.managed, ROLE.high], bots: [ROLE.bot] },
    },
  });
  const member = fakeMember(guild);
  const r = await welcome.handleJoin(member, { raid: { punished: false } });
  assert.deepEqual(r.roles, [ROLE.member], 'Administrateur, géré et au-dessus du bot ignorés');
  assert.equal(r.sent, true);
  assert.equal(r.dm, true);
  const sent = guild.channels.cache.get(CH.welcome).sent[0];
  assert.equal(sent.content, `<@${UID}>`);
  assert.deepEqual(sent.allowedMentions, { parse: [], users: [UID] });
  assert.match(json(sent.embeds[0]).description, /42/);
  assert.equal(member.dms[0].content, undefined, 'MP sans mention');

  const bot = fakeMember(guild, { id: '500000000000000002', bot: true });
  const rb = await welcome.handleJoin(bot, {});
  assert.deepEqual(rb.roles, [ROLE.bot]);
  assert.equal(rb.sent, false);
  assert.equal(guild.channels.cache.get(CH.welcome).sent.length, 1);
});

test('arrivée : AntiRaid (sanctionné → rien, départ tu) et écran d\'adhésion (attente puis accueil)', async () => {
  const { client, guild, config, welcome } = world();
  config.update(guild.id, { welcome: { join: { enabled: true, channelId: CH.welcome }, leave: { enabled: true, channelId: CH.welcome }, autoRoles: { humans: [ROLE.member] } } });
  const ch = guild.channels.cache.get(CH.welcome);

  const punished = fakeMember(guild);
  assert.deepEqual(await welcome.handleJoin(punished, { raid: { punished: true } }), { skipped: 'antiraid' });
  assert.equal(punished.roles.cache.size, 0);
  assert.equal((await welcome.handleLeave(punished)).sent, false, 'pas de message de départ');
  assert.equal(ch.sent.length, 0);

  const pending = fakeMember(guild, { id: '500000000000000003', pending: true });
  assert.deepEqual(await welcome.handleJoin(pending, {}), { skipped: 'pending' });
  assert.equal(ch.sent.length, 0);
  // Mise à jour sans passage pending → false : rien.
  await welcomeEvents.find((e) => e.name === 'guildMemberUpdate').execute(client, { pending: false }, { ...pending, pending: false });
  assert.equal(ch.sent.length, 0);
  const passed = { ...pending, pending: false };
  await welcomeEvents.find((e) => e.name === 'guildMemberUpdate').execute(client, { pending: true }, passed);
  assert.equal(ch.sent.length, 1);
  assert.ok(passed.roles.cache.has(ROLE.member));

  // Départ normal.
  await welcomeEvents.find((e) => e.name === 'guildMemberRemove').execute(client, fakeMember(guild, { id: '500000000000000004', name: 'Zoé' }));
  assert.equal(ch.sent.length, 2);
  const leave = ch.sent[1];
  assert.equal(leave.content, undefined);
  assert.deepEqual(leave.allowedMentions, { parse: [], users: [] });
  assert.match(json(leave.embeds[0]).title, /Zoé/);

  // Arrivant récent d'une vague détectée : départ tu.
  client.services.antiraid.joinAlertAt.set(guild.id, Date.now());
  await welcome.handleLeave(fakeMember(guild, { id: '500000000000000005' }));
  assert.equal(ch.sent.length, 2);
});

test('guildMemberAdd appelle l\'accueil après l\'AntiRaid et lui transmet le résultat', async () => {
  for (const punished of [false, true]) {
    const calls = [];
    const member = fakeMember(fakeGuild());
    const client = {
      repositories: {},
      services: {
        antiraid: { handleJoin: async () => ({ punished }) },
        logging: { send: async () => calls.push('log') },
        welcome: { handleJoin: async (m, ctx) => calls.push(['welcome', ctx.raid.punished]) },
      },
    };
    await guildMemberAdd.execute(client, member);
    assert.deepEqual(calls, ['log', ['welcome', punished]]);
  }
});

test('vérification : rôles humains différés puis donnés, log memberVerify', async () => {
  const { guild, config, welcome, logs } = world();
  config.update(guild.id, { welcome: { autoRoles: { humans: [ROLE.member] }, verification: { enabled: true, roleId: ROLE.verified } } });
  const member = fakeMember(guild);
  const r = await welcome.handleJoin(member, {});
  assert.deepEqual(r.roles, []);
  const res = await welcome.verify(member, { captcha: true });
  assert.deepEqual(res.added, [ROLE.verified, ROLE.member]);
  assert.ok(member.roles.cache.has(ROLE.verified) && member.roles.cache.has(ROLE.member));
  assert.equal(logs[0].category, 'members');
  assert.equal(logs[0].ctx.event, 'memberVerify');
  assert.equal(EVENT_CATEGORY.memberVerify, 'members');
  assert.throws(() => welcome.assertCanVerify(member), /déjà vérifié/);

  // Mode retrait : « non vérifié » donné à l'arrivée, retiré à la vérification.
  config.update(guild.id, { welcome: { verification: { mode: 'remove' } } });
  const m2 = fakeMember(guild, { id: '500000000000000006' });
  await welcome.handleJoin(m2, {});
  assert.ok(m2.roles.cache.has(ROLE.verified));
  const res2 = await welcome.verify(m2);
  assert.deepEqual(res2.removed, [ROLE.verified]);
  assert.ok(!m2.roles.cache.has(ROLE.verified) && m2.roles.cache.has(ROLE.member));
});

// ---------------------------------------------------------------- tableau de bord

function assertValid(payload, label) {
  const rows = payload.components.map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, `${label} : rangée trop longue`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      ids.push(c.custom_id);
      assert.ok(c.custom_id.length <= 100);
      const [, cmd, action] = c.custom_id.split(':');
      assert.equal(cmd, 'bienvenue', `${label} : ${c.custom_id}`);
      assert.equal(typeof bienvenue.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25);
      if (c.max_values) assert.ok(c.max_values <= 25);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label} : identifiants en double`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096);
    assert.ok((e.fields ?? []).length <= 25);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256), `${label} : champ trop long`);
  }
}

test('/bienvenue est une commande unique réservée à « Gérer le serveur »', () => {
  const data = bienvenue.data.toJSON();
  assert.equal(data.name, 'bienvenue');
  assert.equal((data.options ?? []).length, 0);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('chaque vue de /bienvenue respecte les limites Discord et route vers un gestionnaire', () => {
  const { client, guild, config } = world();
  const views = ['home', 'join', 'leave', 'roles', 'verify', 'preview', 'inconnue'];
  for (const v of views) assertValid(bienvenue.render(client, guild, v, '✅ Notification'), `${v} (vide)`);
  // Configuration chargée au maximum (textes longs, 10 rôles, problèmes à signaler).
  const many = Array.from({ length: 10 }, (_, i) => String(310000000000000000n + BigInt(i)));
  config.update(guild.id, {
    welcome: {
      join: { enabled: true, channelId: '400000000000000099', title: 'T'.repeat(200), description: `${'{membre} @everyone '.repeat(90)}`.slice(0, 2000), color: 0x123456, image: 'https://x.y/z.png', dm: true },
      leave: { enabled: true, channelId: CH.welcome, description: 'D'.repeat(2000) },
      autoRoles: { humans: [...many.slice(0, 7), ROLE.admin, ROLE.mod, ROLE.member], bots: many },
      verification: { enabled: true, mode: 'remove', roleId: ROLE.high, channelId: CH.panel, captcha: true, minAccountAgeDays: 30 },
    },
  });
  for (const v of views) assertValid(bienvenue.render(client, guild, v, '✅ Notification'), v);
  const home = json(bienvenue.render(client, guild, 'home').embeds[0]);
  assert.match(home.description, /À corriger/);
  const preview = json(bienvenue.render(client, guild, 'preview').embeds[0]);
  assert.ok(!/@(everyone|here)/.test(JSON.stringify(preview.fields)), 'mentions de masse neutralisées dans l\'aperçu');
});

test('tous les gestionnaires d\'administration refusent sans « Gérer le serveur »', async () => {
  const { client, guild } = world();
  const i = admin(guild, { memberPermissions: new PermissionsBitField(0n), values: [] });
  const publicActions = ['verify', 'verifysubmit'];
  for (const [name, handler] of Object.entries(bienvenue.buttons)) {
    if (publicActions.includes(name)) continue;
    await assert.rejects(handler(i, client, ['join', 'on']), { name: 'UserError' }, name);
  }
});

test('interrupteurs : valeur cible explicite, salon ou rôle exigé avant activation', async () => {
  const { client, guild, config } = world();
  let payload;
  const i = admin(guild, { update: async (p) => (payload = p) });
  await assert.rejects(bienvenue.buttons.set(i, client, ['join.enabled', 'on']), /salon/);
  await assert.rejects(bienvenue.buttons.set(i, client, ['verification.enabled', 'on']), /rôle/);
  await assert.rejects(bienvenue.buttons.set(i, client, ['join.inconnu', 'on']), { name: 'UserError' });
  await bienvenue.buttons.channel({ ...i, values: [CH.welcome] }, client, ['join']);
  assert.equal(config.get(guild.id).welcome.join.channelId, CH.welcome);
  await assert.rejects(bienvenue.buttons.channel({ ...i, values: [CH.voice] }, client, ['join']), /textuel/);
  await bienvenue.buttons.set(i, client, ['join.enabled', 'on']);
  await bienvenue.buttons.set(i, client, ['join.enabled', 'on']);
  assert.equal(config.get(guild.id).welcome.join.enabled, true, 'pas d\'inversion à l\'aveugle');
  await bienvenue.buttons.set(i, client, ['join.mention', 'off']);
  assert.equal(config.get(guild.id).welcome.join.mention, false);
  // Retirer le salon désactive le message.
  await bienvenue.buttons.channel({ ...i, values: [] }, client, ['join']);
  assert.equal(config.get(guild.id).welcome.join.enabled, false);
  assert.ok(payload.embeds.length);
});

test('formulaire du message : enregistrement validé, variables inconnues signalées', async () => {
  const { client, guild, config } = world();
  let payload;
  let modal;
  const values = { title: 'Salut {pseudo}', description: 'Bienvenue {membre} {prenom}', color: '#FF8800', image: '' };
  const i = admin(guild, { update: async (p) => (payload = p), showModal: async (m) => (modal = json(m)), fields: { getTextInputValue: (k) => values[k] } });
  await bienvenue.buttons.edit(i, client, ['join']);
  assert.equal(modal.custom_id, 'cmd:bienvenue:editsubmit:join');
  assert.ok(modal.components.every((r) => r.components.every((c) => c.label.length <= 45)));
  await bienvenue.buttons.editsubmit(i, client, ['join']);
  const join = config.get(guild.id).welcome.join;
  assert.equal(join.title, 'Salut {pseudo}');
  assert.equal(join.color, 0xff8800);
  assert.equal(join.image, null);
  assert.match(json(payload.embeds[0]).description, /\{prenom\}/);
  values.color = 'bleu';
  await assert.rejects(bienvenue.buttons.editsubmit(i, client, ['join']), { name: 'UserError' });
  values.color = '';
  values.image = 'http://non-securise.fr/a.png';
  await assert.rejects(bienvenue.buttons.editsubmit(i, client, ['leave']), { name: 'UserError' });
});

test('rôles automatiques : refus (Administrateur, géré, au-dessus, permissions de modération)', async () => {
  const { client, guild, config } = world();
  let payload;
  // L'auteur a un rôle plus haut que les rôles proposés (contrôle de hiérarchie de l'auteur).
  const i = admin(guild, { member: { roles: { highest: { position: 20 } } }, update: async (p) => (payload = p), values: [ROLE.member, ROLE.admin, ROLE.managed, ROLE.high, ROLE.mod, GUILD] });
  await bienvenue.buttons.roles(i, client, ['humans']);
  assert.deepEqual(config.get(guild.id).welcome.autoRoles.humans, [ROLE.member], 'rôle de modération désormais refusé (plus seulement signalé)');
  const desc = json(payload.embeds[0]).description;
  assert.match(desc, /Refusé/);
  assert.match(desc, /modération ou d'administration/);
  await assert.rejects(bienvenue.buttons.roles(i, client, ['autre']), { name: 'UserError' });
  await assert.rejects(bienvenue.buttons.vrole({ ...i, values: [ROLE.admin] }, client), /Administrateur/);
  await bienvenue.buttons.vrole({ ...i, values: [ROLE.verified] }, client);
  assert.equal(config.get(guild.id).welcome.verification.roleId, ROLE.verified);
});

test('aperçu éphémère et envoi de test', async () => {
  const { client, guild, config } = world();
  let reply;
  let edited;
  const i = admin(guild, { reply: async (p) => (reply = p), deferUpdate: async () => {}, editReply: async (p) => (edited = p) });
  await bienvenue.buttons.preview(i, client, ['join']);
  assert.equal(reply.ephemeral, true);
  assert.match(json(reply.embeds[1]).title, /Le Repaire/);
  await bienvenue.buttons.preview(i, client, ['panel']);
  assert.equal(reply.components, undefined, 'aperçu du panneau sans bouton actif');
  await assert.rejects(bienvenue.buttons.test(i, client, ['join']), /salon/);
  config.update(guild.id, { welcome: { join: { channelId: CH.welcome } } });
  await bienvenue.buttons.test(i, client, ['join']);
  const sent = guild.channels.cache.get(CH.welcome).sent[0];
  assert.deepEqual(sent.allowedMentions, { parse: [], users: [UID] });
  assert.match(json(edited.embeds[0]).description, /test envoyé/);
});

test('panneau : publication avec bouton persistant, ancien panneau supprimé', async () => {
  const { client, guild, config } = world();
  let edited;
  const i = admin(guild, { deferUpdate: async () => {}, editReply: async (p) => (edited = p) });
  await assert.rejects(bienvenue.buttons.publish(i, client), /rôle/);
  config.update(guild.id, { welcome: { verification: { roleId: ROLE.verified } } });
  await assert.rejects(bienvenue.buttons.publish(i, client), /salon/);
  config.update(guild.id, { welcome: { verification: { channelId: CH.panel, enabled: true } } });
  await bienvenue.buttons.publish(i, client);
  const ch = guild.channels.cache.get(CH.panel);
  const button = json(ch.sent[0].components[0]).components[0];
  assert.equal(button.custom_id, 'cmd:bienvenue:verify');
  const v = config.get(guild.id).welcome.verification;
  assert.equal(v.panelChannelId, CH.panel);
  assert.ok(v.panelMessageId);
  await bienvenue.buttons.publish(i, client);
  assert.deepEqual(ch.deleted, [v.panelMessageId]);
  assert.match(json(edited.embeds[0]).description, /Panneau publié/);
});

test('bouton public « Me vérifier » : sans question, avec question (réponse jamais côté client), âge minimal', async () => {
  // randomInt : calcul (0), 3, 4, addition (0).
  const seq = [];
  const { client, guild, config, logs } = world({ randomInt: (min) => (seq.length ? seq.shift() : min) });
  config.update(guild.id, { welcome: { autoRoles: { humans: [ROLE.member] }, verification: { enabled: true, roleId: ROLE.verified, minAccountAgeDays: 7 } } });
  const noPerm = new PermissionsBitField(0n);
  const make = (member, extra = {}) => {
    const out = {};
    const i = {
      guildId: guild.id,
      guild,
      user: member.user,
      member,
      memberPermissions: noPerm,
      deferReply: async (o) => (out.deferred = o),
      editReply: async (p) => (out.reply = p),
      showModal: async (m) => (out.modal = json(m)),
      ...extra,
    };
    return { i, out };
  };

  // Compte trop récent : refus clair.
  const young = fakeMember(guild, { ageDays: 1 });
  await assert.rejects(bienvenue.buttons.verify(make(young).i, client), /trop récent/);

  // Sans question : vérifié directement (aucune permission requise).
  const m1 = fakeMember(guild);
  const a = make(m1);
  await bienvenue.buttons.verify(a.i, client);
  assert.equal(a.out.deferred.ephemeral, true);
  assert.match(json(a.out.reply.embeds[0]).title, /Vérification réussie/);
  assert.ok(m1.roles.cache.has(ROLE.verified) && m1.roles.cache.has(ROLE.member));
  assert.equal(logs.at(-1).ctx.event, 'memberVerify');

  // Avec question : le formulaire ne contient pas la réponse.
  config.update(guild.id, { welcome: { verification: { captcha: true } } });
  const m2 = fakeMember(guild, { id: '500000000000000007' });
  seq.push(0, 3, 4, 0);
  const b = make(m2);
  await bienvenue.buttons.verify(b.i, client);
  assert.equal(b.out.modal.custom_id, 'cmd:bienvenue:verifysubmit');
  assert.equal(b.out.modal.components[0].components[0].label, 'Combien font 3 + 4 ?');
  assert.ok(!JSON.stringify(b.out.modal).includes('"7"'), 'réponse absente du formulaire');
  // Mauvaise réponse : refus, défi consommé.
  await assert.rejects(bienvenue.buttons.verifysubmit(make(m2, { fields: { getTextInputValue: () => '8' } }).i, client), /incorrecte/);
  await assert.rejects(bienvenue.buttons.verifysubmit(make(m2, { fields: { getTextInputValue: () => '7' } }).i, client), /expiré/);
  // Nouvelle question, bonne réponse.
  seq.push(0, 3, 4, 0);
  await bienvenue.buttons.verify(make(m2).i, client);
  const c = make(m2, { fields: { getTextInputValue: () => '7' } });
  await bienvenue.buttons.verifysubmit(c.i, client);
  assert.ok(m2.roles.cache.has(ROLE.verified));
  assert.match(json(c.out.reply.embeds[0]).title, /Vérification réussie/);
  // Un autre membre ne peut pas répondre au défi de m2.
  seq.push(0, 3, 4, 0);
  await bienvenue.buttons.verify(make(fakeMember(guild, { id: '500000000000000008' })).i, client);
  await assert.rejects(bienvenue.buttons.verifysubmit(make(fakeMember(guild, { id: '500000000000000009' }), { fields: { getTextInputValue: () => '7' } }).i, client), /expiré/);
});

test('vérification désactivée : le bouton public refuse clairement', async () => {
  const { client, guild } = world();
  const member = fakeMember(guild);
  await assert.rejects(bienvenue.buttons.verify({ guildId: guild.id, guild, user: member.user, member }, client), /pas active/);
});

test('âge minimal : saisie bornée', async () => {
  const { client, guild, config } = world();
  let v = '30';
  const i = admin(guild, { update: async () => {}, fields: { getTextInputValue: () => v } });
  await bienvenue.buttons.vagesubmit(i, client);
  assert.equal(config.get(guild.id).welcome.verification.minAccountAgeDays, 30);
  for (const bad of ['-1', '400', 'abc', '1.5']) {
    v = bad;
    await assert.rejects(bienvenue.buttons.vagesubmit(i, client), { name: 'UserError' }, bad);
  }
});
