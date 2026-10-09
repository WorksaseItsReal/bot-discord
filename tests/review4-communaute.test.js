'use strict';

/**
 * Régressions de la revue n° 4 (communauté et fonctionnalités planifiées) : starboard
 * (salons privés, suppression pendant un recompte, erreur passagère, super-réactions,
 * spoilers), sticky (bots), annonces (double publication), rôles temporaires (famine entre
 * serveurs), anniversaires (abus), arrêt borné et budget des étapes du scheduler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { StarboardRepository } = require('../src/database/repositories/StarboardRepository');
const { StickyRepository } = require('../src/database/repositories/StickyRepository');
const { ScheduledAnnouncementRepository } = require('../src/database/repositories/ScheduledAnnouncementRepository');
const { TempRoleRepository } = require('../src/database/repositories/TempRoleRepository');
const { BirthdayRepository } = require('../src/database/repositories/BirthdayRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { StarboardService, isLessVisible } = require('../src/services/StarboardService');
const { StickyService } = require('../src/services/StickyService');
const { AnnouncementService } = require('../src/services/AnnouncementService');
const { TempRoleService, MAX_LATE_MS, PER_GUILD_PER_TICK } = require('../src/services/TempRoleService');
const B = require('../src/services/BirthdayService');
const { SchedulerService } = require('../src/services/SchedulerService');
const { firstImage, parseEmoji } = require('../src/utils/community');
const { localToUtc } = require('../src/utils/calendar');
const { parseAnnounceDate } = require('../src/commands/utility/annonce');
const { migrations } = require('../src/database/schema');
const H = require('./scheduled.helper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return false;
    await sleep(2);
  }
  return true;
}
/** Promesse contrôlée de l'extérieur. */
function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

const GUILD = '100000000000000001';
const BOT = '999999999999999999';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const CAROL = '200000000000000004';
const CHAN = '400000000000000001';
const BOARD = '400000000000000002';
const STAFF = '400000000000000003';

// ---------------------------------------------------------------- starboard : faux Discord

function starWorld({ boardPublic = true } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const channels = new Collection();
  const everyone = { id: GUILD, name: '@everyone' };
  const guild = { id: GUILD, channels: { cache: channels }, members: { me: null }, roles: { everyone, cache: new Collection([[GUILD, everyone]]) } };
  const suppressed = [];
  let seq = 900000000000000000n;
  const makeChannel = (id, { visible = true, type = ChannelType.GuildText, parent = null } = {}) => {
    const messages = new Collection();
    const ch = {
      id,
      name: `salon-${id.slice(-1)}`,
      type,
      guild,
      parent,
      parentId: parent?.id ?? null,
      nsfw: false,
      sent: [],
      edits: [],
      deleted: [],
      failEdit: null,
      isTextBased: () => true,
      // Vue de @everyone : ViewChannel selon `visible` (un fil suit son parent).
      permissionsFor: (target) => (parent && type !== ChannelType.GuildText
        ? parent.permissionsFor(target)
        : new PermissionsBitField(target === everyone && !visible ? 0n : PermissionFlagsBits.ViewChannel)),
      async send(payload) {
        const msg = { id: String(seq++), payload };
        ch.sent.push(msg);
        return msg;
      },
      messages: {
        cache: messages,
        fetch: async (mid) => {
          const m = messages.get(mid);
          if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          return m;
        },
        edit: async (mid, payload) => {
          if (ch.failEdit) throw ch.failEdit;
          ch.edits.push({ id: mid, payload });
        },
        delete: async (mid) => ch.deleted.push(mid),
      },
    };
    channels.set(id, ch);
    return ch;
  };
  const client = {
    user: { id: BOT },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    channels: { cache: channels },
    services: { config, logging: { suppressMessage: (id) => suppressed.push(id) } },
  };
  const source = makeChannel(CHAN);
  const board = makeChannel(BOARD, { visible: boardPublic });
  config.update(GUILD, { community: { starboard: { enabled: true, channelId: BOARD, threshold: 2 } } });
  const repo = new StarboardRepository(db);
  const svc = new StarboardService({ client, starboard: repo, config, debounceMs: 1, minEditIntervalMs: 1 });
  return { db, config, guild, client, makeChannel, source, board, repo, svc, suppressed };
}

const user = (id, bot = false) => ({ id, bot, displayAvatarURL: () => null });

/** Message avec réactions ⭐ ; `burst` : utilisateurs en super-réaction. */
function starMessage(channel, { id = '500000000000000001', author = user(ALICE), reactors = [], burst = [], fetchGate = null } = {}) {
  const normal = new Collection(reactors.map((u) => [u.id, u]));
  const supers = new Collection(burst.map((u) => [u.id, u]));
  const reaction = {
    emoji: { id: null, name: '⭐' },
    count: normal.size + supers.size,
    countDetails: { normal: normal.size, burst: supers.size },
    users: {
      cache: new Collection(),
      fetch: async ({ type = 0 } = {}) => {
        if (fetchGate) await fetchGate.promise;
        return type === 1 ? supers : normal;
      },
    },
  };
  const msg = {
    id,
    channelId: channel.id,
    channel,
    guildId: GUILD,
    author,
    content: 'Superbe',
    partial: false,
    system: false,
    webhookId: null,
    createdTimestamp: Date.now() - 1000,
    url: `https://discord.com/channels/${GUILD}/${channel.id}/${id}`,
    attachments: new Collection(),
    embeds: [],
    reactions: { cache: new Collection([['⭐', reaction]]) },
    reaction,
  };
  channel.messages.cache.set(id, msg);
  return msg;
}

// ---------------------------------------------------------------- starboard

test('starboard : un salon du staff (invisible pour @everyone) n\'est jamais reposté dans un starboard public', async () => {
  const { svc, makeChannel, board, source } = starWorld();
  const staff = makeChannel(STAFF, { visible: false });
  const cfg = svc.cfg(GUILD);
  const msg = starMessage(staff, { reactors: [user(BOB), user(CAROL)] });
  assert.equal(svc.ineligibility(msg, cfg, board), 'salon privé');
  assert.equal(await svc.flush(GUILD, STAFF, msg.id), null);
  assert.equal(board.sent.length, 0, 'message du staff reposté publiquement');
  // Fil public d'un salon privé : suit son parent.
  const thread = makeChannel('400000000000000007', { type: ChannelType.PublicThread, parent: staff });
  assert.equal(svc.ineligibility(starMessage(thread, { id: '500000000000000007' }), cfg, board), 'salon privé');
  // Fil privé d'un salon public : jamais reposté.
  const priv = makeChannel('400000000000000008', { type: ChannelType.PrivateThread, parent: source });
  assert.equal(svc.ineligibility(starMessage(priv, { id: '500000000000000008' }), cfg, board), 'fil privé');
  // Salon public : accepté.
  assert.equal(svc.ineligibility(starMessage(source, { id: '500000000000000009' }), cfg, board), null);
  assert.equal(isLessVisible(source, board), false);
});

test('starboard : starboard lui-même privé → les salons privés y sont acceptés', () => {
  const { svc, makeChannel, board } = starWorld({ boardPublic: false });
  const staff = makeChannel(STAFF, { visible: false });
  assert.equal(svc.ineligibility(starMessage(staff), svc.cfg(GUILD), board), null);
});

test('starboard : message supprimé pendant le recompte → aucune carte orpheline', async () => {
  const { svc, source, board, repo } = starWorld();
  const g = gate();
  const msg = starMessage(source, { reactors: [user(BOB), user(CAROL)], fetchGate: g });
  svc.schedule(GUILD, CHAN, msg.id);
  assert.ok(await until(() => svc.entries.get(`${GUILD}:${msg.id}`)?.running), 'recompte non lancé');
  // Un modérateur supprime le message pendant la lecture des réactions.
  source.messages.cache.delete(msg.id);
  await svc.handleDelete({ id: msg.id, guildId: GUILD, channelId: CHAN });
  g.open();
  assert.ok(await until(() => !svc.entries.size));
  assert.equal(board.sent.length, 0, 'carte publiée pour un message supprimé');
  assert.equal(repo.get(GUILD, msg.id), null, 'ligne orpheline');
});

test('starboard : suppression pendant l\'envoi de la carte → carte retirée aussitôt', async () => {
  const { svc, source, board, repo, suppressed } = starWorld();
  const msg = starMessage(source, { reactors: [user(BOB), user(CAROL)] });
  const g = gate();
  const send = board.send;
  board.send = async (payload) => {
    await g.promise;
    return send(payload);
  };
  svc.schedule(GUILD, CHAN, msg.id);
  assert.ok(await until(() => svc.entries.get(`${GUILD}:${msg.id}`)?.running));
  await sleep(5);
  await svc.handleDelete({ id: msg.id, guildId: GUILD, channelId: CHAN });
  g.open();
  assert.ok(await until(() => !svc.entries.size));
  assert.equal(board.sent.length, 1);
  assert.ok(board.deleted.includes(board.sent[0].id), 'carte non retirée');
  assert.ok(suppressed.includes(board.sent[0].id), 'suppression par le bot journalisée comme « Message supprimé »');
  assert.equal(repo.get(GUILD, msg.id), null);
});

test('starboard : erreur passagère à l\'édition → pas de seconde carte ; carte disparue (10008) → recréée', async () => {
  const { svc, source, board } = starWorld();
  const msg = starMessage(source, { reactors: [user(BOB), user(CAROL)] });
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'posted');
  msg.reaction.users.fetch = async () => new Collection([[BOB, user(BOB)], [CAROL, user(CAROL)], ['200000000000000005', user('200000000000000005')]]);
  msg.reaction.count = 3;
  msg.reaction.countDetails = { normal: 3, burst: 0 };
  board.failEdit = Object.assign(new Error('Internal Server Error'), { status: 500 });
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), null);
  assert.equal(board.sent.length, 1, 'carte en double après une erreur 500');
  board.failEdit = Object.assign(new Error('Unknown Message'), { code: 10008 });
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'posted');
  assert.equal(board.sent.length, 2);
});

test('starboard : l\'auteur ne s\'auto-étoile pas en super-réaction ; la super-réaction d\'un membre compte', async () => {
  const { svc, source } = starWorld();
  const emoji = parseEmoji('⭐');
  const selfBurst = starMessage(source, { reactors: [user(BOB), user(CAROL)], burst: [user(ALICE)] });
  assert.equal(await svc.countStars(selfBurst, emoji), 2);
  const memberBurst = starMessage(source, { id: '500000000000000002', reactors: [user(BOB)], burst: [user(CAROL)] });
  assert.equal(await svc.countStars(memberBurst, emoji), 2);
  const both = starMessage(source, { id: '500000000000000003', reactors: [user(BOB)], burst: [user(BOB)] });
  assert.equal(await svc.countStars(both, emoji), 1, 'un même membre compté deux fois');
});

test('starboard : une image marquée spoiler n\'est jamais affichée en clair', () => {
  const spoiler = { name: 'SPOILER_fin.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/a/SPOILER_fin.png', spoiler: true };
  const plain = { name: 'chat.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/a/chat.png' };
  assert.equal(firstImage({ attachments: new Collection([['1', spoiler]]) }), null);
  assert.equal(firstImage({ attachments: new Collection([['1', { ...spoiler, spoiler: undefined }]]) }), null, 'nom SPOILER_ sans attribut');
  assert.equal(firstImage({ attachments: new Collection([['1', spoiler], ['2', plain]]) }), plain.url);
});

// ---------------------------------------------------------------- sticky

function stickyWorld() {
  const { db } = memoryDb();
  const suppressed = [];
  let seq = 800000000000000000n;
  const ch = {
    id: CHAN,
    guild: { members: { me: null } },
    sent: [],
    deleted: [],
    isTextBased: () => true,
    async send(payload) {
      const m = { id: String(seq++), payload, delete: async () => {} };
      ch.sent.push(m);
      return m;
    },
    messages: { delete: async (id) => ch.deleted.push(id) },
  };
  const client = { user: { id: BOT }, channels: { cache: new Collection([[CHAN, ch]]) }, services: { logging: { suppressMessage: (id) => suppressed.push(id) } } };
  const svc = new StickyService({ client, sticky: new StickyRepository(db), minIntervalMs: 1, settleMs: 1, idleMs: 1 });
  return { ch, svc, suppressed };
}

test('sticky : les messages de bots ne relancent jamais le sticky (deux bots « sticky » ne se répondent pas)', async () => {
  const { ch, svc, suppressed } = stickyWorld();
  await svc.set({ guildId: GUILD, channel: ch, content: 'Règles', threshold: 1 });
  assert.equal(ch.sent.length, 1);
  // Un autre bot publie son propre sticky : compté, mais aucune republication.
  for (let i = 0; i < 3; i += 1) svc.handleMessage({ id: `70000000000000000${i}`, guildId: GUILD, channelId: CHAN, author: user('300000000000000009', true) });
  await sleep(20);
  assert.equal(ch.sent.length, 1, 'ping-pong entre bots');
  // Un membre écrit : republication, l'ancien message est supprimé sans log « Message supprimé ».
  svc.handleMessage({ id: '700000000000000009', guildId: GUILD, channelId: CHAN, author: user(BOB) });
  assert.ok(await until(() => ch.sent.length === 2));
  assert.ok(await until(() => ch.deleted.includes(ch.sent[0].id)));
  assert.ok(suppressed.includes(ch.sent[0].id));
  await svc.stop();
});

// ---------------------------------------------------------------- annonces

function annWorld() {
  const guild = H.fakeGuild();
  const client = H.fakeClient(guild);
  const repo = new ScheduledAnnouncementRepository(client.db);
  client.repositories = { announcements: repo };
  const service = new AnnouncementService({ client, announcements: repo });
  const author = H.fakeMember(guild, H.USER.mod);
  author.permissions = new PermissionsBitField(PermissionFlagsBits.MentionEveryone);
  guild.members.cache.set(author.id, author);
  return { guild, client, repo, service, author, channel: guild.channels.cache.get(H.CH.general) };
}

function scheduled(repo, { runAt = Date.now() - 1000, repeat = 'none', roleId = GUILD } = {}) {
  const id = repo.createDraft({ guildId: GUILD, channelId: H.CH.general, authorId: H.USER.mod, roleId, repeat, timeZone: 'Europe/Paris', runAt });
  repo.setContent(GUILD, id, { title: 'Soirée', message: 'Venez !' });
  repo.schedule(GUILD, id, runAt);
  return id;
}

/** Salon dont l'envoi attend `g` (publication lente). */
function slowSend(channel, g) {
  const send = channel.send.bind(channel);
  channel.send = async (payload) => {
    await g.promise;
    return send(payload);
  };
}

test('annonces : double clic sur « Envoyer maintenant » → une seule publication (@everyone)', async () => {
  const { guild, repo, service, channel } = annWorld();
  const id = scheduled(repo, { runAt: Date.now() + 3_600_000 });
  const g = gate();
  slowSend(channel, g);
  const first = service.sendNow(guild, id, { id: H.USER.mod });
  await assert.rejects(service.sendNow(guild, id, { id: H.USER.mod }), /déjà en cours/);
  g.open();
  await first;
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, '@everyone');
  assert.equal(repo.get(GUILD, id).status, 'done');
  assert.equal(repo.get(GUILD, id).sent_count, 1);
});

test('annonces : « Envoyer maintenant » pendant la publication du scheduler → une seule publication', async () => {
  const { guild, repo, service, channel } = annWorld();
  const id = scheduled(repo, { repeat: 'daily' });
  const g = gate();
  slowSend(channel, g);
  const tick = service.processDue();
  assert.ok(await until(() => repo.get(GUILD, id).status === 'sending'));
  await assert.rejects(service.sendNow(guild, id, { id: H.USER.mod }), /déjà en cours/);
  g.open();
  await tick;
  assert.equal(channel.sent.length, 1);
  const row = repo.get(GUILD, id);
  assert.equal(row.status, 'scheduled');
  assert.ok(row.next_run > Date.now());
});

test('annonces : envoi échoué → la réservation est rendue ; réservation laissée par un arrêt brutal → reprogrammée', async () => {
  const { guild, client, repo, service, channel } = annWorld();
  const id = scheduled(repo, { runAt: Date.now() + 3_600_000 });
  channel.fail = Object.assign(new Error('Internal Server Error'), { status: 500 });
  await assert.rejects(service.sendNow(guild, id, { id: H.USER.mod }), /non publiée/);
  assert.equal(repo.get(GUILD, id).status, 'scheduled');
  channel.fail = null;
  repo.reserve(id);
  assert.equal(repo.get(GUILD, id).status, 'sending');
  assert.equal(repo.count(GUILD), 1, 'annonce en cours d\'envoi absente de la liste');
  new AnnouncementService({ client, announcements: repo }); // redémarrage
  assert.equal(repo.get(GUILD, id).status, 'scheduled');
});

test('annonces : occurrence suivante calculée AVANT l\'envoi (jamais de republication en boucle)', async () => {
  const { client, repo, service, channel } = annWorld();
  const id = scheduled(repo, { repeat: 'daily' });
  client.db.prepare("UPDATE scheduled_announcements SET time_zone = 'Lune/Base' WHERE id = ?").run(id);
  await service.processDue();
  await service.processDue();
  assert.equal(channel.sent.length, 0, 'publiée alors que l\'échéance suivante est incalculable');
  assert.equal(repo.get(GUILD, id).status, 'scheduled');
});

test('annonces : l\'auteur doit TOUJOURS pouvoir mentionner @everyone (ou un rôle non mentionnable) à l\'envoi', async () => {
  const { guild, repo, service, channel, author, client } = annWorld();
  const everyone = scheduled(repo);
  author.permissions = new PermissionsBitField(0n); // rétrogradé
  await service.processDue();
  assert.equal(channel.sent.length, 0, '@everyone publié pour un auteur rétrogradé');
  assert.equal(repo.get(GUILD, everyone).status, 'disabled');
  assert.match(repo.get(GUILD, everyone).last_error, /@everyone/);
  assert.match(client.logs.at(-1).embed.title, /désactivée/);
  // Rôle mentionnable : aucune permission requise.
  const mentionable = scheduled(repo, { roleId: H.ROLE.safe });
  await service.processDue();
  assert.equal(repo.get(GUILD, mentionable).status, 'done');
  // Rôle non mentionnable, auteur parti : désactivée.
  guild.members.cache.delete(author.id);
  const hidden = scheduled(repo, { roleId: H.ROLE.other });
  await service.processDue();
  assert.equal(repo.get(GUILD, hidden).status, 'disabled');
  assert.match(repo.get(GUILD, hidden).last_error, /quitté/);
  assert.equal(channel.sent.length, 1);
});

test('annonces : répétition trop en retard → occurrence suivante SANS compter d\'envoi', async () => {
  const { client, repo, service, channel } = annWorld();
  const id = scheduled(repo, { repeat: 'daily', runAt: Date.now() - 2 * 86_400_000, roleId: null });
  channel.fail = Object.assign(new Error('Service Unavailable'), { status: 503 });
  await service.processDue();
  const row = repo.get(GUILD, id);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.sent_count, 0, 'compté comme envoyé');
  assert.ok(row.next_run > Date.now());
  assert.ok(row.last_error);
  assert.ok(client);
});

test('annonces : « 29/02 » une année non bissextile vise le 29 février suivant', () => {
  const now = Date.parse('2027-03-10T12:00:00Z');
  assert.equal(new Date(parseAnnounceDate('29/02 10h', 'Europe/Paris', now)).toISOString(), '2028-02-29T09:00:00.000Z');
  assert.equal(parseAnnounceDate('31/04', 'Europe/Paris', now), null);
});

test('annonces : brouillon confirmé après l\'échéance → l\'ancre (le 31) est conservée', () => {
  const { repo } = annWorld();
  const anchor = localToUtc({ year: 2026, month: 1, day: 31, hour: 18 }, 'Europe/Paris');
  const id = repo.createDraft({ guildId: GUILD, channelId: H.CH.general, authorId: H.USER.mod, repeat: 'monthly', timeZone: 'Europe/Paris', runAt: anchor });
  assert.ok(repo.schedule(GUILD, id, anchor + 1, { anchorAt: anchor, runs: 3 }));
  const row = repo.get(GUILD, id);
  assert.equal(row.anchor_at, anchor);
  assert.equal(row.runs, 3);
});

// ---------------------------------------------------------------- rôles temporaires

function tempWorld() {
  const a = H.fakeGuild();
  const b = { ...H.fakeGuild(), id: '100000000000000002' };
  b.members = { ...b.members, cache: new Collection(), me: { permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles), roles: { highest: { position: 10 } } } };
  b.members.fetch = async (id) => b.members.cache.get(id);
  const client = H.fakeClient(a);
  client.guilds.cache.set(b.id, b);
  const repo = new TempRoleRepository(client.db);
  const service = new TempRoleService({ client, tempRoles: repo });
  return { a, b, client, repo, service };
}

test('migration 25 : colonnes et table ajoutées à la fin du tableau', () => {
  const m = migrations.find((x) => x.id === 25);
  assert.ok(m);
  const { db } = memoryDb();
  assert.ok(db.prepare('PRAGMA table_info(temp_roles)').all().some((c) => c.name === 'next_attempt_at'));
  assert.ok(db.prepare('PRAGMA table_info(birthdays)').all().some((c) => c.name === 'date_changed_at'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'birthday_locks'").get());
});

test('rôles temporaires : un serveur où le bot a perdu « Gérer les rôles » ne bloque plus les autres', async () => {
  const { a, b, repo, service } = tempWorld();
  a.members.me.permissions = new PermissionsBitField(0n);
  const now = Date.now();
  for (let i = 0; i < 250; i += 1) repo.upsert({ guildId: a.id, userId: `6000000000000${String(i).padStart(5, '0')}`, roleId: H.ROLE.safe, expiresAt: now - 3_600_000 + i, now: now - 7_200_000 });
  const member = H.fakeMember(b, H.USER.b, [H.ROLE.safe]);
  b.members.cache.set(member.id, member);
  const rowB = repo.upsert({ guildId: b.id, userId: H.USER.b, roleId: H.ROLE.safe, expiresAt: now - 60_000, now: now - 7_200_000 });
  await service.processDue();
  assert.equal(a.members.fetchCalls, 0, 'membres récupérés alors que le bot ne peut rien retirer');
  assert.equal(repo.byId(rowB.id).active, 0, 'rôle échu du serveur B jamais retiré');
  assert.ok(!member.roles.cache.has(H.ROLE.safe));
  // Lignes de A examinées : réessai espacé (elles ne reviennent pas au tick suivant).
  const deferred = repo.findDue(Date.now() + 1, { perGuild: 500, limit: 500 });
  assert.equal(deferred.length, 250 - PER_GUILD_PER_TICK, 'les lignes bloquées examinées sont repoussées');
});

test('rôles temporaires : au plus N retraits par serveur et par tick', async () => {
  const { a, repo, service } = tempWorld();
  const now = Date.now();
  for (let i = 0; i < PER_GUILD_PER_TICK + 5; i += 1) {
    const m = H.fakeMember(a, `6100000000000${String(i).padStart(5, '0')}`, [H.ROLE.safe]);
    a.members.cache.set(m.id, m);
    repo.upsert({ guildId: a.id, userId: m.id, roleId: H.ROLE.safe, expiresAt: now - 1000, now: now - 7_200_000 });
  }
  await service.processDue();
  assert.equal(repo.count(a.id), 5);
  await service.processDue();
  assert.equal(repo.count(a.id), 0);
});

test('rôles temporaires : abandon après 24 h sans récupérer le membre, staff prévenu', async () => {
  const { a, client, repo, service } = tempWorld();
  a.roles.cache.get(H.ROLE.safe).position = 15; // au-dessus du bot
  const id = repo.upsert({ guildId: a.id, userId: H.USER.b, roleId: H.ROLE.safe, expiresAt: Date.now() - MAX_LATE_MS - 1000 }).id;
  await service.processDue();
  assert.equal(repo.byId(id).end_reason, 'failed');
  assert.equal(a.members.fetchCalls, 0);
  assert.match(client.logs.at(-1).embed.title, /non retiré/);
  assert.match(client.logs.at(-1).embed.description, new RegExp(`<@${H.USER.b}>`));
});

test('rôles temporaires : retiré à la main (/role remove) → ligne close, jamais rendu au retour', async () => {
  const { a, repo, service } = tempWorld();
  const { id } = repo.upsert({ guildId: a.id, userId: H.USER.b, roleId: H.ROLE.safe, expiresAt: Date.now() + 3_600_000 });
  assert.equal(service.closeManual(a.id, H.USER.b, H.ROLE.safe), true);
  assert.equal(repo.byId(id).end_reason, 'removed');
  const back = H.fakeMember(a, H.USER.b);
  assert.deepEqual(await service.reapply(back), []);
  assert.equal(service.closeManual(a.id, H.USER.b, H.ROLE.safe), false);
});

// ---------------------------------------------------------------- anniversaires

function bdayWorld() {
  const guild = H.fakeGuild();
  const client = H.fakeClient(guild);
  const repo = new BirthdayRepository(client.db);
  const service = new B.BirthdayService({ client, birthdays: repo, config: client.services.config });
  client.services.config.update(GUILD, { birthdays: { enabled: true, channelId: H.CH.general, roleId: H.ROLE.safe, timeZone: 'Europe/Paris', hour: 9 } });
  const member = H.fakeMember(guild, H.USER.a);
  guild.members.cache.set(member.id, member);
  return { guild, client, repo, service, member, channel: guild.channels.cache.get(H.CH.general) };
}
const paris = (day, month = 10, year = 2026, hour = 10) => localToUtc({ year, month, day, hour }, 'Europe/Paris');

test('anniversaires : changer sa date chaque jour ne fait pas fêter tous les jours', async () => {
  const { repo, service, channel } = bdayWorld();
  for (let d = 10; d <= 14; d += 1) {
    // La veille, le membre « déplace » son anniversaire au lendemain (date modifiée la veille).
    repo.set({ guildId: GUILD, userId: H.USER.a, day: d, month: 10, now: paris(d - 1) });
    service.invalidate(GUILD);
    await service.processDue({ now: paris(d) });
  }
  assert.equal(channel.sent.length, 1, `fêté ${channel.sent.length} fois en 5 jours`);
  // 300 jours plus tard : de nouveau fêté.
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 10, month: 8, now: paris(1, 8, 2027) });
  service.invalidate(GUILD);
  await service.processDue({ now: paris(10, 8, 2027) });
  assert.equal(channel.sent.length, 2);
});

test('anniversaires : date enregistrée ou modifiée le jour même → pas de fête ce jour-là', async () => {
  const { repo, service, channel } = bdayWorld();
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 12, month: 10, now: paris(12, 10, 2026, 8) });
  await service.processDue({ now: paris(12) });
  assert.equal(channel.sent.length, 0);
  // Changer l'année ou l'accord n'est pas une modification de date.
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 13, month: 10, now: paris(1) });
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 13, month: 10, year: 1990, showAge: true, now: paris(13, 10, 2026, 8) });
  service.invalidate(GUILD);
  await service.processDue({ now: paris(13) });
  assert.equal(channel.sent.length, 1);
  assert.equal(B.celebrationBlock({ date_changed_at: paris(13, 10, 2026, 8) }, '2026-10-13', 'Europe/Paris'), 'date enregistrée ou modifiée aujourd\'hui');
});

test('anniversaires : retirer puis remettre sa date ne refait pas fêter avant 300 jours', async () => {
  const { repo, service, channel } = bdayWorld();
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 10, month: 10, now: paris(1) });
  await service.processDue({ now: paris(10) });
  assert.equal(channel.sent.length, 1);
  const removed = repo.delete(GUILD, H.USER.a);
  assert.equal(service.afterRemoval(GUILD, removed, paris(10, 10, 2026, 20)), true);
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 12, month: 10, now: paris(11) });
  service.invalidate(GUILD);
  await service.processDue({ now: paris(12) });
  assert.equal(channel.sent.length, 1, 'refêté après retirer + definir');
  const row = repo.get(GUILD, H.USER.a);
  assert.equal(row.day, 12, 'la date reste modifiable');
});

test('anniversaires : rôle impossible à retirer → réessai, puis staff prévenu après 24 h (jamais oublié en silence)', async () => {
  const { guild, client, repo, service, member } = bdayWorld();
  repo.set({ guildId: GUILD, userId: H.USER.a, day: 10, month: 10, now: paris(1) });
  await service.processDue({ now: paris(10) });
  assert.ok(member.roles.cache.has(H.ROLE.safe));
  const until = repo.get(GUILD, H.USER.a).role_until;
  guild.roles.cache.get(H.ROLE.safe).position = 15; // au-dessus du bot
  await service.processDue({ now: until + 1000 });
  assert.ok(repo.get(GUILD, H.USER.a).role_until, 'ligne effacée alors que le rôle est toujours porté');
  await service.processDue({ now: until + 86_400_000 + 1000 });
  assert.equal(repo.get(GUILD, H.USER.a).role_until, null);
  assert.match(client.logs.at(-1).embed.title, /non retiré/);
  assert.equal(client.logs.at(-1).ctx.event, 'memberRoles');
});

// ---------------------------------------------------------------- arrêt et scheduler

test('arrêt : un service bloqué n\'empêche ni la déconnexion ni la fermeture de la base ; tout est lancé en parallèle', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  client.shutdownDeadlineMs = 50;
  const started = [];
  const order = [];
  const hang = (name) => () => {
    started.push(name);
    return new Promise(() => {});
  };
  client.services = {
    scheduler: { stop: hang('scheduler') },
    levels: { stop: hang('levels') },
    counters: { stop: hang('counters') },
    autoResponses: { stop: () => started.push('autoResponses') },
    sticky: { stop: hang('sticky') },
    starboard: { stop: hang('starboard') },
    tickets: { flush: hang('tickets') },
    giveaways: { flush: hang('giveaways') },
    projects: { flush: hang('projects') },
  };
  client.destroy = async () => order.push('destroy');
  client.database = { close: () => order.push('db') };
  const t0 = Date.now();
  await client.shutdown();
  assert.ok(Date.now() - t0 < 1_000, `arrêt trop long : ${Date.now() - t0} ms`);
  assert.deepEqual(started.sort(), ['autoResponses', 'counters', 'giveaways', 'levels', 'projects', 'scheduler', 'starboard', 'sticky', 'tickets']);
  assert.deepEqual(order, ['destroy', 'db']);
});

test('scheduler : une étape « service » trop longue s\'interrompt et laisse passer les suivantes', async () => {
  let processed = 0;
  const reached = [];
  const client = {
    guilds: { cache: new Collection() },
    isReady: () => false,
    services: {
      tempRoles: {
        async processDue({ isStopping }) {
          for (let i = 0; i < 100; i += 1) {
            if (isStopping()) return;
            await sleep(5);
            processed += 1;
          }
        },
      },
      announcements: { processDue: async () => reached.push('announcements') },
      birthdays: { processDue: async () => reached.push('birthdays') },
    },
  };
  const sched = new SchedulerService({ client, sanctions: { findDue: () => [] }, reminders: { findDue: () => [] }, stageBudgetMs: 40 });
  await sched.tick();
  assert.ok(processed > 0 && processed < 100, `lignes traitées : ${processed}`);
  assert.deepEqual(reached, ['announcements', 'birthdays']);
});
