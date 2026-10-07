'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, OverwriteType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { TempVoiceRepository } = require('../src/database/repositories/TempVoiceRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { TempVoiceService, inheritedOverwrites } = require('../src/services/TempVoiceService');
const tv = require('../src/utils/tempVoice');
const tempvoice = require('../src/commands/voice/tempvoice');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const perm = (bits) => new PermissionsBitField(bits);

const GUILD = '100000000000000001';
const OWNER = '200000000000000001';
const BOB = '200000000000000002';
const CAROL = '200000000000000003';
const MOD = '200000000000000004';
const ME = '999999999999999999';
const CAT = '300000000000000001';
const STAFF_ROLE = '400000000000000001';
const MEMBER_ROLE = '400000000000000002';
const HUB = '500000000000000001';

// ---------------------------------------------------------------- faux Discord

function fakeMember(id, { staff = false, bot = false } = {}) {
  const m = {
    id,
    displayName: `Pseudo${id.slice(-1)}`,
    user: { id, username: `user${id.slice(-1)}`, bot },
    permissions: perm(staff ? P.MoveMembers : 0n),
    disconnected: false,
    voice: {
      setChannel: async (ch) => {
        for (const c of m.guildRef.channels.cache.values()) c.members?.delete(id);
        ch.members.set(id, m);
      },
      disconnect: async () => {
        m.disconnected = true;
        for (const c of m.guildRef.channels.cache.values()) c.members?.delete(id);
      },
    },
    toString: () => `<@${id}>`,
  };
  return m;
}

function overwriteCache(list) {
  return new Collection(list.map((o) => [o.id, { id: o.id, type: o.type, allow: perm(o.allow), deny: perm(o.deny) }]));
}

function fakeVoice(guild, data) {
  let seq = 0;
  const ch = {
    id: data.id ?? `6000000000000000${String(10 + guild.channels.cache.size).padStart(2, '0')}`,
    name: data.name,
    type: data.type ?? ChannelType.GuildVoice,
    parentId: data.parent ?? null,
    userLimit: data.userLimit ?? 0,
    bitrate: 64_000,
    rtcRegion: null,
    guild,
    members: new Collection(),
    sent: [],
    messagesById: new Map(),
    permissionOverwrites: {
      cache: overwriteCache(data.permissionOverwrites ?? []),
      set: async (list) => {
        ch.permissionOverwrites.cache = overwriteCache(list);
      },
    },
    setName: async (name) => {
      if (ch.renameHang) return new Promise(() => {});
      if (ch.renameError) throw ch.renameError;
      ch.name = name;
      return ch;
    },
    setUserLimit: async (n) => Object.assign(ch, { userLimit: n }),
    setBitrate: async (b) => Object.assign(ch, { bitrate: b }),
    setRTCRegion: async (r) => Object.assign(ch, { rtcRegion: r }),
    send: async (p) => {
      const msg = { id: `7000000000000000${String(seq++).padStart(2, '0')}`, payload: p, edit: async (np) => (msg.payload = np) };
      ch.sent.push(p);
      ch.messagesById.set(msg.id, msg);
      return msg;
    },
    messages: { fetch: async (id) => ch.messagesById.get(id) ?? Promise.reject(new Error('Unknown Message')) },
    delete: async () => guild.channels.cache.delete(ch.id),
    toString: () => `<#${ch.id}>`,
  };
  guild.channels.cache.set(ch.id, ch);
  return ch;
}

function fakeGuild({ premiumTier = 0 } = {}) {
  const guild = {
    id: GUILD,
    ownerId: '200000000000000099',
    premiumTier,
    features: [],
    roles: {
      cache: new Collection([
        [GUILD, { id: GUILD, permissions: perm(P.ViewChannel | P.Connect) }],
        [STAFF_ROLE, { id: STAFF_ROLE, permissions: perm(P.MoveMembers) }],
        [MEMBER_ROLE, { id: MEMBER_ROLE, permissions: perm(P.SendMessages) }],
      ]),
    },
    channels: { cache: new Collection() },
    members: { me: { id: ME, permissions: perm(PermissionsBitField.All) }, cache: new Collection() },
  };
  guild.channels.create = async (data) => fakeVoice(guild, data);
  // Catégorie privée : @everyone ne voit pas, le rôle membre voit et rejoint, le staff aussi.
  const category = fakeVoice(guild, {
    id: CAT,
    name: 'Vocaux',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: GUILD, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel },
      { id: MEMBER_ROLE, type: OverwriteType.Role, allow: P.ViewChannel | P.Connect, deny: 0n },
      { id: STAFF_ROLE, type: OverwriteType.Role, allow: P.ViewChannel | P.Connect, deny: 0n },
    ],
  });
  fakeVoice(guild, { id: HUB, name: 'Créer', parent: CAT });
  for (const [id, opts] of [[OWNER], [BOB], [CAROL], [MOD, { staff: true }]]) {
    const m = fakeMember(id, opts);
    m.guildRef = guild;
    guild.members.cache.set(id, m);
  }
  return { guild, category };
}

function world(opts) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new TempVoiceRepository(db);
  const service = new TempVoiceService({ tempVoice: repo, config, renameTimeoutMs: 30 });
  const { guild, category } = fakeGuild(opts);
  const client = { services: { config, tempVoice: service } };
  config.update(GUILD, { tempVoice: { enabled: true, hubChannelId: HUB } });
  return { db, config, repo, service, guild, category, client };
}

/** Le propriétaire rejoint le hub : vocal créé, panneau posté. */
async function joinHub(w, userId = OWNER) {
  const member = w.guild.members.cache.get(userId);
  const hub = w.guild.channels.cache.get(HUB);
  hub.members.set(userId, member);
  await w.service.handleVoiceUpdate({ guild: w.guild, channelId: null, id: userId }, { guild: w.guild, channelId: HUB, member, id: userId, channel: hub });
  const row = w.repo.all().find((r) => r.owner_id === userId);
  return w.guild.channels.cache.get(row.channel_id);
}

function interaction(w, channel, userId, extra = {}) {
  const member = w.guild.members.cache.get(userId);
  const i = {
    guild: w.guild,
    guildId: GUILD,
    channelId: channel?.id,
    user: { id: userId, tag: `user#${userId.slice(-1)}`, toString: () => `<@${userId}>` },
    member: { permissions: member?.permissions ?? perm(0n), guild: w.guild },
    memberPermissions: perm(0n),
    calls: [],
    deferUpdate: async () => i.calls.push(['deferUpdate']),
    editReply: async (p) => i.calls.push(['editReply', p]),
    update: async (p) => i.calls.push(['update', p]),
    reply: async (p) => i.calls.push(['reply', p]),
    showModal: async (m) => i.calls.push(['showModal', m]),
    ...extra,
  };
  return i;
}
const last = (i, kind) => [...i.calls].reverse().find(([k]) => k === kind)?.[1];
const modalFields = (values) => ({ getTextInputValue: (id) => values[id] ?? '' });

/** Limites Discord + chaque customId routé vers un gestionnaire de /tempvoice. */
function assertRouted(payload, label) {
  const rows = payload.components.map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, `${label} : rangée trop longue`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      assert.ok(c.custom_id.length <= 100);
      ids.push(c.custom_id);
      const [prefix, cmd, action] = c.custom_id.split(':');
      if (cmd === '_') continue;
      assert.equal(prefix, 'cmd');
      assert.equal(cmd, 'tempvoice');
      assert.equal(typeof tempvoice.buttons[action], 'function', `${label} : ${action}`);
      if (c.options) assert.ok(c.options.length <= 25 && c.options.length >= 1);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label} : doublons`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024));
    assert.ok((e.title ?? '').length <= 256);
  }
  return ids;
}

// ---------------------------------------------------------------- noms

test('noms : variables, longueur, mentions de masse, invitations', () => {
  assert.equal(tv.formatName('Vocal de {pseudo} #{n}', { pseudo: 'Bob', n: 3 }), 'Vocal de Bob #3');
  assert.equal(tv.formatName('Salon {user} / {username}', { pseudo: 'Bob', username: 'bob42' }), 'Salon Bob / bob42');
  assert.deepEqual(tv.checkName('  Salon\n  cool  ', {}), { ok: true, name: 'Salon cool' });
  assert.equal(tv.checkName('', {}).ok, false);
  assert.equal(tv.checkName('x'.repeat(101), {}).ok, false);
  assert.equal(tv.checkName('x'.repeat(100), {}).ok, true);
  assert.equal(tv.checkName('Venez @everyone', {}).ok, false);
  assert.equal(tv.checkName('@ here', {}).ok, false);
  assert.equal(tv.checkName('<@&123456789012345678>', {}).ok, false);
  assert.equal(tv.checkName('discord.gg/abc', {}).ok, false);
  assert.throws(() => tv.assertName('@here', {}), { name: 'UserError' });
});

test('noms : mots interdits de l\'AutoMod seulement si le filtre est actif', () => {
  const words = ['arnaque*', 'con'];
  const on = { automod: { enabled: true, filters: { badWords: { enabled: true, words } } } };
  assert.equal(tv.checkName('Salon des c.o.n', on).ok, false);
  assert.equal(tv.checkName('Arnaqueurs club', on).ok, false);
  assert.equal(tv.checkName('Salon des copains', on).ok, true);
  assert.equal(tv.checkName('Arnaqueurs club', { automod: { enabled: false, filters: { badWords: { enabled: true, words } } } }).ok, true);
  assert.equal(tv.checkName('Arnaqueurs club', { automod: { enabled: true, filters: { badWords: { enabled: false, words } } } }).ok, true);
  // Pseudo interdit : nom de secours.
  assert.equal(tv.defaultName('Vocal de {pseudo}', { pseudo: 'con', username: 'bob' }, on), 'Vocal de bob');
  assert.equal(tv.defaultName('Vocal de {pseudo}', { pseudo: 'con', username: 'con' }, on), tv.FALLBACK_NAME);
});

test('limite et fenêtre de renommage', () => {
  assert.equal(tv.parseLimit('0'), 0);
  assert.equal(tv.parseLimit(' 99 '), 99);
  for (const bad of ['', '-1', '100', 'abc', '1.5']) assert.throws(() => tv.parseLimit(bad), { name: 'UserError' }, bad);
  const now = 1_000_000_000;
  assert.equal(tv.renameWindow([], now).allowed, true);
  assert.equal(tv.renameWindow([now - 1000], now).allowed, true);
  const full = tv.renameWindow([now - 2000, now - 1000], now);
  assert.equal(full.allowed, false);
  assert.equal(full.retryAt, now - 2000 + tv.RENAME_WINDOW_MS);
  assert.equal(tv.renameWindow([now - tv.RENAME_WINDOW_MS - 1, now - 1000], now).allowed, true, 'renommage ancien oublié');
});

// ---------------------------------------------------------------- permissions

test('verrou / masquage : catégorie privée respectée, staff épargné, présents gardés', () => {
  const { guild, category } = fakeGuild();
  const parent = tv.snapshot(category);
  const base = inheritedOverwrites(category, OWNER);
  const locked = tv.accessOverwrites(base, { flag: P.Connect, on: true, guildId: GUILD, parent, roles: guild.roles.cache, keep: [OWNER, BOB] });
  const get = (list, id) => list.find((o) => o.id === id);
  assert.ok(get(locked, GUILD).deny & P.Connect, '@everyone ne peut plus rejoindre');
  assert.ok(get(locked, GUILD).deny & P.ViewChannel, 'catégorie privée : toujours invisible');
  assert.ok(get(locked, MEMBER_ROLE).deny & P.Connect, 'rôle membre verrouillé');
  assert.equal(get(locked, MEMBER_ROLE).allow & P.Connect, 0n);
  assert.ok(get(locked, STAFF_ROLE).allow & P.Connect, 'staff épargné');
  assert.ok(get(locked, BOB).allow & P.Connect, 'membre présent gardé');
  assert.ok(get(locked, OWNER).allow & tv.OWNER_PERMISSIONS);

  const unlocked = tv.accessOverwrites(locked, { flag: P.Connect, on: false, guildId: GUILD, parent, roles: guild.roles.cache });
  assert.equal(get(unlocked, GUILD).deny & P.Connect, 0n);
  assert.ok(get(unlocked, GUILD).deny & P.ViewChannel, 'déverrouiller ne rend pas public');
  assert.ok(get(unlocked, MEMBER_ROLE).allow & P.Connect, 'rôle membre rétabli comme la catégorie');

  const hidden = tv.accessOverwrites(base, { flag: P.ViewChannel, on: true, guildId: GUILD, parent, roles: guild.roles.cache, keep: [OWNER] });
  assert.ok(get(hidden, MEMBER_ROLE).deny & P.ViewChannel);
  const shown = tv.accessOverwrites(hidden, { flag: P.ViewChannel, on: false, guildId: GUILD, parent, roles: guild.roles.cache });
  assert.ok(get(shown, GUILD).deny & P.ViewChannel, 'afficher : @everyone reste exclu (catégorie privée)');
  assert.ok(get(shown, MEMBER_ROLE).allow & P.ViewChannel);

  // Sans catégorie : déverrouiller retire simplement le refus.
  const open = tv.accessOverwrites(tv.accessOverwrites([], { flag: P.Connect, on: true, guildId: GUILD }), { flag: P.Connect, on: false, guildId: GUILD });
  assert.equal(get(open, GUILD), undefined, 'overwrite vide retiré');
});

test('bannir, autoriser, transférer : overwrites membres', () => {
  let list = inheritedOverwrites(null, OWNER);
  list = tv.banOverwrites(list, [BOB]);
  assert.deepEqual(tv.memberLists(list, OWNER), { banned: [BOB], allowed: [] });
  list = tv.permitOverwrites(list, [BOB, CAROL]);
  assert.deepEqual(tv.memberLists(list, OWNER), { banned: [], allowed: [BOB, CAROL] });
  list = tv.transferOverwrites(list, OWNER, BOB);
  const owner = list.find((o) => o.id === OWNER);
  const bob = list.find((o) => o.id === BOB);
  assert.equal(owner.allow & P.MoveMembers, 0n, 'ancien propriétaire sans droits de gestion');
  assert.ok(owner.allow & P.Connect, 'mais peut revenir');
  assert.equal(bob.allow & tv.OWNER_PERMISSIONS, tv.OWNER_PERMISSIONS);
  assert.equal(tv.OWNER_PERMISSIONS & P.ManageChannels, 0n, 'pas de renommage natif : le filtre de noms ne peut pas être contourné');
});

// ---------------------------------------------------------------- dépôt

test('dépôt : migration 9, état, propriétaire, panneau et préférences fusionnées', () => {
  const { db } = memoryDb();
  assert.ok(db.prepare('SELECT 1 FROM _migrations WHERE id = 9').get());
  const repo = new TempVoiceRepository(db);
  repo.create('c1', GUILD, OWNER, { locked: true });
  assert.equal(repo.get('c1').locked, 1);
  assert.equal(repo.get('c1').hidden, 0);
  repo.setState('c1', { hidden: true });
  assert.deepEqual([repo.get('c1').locked, repo.get('c1').hidden], [1, 1]);
  repo.setState('c1', { locked: false });
  assert.deepEqual([repo.get('c1').locked, repo.get('c1').hidden], [0, 1]);
  repo.setOwner('c1', BOB);
  repo.setPanel('c1', 'm1');
  assert.equal(repo.get('c1').owner_id, BOB);
  assert.equal(repo.get('c1').panel_message_id, 'm1');

  assert.equal(repo.getPrefs(GUILD, OWNER), null);
  repo.savePrefs(GUILD, OWNER, { name: 'Chez moi' });
  repo.savePrefs(GUILD, OWNER, { limit: 4 });
  repo.savePrefs(GUILD, OWNER, { locked: true });
  const p = repo.getPrefs(GUILD, OWNER);
  assert.deepEqual([p.name, p.user_limit, p.locked], ['Chez moi', 4, 1]);
  assert.equal(repo.countPrefs(GUILD), 1);
  assert.equal(repo.deletePrefs(GUILD, OWNER), true);
});

// ---------------------------------------------------------------- service

test('création : catégorie héritée, panneau posté avec mention, préférences réappliquées', async () => {
  const w = world();
  const first = await joinHub(w);
  assert.equal(first.parentId, CAT);
  assert.equal(first.name, 'Vocal de Pseudo1');
  const everyone = first.permissionOverwrites.cache.get(GUILD);
  assert.ok(everyone.deny.has(P.ViewChannel), 'catégorie privée conservée (inheritedOverwrites)');
  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0].content, `<@${OWNER}>`);
  assert.deepEqual(first.sent[0].allowedMentions, { users: [OWNER] });
  assert.ok(w.repo.get(first.id).panel_message_id, 'message du panneau mémorisé');

  // Le propriétaire règle son salon : ses préférences sont mémorisées.
  await w.service.rename(first, 'Chez Bob', OWNER);
  await w.service.setLimit(first, 5, OWNER);
  await w.service.setAccess(first, 'lock', true, OWNER);
  // Un modérateur qui agit ne modifie pas les préférences du propriétaire.
  await w.service.setLimit(first, 9, MOD);
  assert.equal(w.repo.getPrefs(GUILD, OWNER).user_limit, 5);

  // Départ : salon supprimé ; nouveau vocal avec les préférences.
  w.guild.members.cache.get(OWNER).voice.disconnect();
  await w.service.handleVoiceUpdate({ guild: w.guild, channelId: first.id, id: OWNER, member: w.guild.members.cache.get(OWNER) }, { guild: w.guild, channelId: null, id: OWNER });
  assert.equal(w.repo.get(first.id), undefined);
  w.service.hubCooldowns.release(`${GUILD}:${OWNER}`);
  const second = await joinHub(w);
  assert.equal(second.name, 'Chez Bob');
  assert.equal(second.userLimit, 5);
  assert.equal(w.repo.get(second.id).locked, 1);
  assert.ok(second.permissionOverwrites.cache.get(GUILD).deny.has(P.Connect), 'recréé verrouillé');
  assert.ok(second.permissionOverwrites.cache.get(GUILD).deny.has(P.ViewChannel), 'et toujours privé');
});

test('création : préférence de nom devenue interdite, limite par défaut, panneau désactivé', async () => {
  const w = world();
  w.repo.savePrefs(GUILD, OWNER, { name: 'Salon arnaque' });
  w.config.update(GUILD, {
    tempVoice: { defaultLimit: 3, panel: false, nameTemplate: '{n} · {pseudo}' },
    automod: { enabled: true, filters: { badWords: { enabled: true, words: ['arnaque'] } } },
  });
  const ch = await joinHub(w);
  assert.equal(ch.name, '1 · Pseudo1');
  assert.equal(ch.userLimit, 3);
  assert.equal(w.repo.get(ch.id).panel_message_id, null);
  assert.ok(!ch.sent[0]?.components, 'carte d\'accueil simple sans panneau');
});

test('renommage : filtre, 2 renommages / 10 min, file d\'attente et limite de Discord', async () => {
  const w = world();
  const ch = await joinHub(w);
  w.config.update(GUILD, { automod: { enabled: true, filters: { badWords: { enabled: true, words: ['con'] } } } });
  await assert.rejects(w.service.rename(ch, 'Les c0n', OWNER), { name: 'UserError' });
  assert.deepEqual(await w.service.rename(ch, 'Un', OWNER, 1_000), { name: 'Un', queued: false });
  assert.deepEqual(await w.service.rename(ch, 'Deux', OWNER, 2_000), { name: 'Deux', queued: false });
  await assert.rejects(w.service.rename(ch, 'Trois', OWNER, 3_000), (err) => err.name === 'UserError' && /2 toutes les 10 minutes/.test(err.message));
  assert.deepEqual(await w.service.rename(ch, 'Trois', OWNER, 1_000 + tv.RENAME_WINDOW_MS + 1), { name: 'Trois', queued: false });

  const ch2 = await joinHub(w, BOB);
  ch2.renameHang = true;
  assert.deepEqual(await w.service.rename(ch2, 'Patience', BOB), { name: 'Patience', queued: true });
  ch2.renameHang = false;
  ch2.renameError = Object.assign(new Error('rate limited'), { status: 429 });
  await assert.rejects(w.service.rename(ch2, 'Encore', BOB), { name: 'UserError' });
});

test('service : expulsion protégée, bannissement, réclamation et transfert', async () => {
  const w = world();
  const ch = await joinHub(w);
  const [bob, carol, mod] = [BOB, CAROL, MOD].map((id) => w.guild.members.cache.get(id));
  for (const m of [bob, carol, mod]) ch.members.set(m.id, m);

  const kicked = await w.service.kick(ch, [BOB, MOD, OWNER], { actorId: OWNER, staff: false });
  assert.deepEqual(kicked.done, [BOB]);
  assert.deepEqual(kicked.refused, [MOD], 'un propriétaire n\'expulse pas un modérateur');
  assert.ok(bob.disconnected);

  const banned = await w.service.ban(ch, [CAROL, ME], { actorId: OWNER, staff: false });
  assert.deepEqual(banned.done, [CAROL]);
  assert.deepEqual(banned.refused, [ME]);
  assert.ok(ch.permissionOverwrites.cache.get(CAROL).deny.has(P.Connect));
  assert.ok(carol.disconnected, 'banni présent déconnecté');

  await assert.rejects(w.service.claim(ch, MOD), /toujours connecté/);
  ch.members.delete(OWNER);
  await w.service.claim(ch, MOD);
  assert.equal(w.repo.get(ch.id).owner_id, MOD);
  assert.ok(ch.permissionOverwrites.cache.get(MOD).allow.has(P.MoveMembers));
  assert.ok(!ch.permissionOverwrites.cache.get(OWNER).allow.has(P.MoveMembers));
  await assert.rejects(w.service.transfer(ch, BOB), /connecté/);
});

test('service : le départ du propriétaire met le panneau à jour', async () => {
  const w = world();
  const ch = await joinHub(w);
  const bob = w.guild.members.cache.get(BOB);
  ch.members.set(BOB, bob);
  ch.members.delete(OWNER);
  await w.service.handleVoiceUpdate({ guild: w.guild, channelId: ch.id, id: OWNER, member: w.guild.members.cache.get(OWNER) }, { guild: w.guild, channelId: null, id: OWNER });
  const msg = ch.messagesById.get(w.repo.get(ch.id).panel_message_id);
  assert.match(json(msg.payload.embeds[0]).description, /réclamer/);
  assert.equal(msg.payload.content, null, 'la mention n\'est pas renvoyée');
});

// ---------------------------------------------------------------- panneau : rendu

test('panneau : limites Discord, routage, débit selon le boost', async () => {
  for (const premiumTier of [0, 3]) {
    const w = world({ premiumTier });
    const ch = await joinHub(w);
    const payload = w.service.panel(ch, '✅ Notification');
    const ids = assertRouted(payload, `panneau (boost ${premiumTier})`);
    for (const a of ['lock:on', 'hide:on', 'rename', 'limit', 'claim', 'kick', 'ban', 'permit', 'transfer', 'bitrate', 'region']) assert.ok(ids.includes(`cmd:tempvoice:${a}`), a);
    const bitrates = payload.components.map(json).flatMap((r) => r.components).find((c) => c.custom_id === 'cmd:tempvoice:bitrate').options.map((o) => Number(o.value));
    assert.equal(Math.max(...bitrates), premiumTier === 0 ? 96 : 384);
    // État verrouillé / masqué : boutons inverses.
    w.repo.setState(ch.id, { locked: true, hidden: true });
    const ids2 = assertRouted(w.service.panel(ch), 'panneau verrouillé');
    assert.ok(ids2.includes('cmd:tempvoice:lock:off') && ids2.includes('cmd:tempvoice:hide:off'));
  }
});

// ---------------------------------------------------------------- panneau : gestionnaires

test('panneau : verrouiller, renommer, limite, débit, région par le propriétaire', async () => {
  const w = world();
  const ch = await joinHub(w);
  let i = interaction(w, ch, OWNER);
  await tempvoice.buttons.lock(i, w.client, ['on']);
  assert.equal(w.repo.get(ch.id).locked, 1);
  assert.ok(ch.permissionOverwrites.cache.get(GUILD).deny.has(P.Connect));
  assert.ok(assertRouted(last(i, 'editReply'), 'après verrou').includes('cmd:tempvoice:lock:off'), 'panneau mis à jour');
  await assert.rejects(tempvoice.buttons.lock(interaction(w, ch, OWNER), w.client, ['toggle']), { name: 'UserError' });

  i = interaction(w, ch, OWNER);
  await tempvoice.buttons.rename(i, w.client);
  assert.equal(json(last(i, 'showModal')).custom_id, 'cmd:tempvoice:renamesubmit');
  i = interaction(w, ch, OWNER, { fields: modalFields({ name: '@everyone venez' }) });
  await assert.rejects(tempvoice.buttons.renamesubmit(i, w.client), { name: 'UserError' });
  assert.equal(i.calls.length, 0, 'refus immédiat, avant tout appel');
  i = interaction(w, ch, OWNER, { fields: modalFields({ name: 'QG' }) });
  await tempvoice.buttons.renamesubmit(i, w.client);
  assert.equal(ch.name, 'QG');

  i = interaction(w, ch, OWNER, { fields: modalFields({ limit: '150' }) });
  await assert.rejects(tempvoice.buttons.limitsubmit(i, w.client), { name: 'UserError' });
  i = interaction(w, ch, OWNER, { fields: modalFields({ limit: '4' }) });
  await tempvoice.buttons.limitsubmit(i, w.client);
  assert.equal(ch.userLimit, 4);

  await assert.rejects(tempvoice.buttons.bitrate(interaction(w, ch, OWNER, { values: ['384'] }), w.client), /96 kb\/s/);
  await tempvoice.buttons.bitrate(interaction(w, ch, OWNER, { values: ['96'] }), w.client);
  assert.equal(ch.bitrate, 96_000);
  await assert.rejects(tempvoice.buttons.region(interaction(w, ch, OWNER, { values: ['mars'] }), w.client), { name: 'UserError' });
  await tempvoice.buttons.region(interaction(w, ch, OWNER, { values: ['rotterdam'] }), w.client);
  assert.equal(ch.rtcRegion, 'rotterdam');
  await tempvoice.buttons.region(interaction(w, ch, OWNER, { values: ['auto'] }), w.client);
  assert.equal(ch.rtcRegion, null);
});

test('panneau : menus éphémères expulser / bannir / autoriser / transférer', async () => {
  const w = world();
  const ch = await joinHub(w);
  for (const id of [BOB, CAROL]) ch.members.set(id, w.guild.members.cache.get(id));

  for (const action of ['kick', 'ban', 'permit', 'transfer']) {
    const i = interaction(w, ch, OWNER);
    await tempvoice.buttons[action](i, w.client);
    const reply = last(i, 'reply');
    assert.equal(reply.ephemeral, true, action);
    assertRouted(reply, `menu ${action}`);
  }
  let i = interaction(w, ch, OWNER, { values: [BOB] });
  await tempvoice.buttons.kicksel(i, w.client);
  assert.ok(w.guild.members.cache.get(BOB).disconnected);
  assert.equal(last(i, 'editReply').components.length, 0);
  assert.match(json(ch.messagesById.get(w.repo.get(ch.id).panel_message_id).payload.embeds[0]).description, /expulsé/);

  i = interaction(w, ch, OWNER, { values: [BOB] });
  await tempvoice.buttons.bansel(i, w.client);
  assert.ok(ch.permissionOverwrites.cache.get(BOB).deny.has(P.Connect));
  i = interaction(w, ch, OWNER, { values: [BOB] });
  await tempvoice.buttons.permitsel(i, w.client);
  assert.ok(ch.permissionOverwrites.cache.get(BOB).allow.has(P.Connect));

  await assert.rejects(tempvoice.buttons.transfersel(interaction(w, ch, OWNER, { values: [BOB] }), w.client), /connecté/);
  await tempvoice.buttons.transfersel(interaction(w, ch, OWNER, { values: [CAROL] }), w.client);
  assert.equal(w.repo.get(ch.id).owner_id, CAROL);
  // L'ancien propriétaire n'a plus la main.
  await assert.rejects(tempvoice.buttons.lock(interaction(w, ch, OWNER), w.client, ['on']), { name: 'UserError' });
});

test('panneau : réclamer seulement si le propriétaire est parti et qu\'on est connecté', async () => {
  const w = world();
  const ch = await joinHub(w);
  ch.members.set(BOB, w.guild.members.cache.get(BOB));
  await assert.rejects(tempvoice.buttons.claim(interaction(w, ch, BOB), w.client), /toujours connecté/);
  ch.members.delete(OWNER);
  await assert.rejects(tempvoice.buttons.claim(interaction(w, ch, CAROL), w.client), /Rejoignez/);
  const i = interaction(w, ch, BOB);
  await tempvoice.buttons.claim(i, w.client);
  assert.equal(w.repo.get(ch.id).owner_id, BOB);
  assert.match(json(last(i, 'editReply').embeds[0]).description, /nouveau propriétaire/);
});

test('panneau : un modérateur peut agir sur n\'importe quel vocal', async () => {
  const w = world();
  const ch = await joinHub(w);
  const i = interaction(w, ch, MOD);
  await tempvoice.buttons.hide(i, w.client, ['on']);
  assert.equal(w.repo.get(ch.id).hidden, 1);
  assert.ok(ch.permissionOverwrites.cache.get(GUILD).deny.has(P.ViewChannel));
  await tempvoice.buttons.hide(interaction(w, ch, MOD), w.client, ['off']);
  assert.equal(w.repo.get(ch.id).hidden, 0);
  assert.ok(ch.permissionOverwrites.cache.get(GUILD).deny.has(P.ViewChannel), 'catégorie privée : reste privé');
});

// ---------------------------------------------------------------- tableau de bord

test('chaque vue du tableau de bord respecte les limites Discord et route vers un gestionnaire', async () => {
  const w = world();
  await joinHub(w);
  for (const v of ['home', 'salons', 'defaults', 'inconnue']) assertRouted(tempvoice.render(w.client, w.guild, v, '✅ Notification'), v);
  // Sans salon créateur : bouton de création automatique.
  w.config.update(GUILD, { tempVoice: { hubChannelId: null, enabled: false } });
  const ids = assertRouted(tempvoice.render(w.client, w.guild, 'home'), 'home sans hub');
  assert.ok(ids.includes('cmd:tempvoice:createhub'));
  assert.ok(ids.includes('cmd:tempvoice:power:on'));
  // Ancien panneau d'état toujours routé.
  assertRouted(tempvoice.statusPanel(w.client, w.guild), 'statut');
});

test('tableau de bord : salon créateur, catégorie, nom, limite, interrupteurs', async () => {
  const w = world();
  const admin = (extra) => ({ ...interaction(w, null, MOD, extra), memberPermissions: perm(P.ManageChannels) });
  const tvc = () => w.config.get(GUILD).tempVoice;

  await assert.rejects(tempvoice.buttons.hub(admin({ values: [CAT] }), w.client), { name: 'UserError' });
  const ch = await joinHub(w);
  await assert.rejects(tempvoice.buttons.hub(admin({ values: [ch.id] }), w.client), /vocal temporaire/);
  const other = fakeVoice(w.guild, { id: '500000000000000002', name: 'Autre' });
  await tempvoice.buttons.hub(admin({ values: [other.id] }), w.client);
  assert.equal(tvc().hubChannelId, other.id);

  await tempvoice.buttons.category(admin({ values: [CAT] }), w.client);
  assert.equal(tvc().categoryId, CAT);
  await tempvoice.buttons.category(admin({ values: [] }), w.client);
  assert.equal(tvc().categoryId, null);
  await assert.rejects(tempvoice.buttons.category(admin({ values: [HUB] }), w.client), { name: 'UserError' });

  await assert.rejects(tempvoice.buttons.namesubmit(admin({ fields: modalFields({ template: '@everyone {pseudo}' }) }), w.client), { name: 'UserError' });
  await assert.rejects(tempvoice.buttons.namesubmit(admin({ fields: modalFields({ template: '{pseudo}{username}{pseudo}{username}' }) }), w.client), /raccourcissez/);
  await tempvoice.buttons.namesubmit(admin({ fields: modalFields({ template: '🎮 {pseudo}' }) }), w.client);
  assert.equal(tvc().nameTemplate, '🎮 {pseudo}');

  await assert.rejects(tempvoice.buttons.deflimitsubmit(admin({ fields: modalFields({ limit: 'x' }) }), w.client), { name: 'UserError' });
  await tempvoice.buttons.deflimitsubmit(admin({ fields: modalFields({ limit: '8' }) }), w.client);
  assert.equal(tvc().defaultLimit, 8);

  await tempvoice.buttons.remember(admin(), w.client, ['off']);
  assert.equal(tvc().rememberPrefs, false);
  await tempvoice.buttons.remember(admin(), w.client, ['off']);
  assert.equal(tvc().rememberPrefs, false, 'valeur cible, pas d\'inversion');
  await tempvoice.buttons.panelopt(admin(), w.client, ['off']);
  assert.equal(tvc().panel, false);
  await assert.rejects(tempvoice.buttons.panelopt(admin(), w.client, ['maybe']), { name: 'UserError' });

  await tempvoice.buttons.power(admin(), w.client, ['off']);
  assert.equal(tvc().enabled, false);
  w.config.update(GUILD, { tempVoice: { hubChannelId: null } });
  await assert.rejects(tempvoice.buttons.power(admin(), w.client, ['on']), /salon créateur/);

  // Création automatique : dans la catégorie, permissions de la catégorie copiées.
  w.config.update(GUILD, { tempVoice: { categoryId: CAT } });
  const i = admin();
  await tempvoice.buttons.createhub(i, w.client);
  const hub = w.guild.channels.cache.get(tvc().hubChannelId);
  assert.equal(hub.parentId, CAT);
  assert.ok(hub.permissionOverwrites.cache.get(GUILD).deny.has(P.ViewChannel));
  assert.equal(tvc().enabled, true);
  assert.ok(last(i, 'editReply'));
});

test('tous les gestionnaires de /tempvoice refusent sans permission (ni propriétaire, ni modérateur)', async () => {
  const w = world();
  const ch = await joinHub(w);
  ch.members.set(BOB, w.guild.members.cache.get(BOB)); // le propriétaire est là : réclamation refusée aussi
  for (const [name, handler] of Object.entries(tempvoice.buttons)) {
    const i = interaction(w, ch, CAROL, { values: [BOB], fields: modalFields({ name: 'x', limit: '1', template: 'x' }) });
    await assert.rejects(handler(i, w.client, ['on']), { name: 'UserError' }, name);
    assert.equal(i.calls.length, 0, `${name} : aucune réponse avant le refus`);
  }
});
