'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { LevelRepository, MAX_XP } = require('../src/database/repositories/LevelRepository');
const L = require('../src/services/LevelService');
const niveaux = require('../src/commands/levels/niveaux');
const classement = require('../src/commands/levels/classement');
const rang = require('../src/commands/levels/rang');
const levelEvents = require('../src/events/levels');

const { LevelService, xpForLevel, totalXpForLevel, levelFromXp, progressOf } = L;
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GUILD = '100000000000000001';
const BOT = '999999999999999999';
const ADMIN = '200000000000000001';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const CHAN = '400000000000000001';
const CHAN2 = '400000000000000002';
const CATEGORY = '400000000000000009';
const VOICE = '400000000000000010';
const AFK = '400000000000000011';
const ROLE_LOW = '300000000000000001';
const ROLE_MID = '300000000000000002';
const ROLE_HIGH = '300000000000000003'; // au-dessus du bot
const ROLE_BOOST = '300000000000000004';
const ROLE_MOD = '300000000000000005'; // permissions de modération

// ---------------------------------------------------------------- faux Discord

function fakeRole(id, position, extra = {}) {
  return { id, name: `role-${id.slice(-1)}`, position, managed: false, permissions: new PermissionsBitField(extra.perms ?? 0n), toString: () => `<@&${id}>`, ...extra };
}

function fakeChannel(id, extra = {}) {
  const ch = {
    id,
    type: ChannelType.GuildText,
    parentId: null,
    sent: [],
    isTextBased: () => true,
    send: async (p) => ch.sent.push(p),
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    toString: () => `<#${id}>`,
    ...extra,
  };
  return ch;
}

function fakeMember(guild, id, { roles = [], position = 1, bot = false } = {}) {
  const cache = new Collection(roles.map((r) => [r, guild.roles.cache.get(r) ?? { id: r }]));
  const m = {
    id,
    guild,
    user: { id, bot, username: `user${id.slice(-1)}` },
    displayName: `Membre ${id.slice(-1)}`,
    dms: [],
    roles: {
      cache,
      highest: { position },
      add: async (ids) => [].concat(ids).forEach((r) => cache.set(r, guild.roles.cache.get(r))),
      remove: async (ids) => [].concat(ids).forEach((r) => cache.delete(r)),
    },
    send: async (p) => m.dms.push(p),
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    toString: () => `<@${id}>`,
  };
  return m;
}

function fakeGuild() {
  const roles = new Collection();
  const guild = {
    id: GUILD,
    name: 'Serveur test',
    ownerId: '200000000000000099',
    afkChannelId: AFK,
    roles: { cache: roles },
    channels: { cache: new Collection() },
    voiceStates: { cache: new Collection() },
    members: { cache: new Collection() },
  };
  roles.set(GUILD, fakeRole(GUILD, 0));
  roles.set(ROLE_LOW, fakeRole(ROLE_LOW, 2));
  roles.set(ROLE_MID, fakeRole(ROLE_MID, 3));
  roles.set(ROLE_BOOST, fakeRole(ROLE_BOOST, 4));
  roles.set(ROLE_MOD, fakeRole(ROLE_MOD, 5, { perms: PermissionFlagsBits.BanMembers }));
  roles.set(ROLE_HIGH, fakeRole(ROLE_HIGH, 20));
  guild.members.me = { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All), roles: { highest: { position: 10 } } };
  guild.members.fetch = async (id) => guild.members.cache.get(id) ?? Promise.reject(new Error('Unknown Member'));
  for (const id of [CHAN, CHAN2]) guild.channels.cache.set(id, fakeChannel(id));
  guild.channels.cache.set(CATEGORY, fakeChannel(CATEGORY, { type: ChannelType.GuildCategory, isTextBased: () => false }));
  guild.channels.cache.set(VOICE, fakeChannel(VOICE, { type: ChannelType.GuildVoice, members: new Collection() }));
  guild.channels.cache.set(AFK, fakeChannel(AFK, { type: ChannelType.GuildVoice, members: new Collection() }));
  return guild;
}

function world({ enabled = true } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new LevelRepository(db);
  const guild = fakeGuild();
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) }, repositories: { levels: repo } };
  const levels = new LevelService({ client, levels: repo, config, rng: () => 0, grantDelayMs: 5 });
  client.services = { config, levels, logging: { suppressed: new Map() } };
  if (enabled) config.update(GUILD, { levels: { enabled: true } });
  const alice = fakeMember(guild, ALICE, { position: 1 });
  const admin = fakeMember(guild, ADMIN, { position: 15 });
  guild.members.cache.set(ALICE, alice);
  guild.members.cache.set(ADMIN, admin);
  return { db, config, repo, guild, client, levels, alice, admin };
}

let seq = 0;
function fakeMessage(w, { member = w.alice, content = 'Bonjour tout le monde', channel = w.guild.channels.cache.get(CHAN), ...extra } = {}) {
  seq += 1;
  return { id: `5000000000000${String(seq).padStart(5, '0')}`, guild: w.guild, author: member.user, member, channel, content, webhookId: null, system: false, ...extra };
}

// ---------------------------------------------------------------- formule

test('formule : paliers 5n²+50n+100, cumul et niveau', () => {
  assert.deepEqual([0, 1, 2, 3].map(xpForLevel), [100, 155, 220, 295]);
  assert.deepEqual([0, 1, 2, 3, 4].map(totalXpForLevel), [0, 100, 255, 475, 770]);
  let sum = 0;
  for (let n = 0; n < 300; n += 1) {
    assert.equal(totalXpForLevel(n), sum, `cumul au niveau ${n}`);
    sum += xpForLevel(n);
  }
  assert.equal(levelFromXp(0), 0);
  assert.equal(levelFromXp(99), 0);
  assert.equal(levelFromXp(100), 1);
  assert.equal(levelFromXp(254), 1);
  assert.equal(levelFromXp(255), 2);
  assert.equal(levelFromXp(-5), 0);
  assert.equal(levelFromXp('abc'), 0);
  assert.ok(levelFromXp(MAX_XP) < L.MAX_LEVEL);
  for (let n = 0; n < 60; n += 1) assert.equal(levelFromXp(totalXpForLevel(n)), n);
  assert.deepEqual(progressOf(300), { level: 2, current: 45, needed: 220, remaining: 175, ratio: 45 / 220 });
});

test('aléatoire, multiplicateurs, récompenses et modèle d\'annonce', () => {
  assert.equal(L.randomXp(15, 25, () => 0), 15);
  assert.equal(L.randomXp(15, 25, () => 0.99999), 25);
  assert.equal(L.randomXp(25, 15, () => 0), 15, 'bornes inversées');
  assert.equal(L.multiplierFor([ROLE_LOW], []), 1);
  assert.equal(L.multiplierFor([ROLE_LOW, ROLE_BOOST], [{ roleId: ROLE_BOOST, multiplier: 2 }, { roleId: ROLE_LOW, multiplier: 0.5 }]), 2);
  assert.equal(L.multiplierFor([ROLE_LOW], [{ roleId: ROLE_LOW, multiplier: 0.5 }]), 0.5);

  const rewards = [{ level: 5, roleId: 'A' }, { level: 10, roleId: 'B' }, { level: 20, roleId: 'C' }];
  assert.deepEqual(L.rewardPlan(12, rewards, true).eligible, ['A', 'B']);
  assert.deepEqual(L.rewardPlan(12, rewards, false).eligible, ['B']);
  assert.deepEqual(L.rewardPlan(12, rewards, false).lower, ['A']);
  assert.deepEqual(L.rewardPlan(12, rewards, true).ineligible, ['C']);
  assert.deepEqual(L.rewardPlan(2, rewards, true).eligible, []);

  assert.equal(L.renderTemplate('GG {membre}, niveau {niveau} sur {serveur} ({pseudo})', { member: '<@1>', level: 3, name: 'Bob', server: 'S' }), 'GG <@1>, niveau 3 sur S (Bob)');
  assert.ok(L.renderTemplate(null, { member: '<@1>', level: 2 }).includes('<@1>'));
});

test('exclusions : salon, fil (parent), catégorie, rôle ; vocal éligible', () => {
  assert.equal(L.isIgnoredChannel({ id: 'T', parentId: 'C' }, ['C']), true);
  assert.equal(L.isIgnoredChannel({ id: 'T', parentId: 'C', parent: { parentId: 'CAT' } }, ['CAT']), true);
  assert.equal(L.isIgnoredChannel({ id: 'X', parentId: 'C' }, ['Z']), false);
  assert.equal(L.hasIgnoredRole({ roles: { cache: new Collection([['R', {}]]) } }, ['R']), true);

  const human = (id) => ({ id, user: { bot: false } });
  const channel = { members: new Collection([['1', human('1')], ['2', human('2')]]) };
  const guild = { afkChannelId: 'AFK' };
  assert.equal(L.isVoiceEligible({ id: '1', channelId: 'V', channel }, guild), true);
  assert.equal(L.isVoiceEligible({ id: '1', channelId: 'V', channel, selfMute: true }, guild), false, 'muet');
  assert.equal(L.isVoiceEligible({ id: '1', channelId: 'V', channel, serverDeaf: true }, guild), false, 'sourd');
  assert.equal(L.isVoiceEligible({ id: '1', channelId: 'AFK', channel }, guild), false, 'AFK');
  const alone = { members: new Collection([['1', human('1')], ['9', { id: '9', user: { bot: true } }]]) };
  assert.equal(L.isVoiceEligible({ id: '1', channelId: 'V', channel: alone }, guild), false, 'seul avec un bot');
});

// ---------------------------------------------------------------- dépôt

test('dépôt : ajout, classement paginé, rang, remises à zéro, import', () => {
  const { repo } = world();
  repo.add(GUILD, ALICE, { xp: 300, messages: 1, at: 1 }, levelFromXp);
  const r = repo.add(GUILD, ALICE, { xp: 20, messages: 1, voiceMinutes: 2 }, levelFromXp);
  assert.equal(r.before.xp, 300);
  assert.deepEqual({ xp: r.after.xp, level: r.after.level, messages: r.after.messages, voice: r.after.voice_minutes, at: r.after.last_message_at }, { xp: 320, level: 2, messages: 2, voice: 2, at: 1 });
  repo.add(GUILD, BOB, { xp: 320 }, levelFromXp); // égalité : départagé par identifiant
  repo.add(GUILD, ADMIN, { xp: 50 }, levelFromXp);
  repo.add('100000000000000002', ALICE, { xp: 9999 }, levelFromXp); // autre serveur
  assert.equal(repo.count(GUILD), 3);
  assert.deepEqual(repo.leaderboard(GUILD, 10, 0).map((x) => x.user_id), [ALICE, BOB, ADMIN]);
  assert.deepEqual(repo.leaderboard(GUILD, 2, 2).map((x) => x.user_id), [ADMIN]);
  assert.equal(repo.rank(GUILD, ALICE), 1);
  assert.equal(repo.rank(GUILD, BOB), 2);
  assert.equal(repo.rank(GUILD, ADMIN), 3);
  assert.equal(repo.rank(GUILD, '200000000000000077'), null);
  assert.equal(repo.setXp(GUILD, ADMIN, -50, levelFromXp).after.xp, 0, 'jamais négatif');
  assert.equal(repo.setXp(GUILD, ADMIN, MAX_XP * 10, levelFromXp).after.xp, MAX_XP, 'plafonné');
  assert.equal(repo.resetMember(GUILD, ADMIN), 1);
  assert.equal(repo.count(GUILD), 2);
  assert.equal(repo.importMany(GUILD, [{ userId: ADMIN, xp: 1000 }, { userId: ALICE, xp: 5 }], levelFromXp), 2);
  assert.equal(repo.get(GUILD, ADMIN).level, levelFromXp(1000));
  assert.equal(repo.get(GUILD, ALICE).messages, 2, 'import : compteurs conservés');
  assert.equal(repo.resetGuild(GUILD), 3);
  assert.equal(repo.count('100000000000000002'), 1, 'autre serveur intact');
});

// ---------------------------------------------------------------- messages

test('messages : désactivé par défaut, bots, courts, exclusions, cooldown', () => {
  const off = world({ enabled: false });
  assert.equal(off.config.get(GUILD).levels.enabled, false, 'désactivé par défaut');
  assert.equal(off.levels.handleMessage(fakeMessage(off)), false);

  const w = world();
  w.config.update(GUILD, { levels: { ignoredChannels: [CATEGORY], ignoredRoles: [ROLE_MID] } });
  const botMember = fakeMember(w.guild, BOB, { bot: true });
  assert.equal(w.levels.handleMessage(fakeMessage(w, { member: botMember })), false, 'bot');
  assert.equal(w.levels.handleMessage(fakeMessage(w, { content: 'ok' })), false, '< 3 caractères');
  assert.equal(w.levels.handleMessage(fakeMessage(w, { content: '   a  ' })), false, 'espaces ignorés');
  assert.equal(w.levels.handleMessage(fakeMessage(w, { webhookId: '1' })), false, 'webhook');
  assert.equal(w.levels.handleMessage(fakeMessage(w, { channel: { id: '400000000000000050', parentId: CATEGORY } })), false, 'catégorie exclue');
  const muted = fakeMember(w.guild, BOB, { roles: [ROLE_MID] });
  assert.equal(w.levels.handleMessage(fakeMessage(w, { member: muted })), false, 'rôle exclu');
  assert.equal(w.levels.handleMessage(fakeMessage(w)), true);
  assert.equal(w.levels.handleMessage(fakeMessage(w)), false, 'cooldown');
  w.levels.cooldowns.clear();
  assert.equal(w.levels.handleMessage(fakeMessage(w)), true);
  return w.levels.stop();
});

test('messages : XP accordée après le délai, jamais pour un message supprimé (AutoMod ou modérateur)', async () => {
  const w = world();
  w.config.update(GUILD, { levels: { cooldownSeconds: 0 } });
  const kept = fakeMessage(w);
  w.levels.handleMessage(kept);
  assert.equal(w.repo.get(GUILD, ALICE), null, 'pas encore : on laisse passer l\'AutoMod');
  await sleep(30);
  assert.equal(w.repo.get(GUILD, ALICE).xp, 15);
  assert.equal(w.repo.get(GUILD, ALICE).messages, 1);

  // Supprimé par un modérateur (événement messageDelete).
  const deleted = fakeMessage(w);
  w.levels.handleMessage(deleted);
  levelEvents.find((e) => e.name === 'messageDelete').execute(w.client, { id: deleted.id });
  // Supprimé par l'AutoMod : marque posée dans LoggingService, lue sans être consommée.
  const automod = fakeMessage(w);
  w.levels.handleMessage(automod);
  w.client.services.logging.suppressed.set(automod.id, Date.now() + 30_000);
  await sleep(30);
  assert.equal(w.repo.get(GUILD, ALICE).xp, 15, 'aucune XP pour les messages supprimés');
  assert.ok(w.client.services.logging.suppressed.has(automod.id), 'la marque reste pour le log messageDelete');
});

test('messages : multiplicateur, passage de niveau, récompenses et annonce limitée au membre', async () => {
  const w = world();
  w.config.update(GUILD, {
    levels: {
      multipliers: [{ roleId: ROLE_BOOST, multiplier: 2 }],
      rewards: [{ level: 1, roleId: ROLE_LOW }, { level: 1, roleId: ROLE_HIGH }],
      announce: { mode: 'same', message: 'GG {membre} → {niveau}' },
    },
  });
  w.alice.roles.cache.set(ROLE_BOOST, w.guild.roles.cache.get(ROLE_BOOST));
  w.repo.setXp(GUILD, ALICE, 80, levelFromXp);
  const channel = w.guild.channels.cache.get(CHAN);
  const r = await w.levels.grantMessage(fakeMessage(w, { channel }));
  assert.equal(r.after.xp, 80 + 30, '15 × 2');
  assert.equal(r.leveledUp, true);
  assert.ok(w.alice.roles.cache.has(ROLE_LOW), 'récompense attribuée');
  assert.ok(!w.alice.roles.cache.has(ROLE_HIGH), 'rôle au-dessus du bot ignoré');
  assert.equal(channel.sent.length, 1);
  const sent = channel.sent[0];
  assert.deepEqual(sent.allowedMentions, { parse: [], users: [ALICE] });
  assert.equal(sent.content, `<@${ALICE}>`);
  const embed = json(sent.embeds[0]);
  assert.ok(embed.description.startsWith(`GG <@${ALICE}> → 1`));
  assert.ok(embed.description.includes(`<@&${ROLE_LOW}>`));
});

test('annonces : désactivées, salon dédié, MP, salon sans permission', async () => {
  const w = world();
  const cfg = () => w.config.get(GUILD).levels;
  const msgChannel = w.guild.channels.cache.get(CHAN);
  const dedicated = w.guild.channels.cache.get(CHAN2);
  w.config.update(GUILD, { levels: { announce: { mode: 'off' } } });
  assert.equal(await w.levels.announce(w.alice, 3, cfg(), { channel: msgChannel }), false);
  w.config.update(GUILD, { levels: { announce: { mode: 'channel', channelId: CHAN2 } } });
  assert.equal(await w.levels.announce(w.alice, 3, cfg(), { channel: msgChannel }), true);
  assert.equal(dedicated.sent.length, 1);
  assert.equal(msgChannel.sent.length, 0);
  w.config.update(GUILD, { levels: { announce: { mode: 'dm' } } });
  assert.equal(await w.levels.announce(w.alice, 3, cfg(), { channel: msgChannel }), true);
  assert.equal(w.alice.dms.length, 1);
  assert.equal(w.alice.dms[0].content, undefined, 'MP : pas de mention');
  w.config.update(GUILD, { levels: { announce: { mode: 'same' } } });
  const locked = fakeChannel(CHAN, { permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel) });
  assert.equal(await w.levels.announce(w.alice, 3, cfg(), { channel: locked }), false);
  assert.equal(locked.sent.length, 0);
});

test('récompenses : plus haute seulement, resynchronisation complète par un admin, reset membre', async () => {
  const w = world();
  w.config.update(GUILD, { levels: { stackRewards: false, rewards: [{ level: 1, roleId: ROLE_LOW }, { level: 2, roleId: ROLE_MID }] } });
  const cfg = w.config.get(GUILD).levels;
  await w.levels.syncRewards(w.alice, 1, cfg);
  assert.ok(w.alice.roles.cache.has(ROLE_LOW));
  await w.levels.syncRewards(w.alice, 2, cfg);
  assert.ok(w.alice.roles.cache.has(ROLE_MID));
  assert.ok(!w.alice.roles.cache.has(ROLE_LOW), 'palier inférieur retiré');

  const up = await w.levels.adminXp(w.guild, ALICE, 'set', totalXpForLevel(2));
  assert.equal(up.after.level, 2);
  const down = await w.levels.adminXp(w.guild, ALICE, 'remove', totalXpForLevel(2));
  assert.equal(down.after.xp, 0);
  assert.ok(!w.alice.roles.cache.has(ROLE_MID), 'récompense non méritée retirée');
  await w.levels.adminXp(w.guild, ALICE, 'give', totalXpForLevel(1));
  assert.ok(w.alice.roles.cache.has(ROLE_LOW));
  await w.levels.resetMember(w.guild, ALICE);
  assert.equal(w.repo.get(GUILD, ALICE), null);
  assert.ok(!w.alice.roles.cache.has(ROLE_LOW), 'reset : rôles retirés');
  // Sans « Gérer les rôles » : rien n'est tenté.
  w.guild.members.me.permissions = new PermissionsBitField(0n);
  assert.deepEqual(await w.levels.syncRewards(w.alice, 5, cfg), { added: [], removed: [] });
});

// ---------------------------------------------------------------- vocal

test('vocal : minutes complètes, ni muet, ni seul, ni AFK ; suivi voiceStateUpdate', async () => {
  const w = world();
  w.config.update(GUILD, { levels: { voice: { enabled: true, xpPerMinute: 10 } } });
  const voice = w.guild.channels.cache.get(VOICE);
  const bob = fakeMember(w.guild, BOB);
  w.guild.members.cache.set(BOB, bob);
  const state = (member, channel, extra = {}) => ({ id: member.id, member, guild: w.guild, channelId: channel?.id ?? null, channel, ...extra });
  voice.members.set(ALICE, w.alice).set(BOB, bob);
  w.guild.voiceStates.cache.set(ALICE, state(w.alice, voice)).set(BOB, state(bob, voice, { selfMute: true }));

  const t0 = 1_000_000;
  assert.equal(await w.levels.voiceTick(t0), 0, 'premier tick : prise en compte des membres connectés');
  assert.equal(await w.levels.voiceTick(t0 + 125_000), 1);
  assert.equal(w.repo.get(GUILD, ALICE).voice_minutes, 2);
  assert.equal(w.repo.get(GUILD, ALICE).xp, 20);
  assert.equal(w.repo.get(GUILD, BOB), null, 'muet : pas d\'XP');

  // Seule dans le salon : pas d'XP, et le temps seul n'est pas rattrapé ensuite.
  voice.members.delete(BOB);
  await w.levels.voiceTick(t0 + 245_000);
  assert.equal(w.repo.get(GUILD, ALICE).voice_minutes, 2);
  voice.members.set(BOB, bob);
  await w.levels.voiceTick(t0 + 305_000);
  assert.equal(w.repo.get(GUILD, ALICE).voice_minutes, 3, 'une seule minute depuis le retour de Bob');

  // AFK, puis déconnexion via voiceStateUpdate.
  const afk = w.guild.channels.cache.get(AFK);
  w.guild.voiceStates.cache.set(ALICE, state(w.alice, afk));
  await w.levels.voiceTick(t0 + 425_000);
  assert.equal(w.repo.get(GUILD, ALICE).voice_minutes, 3, 'AFK');
  const ev = levelEvents.find((e) => e.name === 'voiceStateUpdate');
  ev.execute(w.client, state(w.alice, afk), state(w.alice, null));
  assert.ok(!w.levels.voice.has(`${GUILD}:${ALICE}`));
  ev.execute(w.client, state(w.alice, null), state(w.alice, voice));
  assert.ok(w.levels.voice.has(`${GUILD}:${ALICE}`));

  // XP vocale désactivée : suivi abandonné.
  w.config.update(GUILD, { levels: { voice: { enabled: false } } });
  await w.levels.voiceTick(t0 + 600_000);
  assert.equal(w.levels.voice.size, 0);
});

test('arrêt propre : gains en attente annulés, plus aucune écriture', async () => {
  const w = world();
  w.levels.handleMessage(fakeMessage(w));
  assert.equal(w.levels.pending.size, 1);
  w.levels.start();
  assert.ok(w.levels.timer);
  await w.levels.stop();
  assert.equal(w.levels.pending.size, 0);
  assert.equal(w.levels.timer, null);
  await sleep(20);
  assert.equal(w.repo.get(GUILD, ALICE), null);
  assert.equal(w.levels.handleMessage(fakeMessage(w)), false);
});

test('fichier d\'événements : messageCreate, suppressions, vocal, départs et retours', () => {
  assert.ok(Array.isArray(levelEvents));
  assert.deepEqual(levelEvents.map((e) => e.name).sort(), ['guildMemberAdd', 'guildMemberRemove', 'messageCreate', 'messageDelete', 'messageDeleteBulk', 'voiceStateUpdate']);
  for (const e of levelEvents) assert.equal(typeof e.execute, 'function');
  const w = world();
  levelEvents.find((e) => e.name === 'messageDeleteBulk').execute(w.client, new Collection([['1', {}], ['2', {}]]));
  assert.ok(w.levels.wasDeleted('1') && w.levels.wasDeleted('2'));
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
      if (cmd === 'niveaux') assert.equal(typeof niveaux.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (cmd === 'classement') assert.equal(typeof classement.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25 && c.options.length >= 1);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label} : identifiants en double`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096);
    assert.ok((e.fields ?? []).length <= 25);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256));
  }
}

function interaction(w, extra = {}) {
  const out = { updates: [], replies: [], modals: [], edits: [] };
  const i = {
    guildId: GUILD,
    guild: w.guild,
    user: { id: ADMIN, tag: 'admin', toString: () => `<@${ADMIN}>` },
    member: w.admin,
    memberPermissions: new PermissionsBitField(PermissionsBitField.All),
    values: [],
    update: async (p) => out.updates.push(p),
    reply: async (p) => out.replies.push(p),
    showModal: async (m) => out.modals.push(json(m)),
    deferUpdate: async () => {},
    editReply: async (p) => out.edits.push(p),
    ...extra,
  };
  return { i, out };
}

const modalFields = (values) => ({ getTextInputValue: (id) => values[id] ?? '' });

test('/niveaux : commande unique, chaque vue respecte les limites Discord et route vers un gestionnaire', () => {
  const w = world();
  assert.equal((niveaux.data.toJSON().options ?? []).length, 0);
  // Listes chargées au maximum.
  const ids = (base, n) => Array.from({ length: n }, (_, k) => String(BigInt(base) + BigInt(k)));
  w.config.update(GUILD, {
    levels: {
      rewards: ids('310000000000000000', 25).map((roleId, k) => ({ level: k + 1, roleId })),
      multipliers: ids('320000000000000000', 25).map((roleId) => ({ roleId, multiplier: 1.5 })),
      ignoredChannels: ids('410000000000000000', 25),
      ignoredRoles: ids('330000000000000000', 25),
      announce: { mode: 'channel', message: 'x'.repeat(500) },
    },
  });
  w.repo.add(GUILD, ALICE, { xp: 500 }, levelFromXp);
  const views = ['home', 'announce', 'rewards', 'exclusions', 'multipliers', 'xp', `member:${ALICE}`, `member.${ALICE}`, `member.${BOB}`, 'confirmReset', `confirmMember.${ALICE}`, 'inconnue'];
  for (const v of views) assertValid(niveaux.render(w.client, w.guild, v, '✅ Notification'), v);
  // Vues vides (aucune récompense / aucun multiplicateur) : pas de menu vide.
  const empty = world();
  for (const v of ['rewards', 'multipliers', 'home', 'xp']) assertValid(niveaux.render(empty.client, empty.guild, v), `vide:${v}`);
});

test('/niveaux : tous les gestionnaires refusent sans « Gérer le serveur »', async () => {
  const w = world();
  const { i } = interaction(w, { memberPermissions: new PermissionsBitField(0n), values: ['home'] });
  for (const [name, handler] of Object.entries(niveaux.buttons)) {
    await assert.rejects(handler(i, w.client, ['on']), { name: 'UserError' }, name);
  }
  await assert.rejects(niveaux.execute(i, w.client), { name: 'UserError' });
});

test('/niveaux : activation, réglages validés, annonces', async () => {
  const w = world({ enabled: false });
  let { i, out } = interaction(w);
  await niveaux.execute(i, w.client);
  assert.equal(out.replies[0].ephemeral, true);
  await niveaux.buttons.toggle(i, w.client, ['on']);
  assert.equal(w.config.get(GUILD).levels.enabled, true);
  await niveaux.buttons.toggle(i, w.client, ['on']);
  assert.equal(w.config.get(GUILD).levels.enabled, true, 'valeur cible, pas d\'inversion');
  await assert.rejects(niveaux.buttons.toggle(i, w.client, []), { name: 'UserError' });
  await niveaux.buttons.voice(i, w.client, ['on']);
  assert.equal(w.config.get(GUILD).levels.voice.enabled, true);

  await niveaux.buttons.settings(i, w.client);
  assert.equal(out.modals[0].custom_id, 'cmd:niveaux:settingssubmit');
  assert.ok(out.modals[0].components.every((r) => r.components.every((c) => c.label.length <= 45)));
  i.fields = modalFields({ xpMin: '10', xpMax: '20', cooldown: '30', minLength: '5', voiceXp: '7' });
  await niveaux.buttons.settingssubmit(i, w.client);
  const cfg = w.config.get(GUILD).levels;
  assert.deepEqual([cfg.xpMin, cfg.xpMax, cfg.cooldownSeconds, cfg.minLength, cfg.voice.xpPerMinute, cfg.voice.enabled], [10, 20, 30, 5, 7, true]);
  i.fields = modalFields({ xpMin: '30', xpMax: '20', cooldown: '30', minLength: '5', voiceXp: '7' });
  await assert.rejects(niveaux.buttons.settingssubmit(i, w.client), /minimum/);
  i.fields = modalFields({ xpMin: '0', xpMax: '20', cooldown: '30', minLength: '5', voiceXp: '7' });
  await assert.rejects(niveaux.buttons.settingssubmit(i, w.client), { name: 'UserError' });

  i.values = ['dm'];
  await niveaux.buttons.amode(i, w.client);
  assert.equal(w.config.get(GUILD).levels.announce.mode, 'dm');
  i.values = ['nimporte'];
  await assert.rejects(niveaux.buttons.amode(i, w.client), { name: 'UserError' });
  i.values = [CHAN2];
  await niveaux.buttons.achannel(i, w.client);
  assert.deepEqual([w.config.get(GUILD).levels.announce.mode, w.config.get(GUILD).levels.announce.channelId], ['channel', CHAN2]);
  i.values = [CATEGORY];
  await assert.rejects(niveaux.buttons.achannel(i, w.client), { name: 'UserError' });
  i.fields = modalFields({ message: 'Bravo {membre} !' });
  await niveaux.buttons.amessagesubmit(i, w.client);
  assert.equal(w.config.get(GUILD).levels.announce.message, 'Bravo {membre} !');
  i.fields = modalFields({ message: '' });
  await niveaux.buttons.amessagesubmit(i, w.client);
  assert.equal(w.config.get(GUILD).levels.announce.message, null, 'vide : message par défaut');
  ({ i, out } = interaction(w));
  await niveaux.buttons.apreview(i, w.client);
  assert.equal(out.replies[0].ephemeral, true);
  assert.ok(json(out.replies[0].embeds[0]).description.includes(`<@${ADMIN}>`));
});

test('/niveaux : récompenses (hiérarchie vérifiée), multiplicateurs, exclusions', async () => {
  const w = world();
  const { i, out } = interaction(w);
  // Hiérarchie : au-dessus du bot, permissions de modération, @everyone, au-dessus de l'auteur.
  for (const bad of [ROLE_HIGH, ROLE_MOD, GUILD]) {
    i.values = [bad];
    await assert.rejects(niveaux.buttons.rewardrole(i, w.client), { name: 'UserError' }, bad);
  }
  const lowAdmin = interaction(w, { member: fakeMember(w.guild, ADMIN, { position: 2 }) });
  lowAdmin.i.values = [ROLE_MID];
  await assert.rejects(niveaux.buttons.rewardrole(lowAdmin.i, w.client), /votre rôle/);

  i.values = [ROLE_MID];
  await niveaux.buttons.rewardrole(i, w.client);
  assert.equal(out.modals.at(-1).custom_id, `cmd:niveaux:rewardsubmit:${ROLE_MID}`);
  i.fields = modalFields({ level: '10' });
  await niveaux.buttons.rewardsubmit(i, w.client, [ROLE_MID]);
  i.fields = modalFields({ level: '5' });
  await niveaux.buttons.rewardsubmit(i, w.client, [ROLE_LOW]);
  i.fields = modalFields({ level: '12' });
  await niveaux.buttons.rewardsubmit(i, w.client, [ROLE_MID]); // modification, pas de doublon
  assert.deepEqual(w.config.get(GUILD).levels.rewards, [{ level: 5, roleId: ROLE_LOW }, { level: 12, roleId: ROLE_MID }]);
  i.fields = modalFields({ level: '0' });
  await assert.rejects(niveaux.buttons.rewardsubmit(i, w.client, [ROLE_LOW]), { name: 'UserError' });
  await assert.rejects(niveaux.buttons.rewardsubmit(i, w.client, [ROLE_HIGH]), { name: 'UserError' });
  assertValid(out.updates.at(-1), 'rewards après ajout');
  i.values = [`5.${ROLE_LOW}`];
  await niveaux.buttons.rewardremove(i, w.client);
  assert.deepEqual(w.config.get(GUILD).levels.rewards, [{ level: 12, roleId: ROLE_MID }]);
  await niveaux.buttons.stack(i, w.client, ['off']);
  assert.equal(w.config.get(GUILD).levels.stackRewards, false);

  i.values = [ROLE_BOOST];
  await niveaux.buttons.multrole(i, w.client);
  assert.equal(out.modals.at(-1).custom_id, `cmd:niveaux:multsubmit:${ROLE_BOOST}`);
  i.fields = modalFields({ multiplier: '1,5' });
  await niveaux.buttons.multsubmit(i, w.client, [ROLE_BOOST]);
  assert.deepEqual(w.config.get(GUILD).levels.multipliers, [{ roleId: ROLE_BOOST, multiplier: 1.5 }]);
  i.fields = modalFields({ multiplier: '9' });
  await assert.rejects(niveaux.buttons.multsubmit(i, w.client, [ROLE_BOOST]), { name: 'UserError' });
  i.fields = modalFields({ multiplier: '0' });
  await niveaux.buttons.multsubmit(i, w.client, [ROLE_BOOST]);
  assert.deepEqual(w.config.get(GUILD).levels.multipliers, []);
  i.values = [GUILD];
  await assert.rejects(niveaux.buttons.multrole(i, w.client), { name: 'UserError' });

  i.values = [CHAN, 'pas-un-id'];
  await niveaux.buttons.ignch(i, w.client);
  assert.deepEqual(w.config.get(GUILD).levels.ignoredChannels, [CHAN]);
  i.values = [ROLE_LOW, GUILD];
  await niveaux.buttons.ignrole(i, w.client);
  assert.deepEqual(w.config.get(GUILD).levels.ignoredRoles, [ROLE_LOW]);
});

test('/niveaux : donner / retirer / définir, import, réinitialisations', async () => {
  const w = world();
  const { i, out } = interaction(w);
  i.values = [ALICE];
  await niveaux.buttons.xpuser(i, w.client);
  assertValid(out.updates.at(-1), 'member');
  await niveaux.buttons.xp(i, w.client, ['give', ALICE]);
  assert.equal(out.modals.at(-1).custom_id, `cmd:niveaux:xpsubmit:give:${ALICE}`);
  await assert.rejects(niveaux.buttons.xp(i, w.client, ['steal', ALICE]), { name: 'UserError' });
  i.fields = modalFields({ amount: '500' });
  await niveaux.buttons.xpsubmit(i, w.client, ['give', ALICE]);
  i.fields = modalFields({ amount: '200' });
  await niveaux.buttons.xpsubmit(i, w.client, ['remove', ALICE]);
  assert.equal(w.repo.get(GUILD, ALICE).xp, 300);
  i.fields = modalFields({ amount: '1 000' });
  await niveaux.buttons.xpsubmit(i, w.client, ['set', ALICE]);
  assert.equal(w.repo.get(GUILD, ALICE).xp, 1000);
  assertValid(out.edits.at(-1), 'member après xp');
  i.fields = modalFields({ amount: '-3' });
  await assert.rejects(niveaux.buttons.xpsubmit(i, w.client, ['give', ALICE]), { name: 'UserError' });

  assert.deepEqual(niveaux.parseImport(`${BOB} 1500\n<@${ADMIN}>=20\nn'importe quoi\n${BOB}: 1600`), {
    entries: [{ userId: BOB, xp: 1600 }, { userId: ADMIN, xp: 20 }],
    rejected: ['n\'importe quoi'],
  });
  i.fields = modalFields({ lines: `${BOB} 1500\nfaux` });
  await niveaux.buttons.importsubmit(i, w.client);
  assert.equal(w.repo.get(GUILD, BOB).xp, 1500);
  i.fields = modalFields({ lines: 'rien de valide' });
  await assert.rejects(niveaux.buttons.importsubmit(i, w.client), { name: 'UserError' });
  assert.equal(niveaux.parseMultiplier('2.25'), 2.25);
  assert.throws(() => niveaux.parseMultiplier('0.05'), { name: 'UserError' });

  await niveaux.buttons.reset(i, w.client, ['member', ALICE]);
  assert.equal(w.repo.get(GUILD, ALICE), null);
  await assert.rejects(niveaux.buttons.reset(i, w.client, ['partout']), { name: 'UserError' });
  await niveaux.buttons.reset(i, w.client, ['guild']);
  assert.equal(w.repo.count(GUILD), 0);
});

// ---------------------------------------------------------------- /rang et /classement

test('/classement : pagination persistante, page du membre, système désactivé', async () => {
  const w = world();
  for (let k = 0; k < 23; k += 1) w.repo.add(GUILD, String(210000000000000000n + BigInt(k)), { xp: 1000 - k }, levelFromXp);
  w.repo.add(GUILD, ALICE, { xp: 1 }, levelFromXp); // 24e
  for (const p of [0, 1, 2, 99]) {
    const payload = classement.render(w.client, w.guild, p, ADMIN);
    assertValid(payload, `page ${p}`);
    assert.ok(json(payload.embeds[0]).description.split('\n').filter((l) => l.includes('XP')).length <= 10);
  }
  const first = json(classement.render(w.client, w.guild, 0, ADMIN).embeds[0]);
  assert.ok(first.description.startsWith('🥇'));
  assert.ok(first.footer.text.includes('Page 1/3'));
  const solo = world();
  assertValid(classement.render(solo.client, solo.guild, 0, ADMIN), 'vide');

  const { i, out } = interaction(w, { user: { id: ALICE, toString: () => `<@${ALICE}>` } });
  await classement.buttons.page(i, w.client, ['2', ADMIN]);
  assert.ok(json(out.updates[0].embeds[0]).description.includes(`<@${ALICE}>`));
  await classement.buttons.me(i, w.client, [ADMIN]);
  assert.ok(json(out.updates[1].embeds[0]).footer.text.includes('Page 3/3'));
  await assert.rejects(classement.buttons.page(i, w.client, ['x', ADMIN]), { name: 'UserError' });
  const stranger = interaction(w, { user: { id: '200000000000000088' } });
  await assert.rejects(classement.buttons.me(stranger.i, w.client, [ADMIN]), { name: 'UserError' });

  const off = world({ enabled: false });
  const o = interaction(off, { options: { getInteger: () => null } });
  await assert.rejects(classement.execute(o.i, off.client), /pas activé/);
  await assert.rejects(classement.buttons.page(o.i, off.client, ['0', ADMIN]), /pas activé/);
});

test('/rang : carte embed avec barre de progression, rang et bouton classement', async () => {
  const w = world();
  w.config.update(GUILD, { levels: { rewards: [{ level: 5, roleId: ROLE_MID }] } });
  w.repo.add(GUILD, ALICE, { xp: 300, messages: 12, voiceMinutes: 7 }, levelFromXp);
  w.repo.add(GUILD, BOB, { xp: 900 }, levelFromXp);
  const aliceUser = { ...w.alice.user, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png' };
  const { i, out } = interaction(w, {
    user: { id: ADMIN },
    options: { getUser: () => aliceUser, getMember: () => w.alice },
  });
  await rang.execute(i, w.client);
  const embed = json(out.replies[0].embeds[0]);
  assert.ok(embed.description.includes('Niveau 2'));
  assert.ok(embed.description.includes('#2'));
  assert.ok(embed.description.includes('█'), 'barre de progression');
  const values = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(values['📈 Niveau'], '**2**');
  assert.equal(values['🔊 Minutes vocales'], '7');
  assert.equal(values['💬 Messages'], '12');
  assert.ok(values['🎉 Prochaine récompense'].includes(ROLE_MID));
  assertValid(out.replies[0], 'rang');
  const [, cmd, action, page] = json(out.replies[0].components[0]).components[0].custom_id.split(':');
  assert.deepEqual([cmd, action, page], ['classement', 'page', '0']);

  const bot = interaction(w, { options: { getUser: () => ({ id: BOT, bot: true }), getMember: () => null } });
  await assert.rejects(rang.execute(bot.i, w.client), /bots/);
  // Membre sans XP : non classé, niveau 0.
  const card = json(rang.rankCard({ user: aliceUser, cfg: w.config.get(GUILD).levels }));
  assert.ok(card.description.includes('pas encore classé'));
});
