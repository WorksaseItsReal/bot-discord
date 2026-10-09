'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { AfkRepository } = require('../src/database/repositories/AfkRepository');
const { HighlightRepository, parseList } = require('../src/database/repositories/HighlightRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { LoggingService } = require('../src/services/LoggingService');
const { AfkService, afkNickname, parseReason, nickBlocker } = require('../src/services/AfkService');
const { HighlightService, parseKeyword, canSee, PAUSE } = require('../src/services/HighlightService');
const { SnipeService, isLogIgnored } = require('../src/services/SnipeService');
const H = require('../src/utils/highlights');
const { migrations } = require('../src/database/schema');
const { defaultGuildConfig } = require('../src/config/defaults');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');
const { CATEGORIES } = require('../src/utils/categories');
const { validateMessageBody } = require('./e2e/lib/limits');
const afkCommand = require('../src/commands/utility/afk');
const alertes = require('../src/commands/utility/alertes');
const snipeCommand = require('../src/commands/moderation/snipe');

const GUILD = '100000000000000001';
const BOT = '999999999999999999';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const CAROL = '200000000000000004';
const CHAN = '400000000000000001';
const OTHER = '400000000000000002';
const CATEGORY = '400000000000000009';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
/** Corps de message (format API) d'une vue : embeds et composants sérialisés. */
const body = (view) => ({ embeds: (view.embeds ?? []).map(json), components: (view.components ?? []).map(json) });

function configService() {
  const { db } = memoryDb();
  return { db, config: new ConfigService(new GuildConfigRepository(db)) };
}

// ---------------------------------------------------------------- schéma, configuration, enregistrement

test('migration 20 : tables afk et highlights ; bloc de configuration dédié', () => {
  const m = migrations.find((x) => x.id === 20);
  assert.ok(m && /CREATE TABLE IF NOT EXISTS afk/.test(m.up) && /CREATE TABLE IF NOT EXISTS highlights/.test(m.up));
  const { db } = memoryDb();
  const afkCols = db.prepare('PRAGMA table_info(afk)').all().map((c) => c.name);
  for (const c of ['guild_id', 'user_id', 'reason', 'since', 'old_nick', 'afk_nick']) assert.ok(afkCols.includes(c), c);
  const hlCols = db.prepare('PRAGMA table_info(highlights)').all().map((c) => c.name);
  for (const c of ['guild_id', 'user_id', 'words', 'blocked_channels', 'blocked_users', 'paused', 'dm_failures', 'updated_at']) assert.ok(hlCols.includes(c), c);
  assert.deepEqual(defaultGuildConfig.memberTools, { afk: { enabled: true, nickname: true }, highlights: { enabled: true }, snipe: { enabled: true } });
  assert.equal(EVENT_CATEGORY.snipe, 'moderation');
});

test('commandes : /afk, /alertes, /snipe (sous-commandes, permissions, catégories)', () => {
  for (const cmd of [afkCommand, alertes, snipeCommand]) assert.ok(CATEGORIES[cmd.category], cmd.data.name);
  const a = afkCommand.data.toJSON();
  assert.equal(a.name, 'afk');
  assert.equal(a.options[0].max_length, 150);
  assert.equal(a.default_member_permissions, undefined, '/afk ouvert à tous');
  const al = alertes.data.toJSON();
  assert.deepEqual(al.options.map((o) => o.name), ['ajouter', 'retirer', 'liste', 'pause', 'bloquer', 'config']);
  assert.deepEqual(al.options.find((o) => o.name === 'bloquer').options.map((o) => o.name), ['salon', 'membre']);
  const add = al.options[0].options[0];
  assert.equal(add.min_length, 3);
  assert.equal(add.max_length, 40);
  assert.equal(al.options[1].options[0].autocomplete, true);
  const s = snipeCommand.data.toJSON();
  assert.deepEqual(s.options.map((o) => o.name), ['supprime', 'modifie']);
  assert.equal(BigInt(s.default_member_permissions), PermissionFlagsBits.ManageMessages);
});

test('événements : memberTools.js chargé AVANT messageDelete.js et messageUpdate.js (marque AutoMod encore présente)', () => {
  // EventHandler charge les fichiers dans l'ordre de fs.readdirSync.
  const files = fs.readdirSync(path.join(__dirname, '..', 'src', 'events')).filter((f) => f.endsWith('.js'));
  assert.ok(files.indexOf('memberTools.js') !== -1);
  assert.ok(files.indexOf('memberTools.js') < files.indexOf('messageDelete.js'));
  assert.ok(files.indexOf('memberTools.js') < files.indexOf('messageUpdate.js'));
});

// ---------------------------------------------------------------- AFK : briques pures

test('afkNickname : préfixe, 32 caractères au plus, emoji jamais coupé', () => {
  assert.equal(afkNickname('Bob'), '[AFK] Bob');
  assert.equal(afkNickname('  '), '[AFK] membre');
  const exact = 'x'.repeat(26);
  assert.equal(afkNickname(exact), `[AFK] ${exact}`);
  assert.equal(afkNickname(exact).length, 32);
  const long = afkNickname('Un pseudo vraiment beaucoup trop long');
  assert.equal(long.length, 32);
  assert.ok(long.endsWith('…'));
  const emoji = afkNickname('😀'.repeat(20));
  assert.ok(emoji.length <= 32);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), 'emoji coupé');
});

test('parseReason : une ligne, 150 caractères, sans mention de masse, mots interdits si l\'AutoMod est actif', () => {
  assert.equal(parseReason(null), null);
  assert.equal(parseReason('   '), null);
  assert.equal(parseReason('  Parti\n\nmanger  '), 'Parti manger');
  assert.throws(() => parseReason('x'.repeat(151)), /150 caractères/);
  for (const bad of ['@everyone viens', 'ping @here', 'hey <@&123456789012345678>']) assert.throws(() => parseReason(bad), /mentions/);
  assert.equal(parseReason('mon pote <@123456789012345678>'), 'mon pote <@123456789012345678>', 'mention de membre permise (sans notification en embed)');
  const automod = { enabled: true, filters: { badWords: { enabled: true, words: ['arnaque'] } } };
  assert.throws(() => parseReason('une ARNAQUE ici', automod), /mot interdit/);
  assert.throws(() => parseReason('une 4rn4que', automod), /mot interdit/, 'contournements détectés comme par l\'AutoMod');
  assert.equal(parseReason('une arnaque', { ...automod, enabled: false }), 'une arnaque', 'AutoMod inactif : pas de filtre');
  assert.equal(parseReason('une arnaque', { enabled: true, filters: { badWords: { enabled: false, words: ['arnaque'] } } }), 'une arnaque');
});

function fakeMember({ id = ALICE, nickname = null, username = 'alice', globalName = 'Alice', owner = false, manageable = true, botPerms = PermissionsBitField.All } = {}) {
  const guild = { id: GUILD, ownerId: owner ? id : '1', members: { me: { id: BOT, permissions: new PermissionsBitField(botPerms) }, cache: new Collection() } };
  const member = {
    id,
    guild,
    user: { id, username, globalName, bot: false },
    nickname,
    manageable,
    nicks: [],
    get displayName() {
      return this.nickname ?? this.user.globalName ?? this.user.username;
    },
    async setNickname(nick) {
      if (this.failNick) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      this.nicks.push(nick);
      this.nickname = nick;
      return this;
    },
  };
  guild.members.cache.set(id, member);
  return member;
}

test('nickBlocker : propriétaire, permission « Gérer les pseudos », hiérarchie', () => {
  assert.equal(nickBlocker(fakeMember()), null);
  assert.equal(nickBlocker(fakeMember({ owner: true })), 'owner');
  assert.equal(nickBlocker(fakeMember({ botPerms: PermissionFlagsBits.SendMessages })), 'permission');
  assert.equal(nickBlocker(fakeMember({ manageable: false })), 'hierarchy');
});

// ---------------------------------------------------------------- AFK : dépôt et service

test('AfkRepository : absence, raison, pseudo posé, liste, suppression', () => {
  const { db } = memoryDb();
  const repo = new AfkRepository(db);
  const row = repo.set({ guildId: GUILD, userId: ALICE, reason: 'Repas', since: 1000, oldNick: 'Al' });
  assert.equal(row.reason, 'Repas');
  assert.equal(row.afk_nick, null);
  assert.ok(repo.setAfkNick(GUILD, ALICE, '[AFK] Al'));
  assert.ok(repo.setReason(GUILD, ALICE, null));
  repo.set({ guildId: GUILD, userId: BOB });
  assert.deepEqual(repo.userIds(GUILD).sort(), [ALICE, BOB]);
  assert.equal(repo.count(GUILD), 2);
  const removed = repo.delete(GUILD, ALICE);
  assert.equal(removed.afk_nick, '[AFK] Al');
  assert.equal(removed.reason, null);
  assert.equal(repo.delete(GUILD, ALICE), null);
  assert.equal(repo.setAfkNick(GUILD, ALICE, 'x'), false, 'aucune ligne : rien n\'est écrit');
});

function afkWorld(opts = {}) {
  const { db, config } = configService();
  const repo = new AfkRepository(db);
  const client = { services: { logging: { suppressed: new Map() } } };
  const svc = new AfkService({ client, afk: repo, config, delayMs: 0, ttlMs: 20, cooldownMs: 30_000, ...opts });
  const sent = [];
  const channel = {
    id: CHAN,
    isThread: () => false,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    async send(payload) {
      const msg = { payload, deleted: false, async delete() { msg.deleted = true; } };
      sent.push(msg);
      return msg;
    },
  };
  let seq = 1;
  const message = (member, content = 'salut', mentions = []) => ({
    id: String(500000000000000000n + BigInt(seq++)),
    guild: member.guild,
    guildId: GUILD,
    channel,
    channelId: CHAN,
    member,
    author: { id: member.id, bot: false, toString: () => `<@${member.id}>` },
    content,
    mentions: { users: new Collection(mentions.map((u) => [u.id, { id: u.id, bot: Boolean(u.bot) }])) },
  });
  return { db, config, repo, svc, sent, channel, message };
}

test('AfkService : préfixe posé puis rétabli, raison mise à jour, membre revenu pendant le renommage', async () => {
  const w = afkWorld();
  const alice = fakeMember({ nickname: 'Al' });
  const first = await w.svc.set(alice, 'Repas');
  assert.equal(first.nick, 'set');
  assert.equal(alice.nickname, '[AFK] Al');
  assert.equal(w.repo.get(GUILD, ALICE).old_nick, 'Al');
  const again = await w.svc.set(alice, 'Réunion');
  assert.equal(again.updated, true);
  assert.equal(again.row.reason, 'Réunion');
  assert.equal(alice.nicks.length, 1, 'pseudo renommé deux fois');
  // Retour : pseudo d'origine rétabli.
  w.svc.handleMessage(w.message(alice));
  await sleep(5);
  assert.equal(alice.nickname, 'Al');
  assert.equal(w.svc.isAfk(GUILD, ALICE), false);

  // Pseudo déjà préfixé : conservé tel quel. Préfixe désactivé : rien n'est renommé.
  const bob = fakeMember({ id: BOB, nickname: '[AFK] Bob' });
  assert.equal((await w.svc.set(bob, null)).nick, 'kept');
  w.config.update(GUILD, { memberTools: { afk: { nickname: false } } });
  const carol = fakeMember({ id: CAROL });
  assert.equal((await w.svc.set(carol, null)).nick, 'disabled');
  assert.equal(carol.nicks.length, 0);
  w.config.update(GUILD, { memberTools: { afk: { nickname: true } } });

  // Revenu pendant le renommage : le préfixe posé trop tard est retiré.
  const late = fakeMember({ id: '200000000000000005', nickname: null });
  const original = late.setNickname.bind(late);
  late.setNickname = async (nick) => {
    if (nick?.startsWith('[AFK]')) w.svc.forget(GUILD, late.id);
    return original(nick);
  };
  assert.equal((await w.svc.set(late, null)).nick, 'failed');
  assert.equal(late.nickname, null, 'préfixe laissé sur un membre revenu');

  // Discord refuse : absence enregistrée quand même, pseudo inchangé.
  const refused = fakeMember({ id: '200000000000000006' });
  refused.failNick = true;
  assert.equal((await w.svc.set(refused, null)).nick, 'failed');
  assert.ok(w.svc.isAfk(GUILD, refused.id));
});

test('AfkService : réponse aux mentions (cooldown par salon, bots et auteur ignorés, message supprimé ignoré), suppression à l\'arrêt', async () => {
  const w = afkWorld();
  const alice = fakeMember();
  const bob = fakeMember({ id: BOB });
  await w.svc.set(alice, 'Repas');
  w.sent.length = 0;
  // Mention par Bob : une réponse ; la deuxième dans les 30 s : aucune.
  w.svc.handleMessage(w.message(bob, 'hey', [alice]));
  await sleep(5);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].payload.embeds[0].description, /Repas/);
  assert.deepEqual(w.sent[0].payload.allowedMentions, { parse: [], repliedUser: false });
  w.svc.handleMessage(w.message(bob, 'hey', [alice]));
  await sleep(5);
  assert.equal(w.sent.length, 1, 'cooldown ignoré');
  // Supprimée après le délai d'affichage.
  await sleep(30);
  assert.ok(w.sent[0].deleted);
  // Message mentionnant supprimé (AutoMod) avant la réponse : rien.
  w.svc.cooldowns.clear();
  const msg = w.message(bob, 'spam', [alice]);
  w.svc.client.services.logging.suppressed.set(msg.id, Date.now() + 30_000);
  w.svc.handleMessage(msg);
  await sleep(5);
  assert.equal(w.sent.length, 1, 'réponse à un message supprimé par l\'AutoMod');
  // Un bot mentionné / un auteur bot : ignorés.
  w.svc.cooldowns.clear();
  w.svc.handleMessage({ ...w.message(bob, 'x', [alice]), author: { id: BOB, bot: true } });
  await sleep(5);
  assert.equal(w.sent.length, 1);
  // Arrêt : les réponses encore affichées sont supprimées tout de suite.
  const slow = afkWorld({ ttlMs: 60_000 });
  const a2 = fakeMember();
  await slow.svc.set(a2, null);
  slow.svc.handleMessage(slow.message(fakeMember({ id: BOB }), 'x', [a2]));
  await sleep(5);
  assert.equal(slow.sent.length, 1);
  await slow.svc.stop();
  assert.ok(slow.sent[0].deleted, 'réponse laissée en place à l\'arrêt');
  assert.equal(slow.svc.expiring.size, 0);
});

// ---------------------------------------------------------------- alertes : briques pures

test('tokenize / keywordKey : minuscules, sans accents, balises Discord ignorées', () => {
  assert.deepEqual(H.tokenize('L\'Inspecteur GADGÉT, 2024 !'), ['l', 'inspecteur', 'gadget', '2024']);
  assert.deepEqual(H.tokenize('<@123456789012345678> <:gadget:123456789012345678> <#123456789012345678> <t:1700000000:R> ok'), ['ok']);
  assert.equal(H.keywordKey('  Éte-ïa  '), 'ete ia');
  assert.deepEqual(H.tokenize(''), []);
});

test('parseKeyword : 3 à 40 caractères, au moins 3 lettres ou chiffres', () => {
  assert.deepEqual(parseKeyword('  Inspecteur   Gadget '), { display: 'Inspecteur Gadget', key: 'inspecteur gadget' });
  for (const bad of ['ab', 'x'.repeat(41), '!!!', 'a b', 'a\u0007bc']) assert.throws(() => parseKeyword(bad), /Mot-clé/, bad);
  assert.equal(parseKeyword('C++ dev').key, 'c dev');
});

test('buildIndex / findMatches : mot entier, plusieurs mots, pause et doublons', () => {
  const index = H.buildIndex([
    { userId: ALICE, words: ['gadget', 'Docteur Gang', 'GADGET'], blockedChannels: [CHAN], blockedUsers: [BOB] },
    { userId: BOB, words: ['gadget'] },
    { userId: CAROL, words: ['gadget'], paused: PAUSE.manual },
    { userId: '200000000000000009', words: ['!!'] },
  ]);
  assert.deepEqual([...index.words.get('gadget')].sort(), [ALICE, BOB]);
  assert.ok(index.prefixes.has('docteur'));
  assert.ok(!index.members.has(CAROL), 'membre en pause indexé');
  assert.ok(!index.members.has('200000000000000009'), 'mot-clé sans lettre indexé');
  assert.ok(index.members.get(ALICE).blockedChannels.has(CHAN));
  assert.equal(index.members.get(ALICE).words.size, 2, 'doublon (casse) indexé deux fois');

  const hits = H.findMatches(index, 'Le DOCTEUR gang et l\'inspecteur Gadgét');
  assert.deepEqual([...hits.get(ALICE)].sort(), ['docteur gang', 'gadget']);
  assert.deepEqual([...hits.get(BOB)], ['gadget']);
  assert.equal(H.findMatches(index, 'gadgets et gadgetophone, docteur et gang').size, 0, 'mot partiel ou expression coupée');
  assert.ok(H.findMatches(index, 'docteur-gang !').get(ALICE)?.has('docteur gang'), 'ponctuation entre les mots ignorée');
  assert.equal(H.findMatches(index, 'docteur docteur gang').get(ALICE)?.has('docteur gang'), true, 'préfixe répété');
  assert.equal(H.findMatches(index, '').size, 0);
  assert.equal(H.findMatches(H.buildIndex([]), 'gadget').size, 0);
});

test('quoteExcerpt : citation bornée en lignes et en caractères', () => {
  assert.equal(H.quoteExcerpt('a\nb'), '> a\n> b');
  assert.equal(H.quoteExcerpt(''), '');
  const many = H.quoteExcerpt(Array.from({ length: 20 }, (_, i) => `ligne ${i}`).join('\n'));
  assert.equal(many.split('\n').length, 8);
  assert.ok(many.endsWith('…'));
  assert.ok(H.quoteExcerpt('x'.repeat(5000)).length <= 700);
  assert.ok(!H.quoteExcerpt('```js\ncode\n```').includes('```'), 'bloc de code laissé ouvert');
});

test('test de charge : 1000 membres × 10 mots-clés, moins de 1 ms par message', (t) => {
  // Vocabulaire : 10 000 mots-clés distincts + quelques mots-clés populaires partagés.
  const shared = ['gadget', 'docteur gang', 'pénélope', 'finot', 'brain'];
  const entries = Array.from({ length: 1000 }, (_, u) => ({
    userId: String(300000000000000000n + BigInt(u)),
    words: Array.from({ length: 10 }, (_, i) => (i < 2 ? shared[(u + i) % shared.length] : `mot${u}x${i}`)),
    blockedChannels: [],
    blockedUsers: [],
    paused: 0,
  }));
  const t0 = performance.now();
  const index = H.buildIndex(entries);
  const buildMs = performance.now() - t0;
  assert.ok(buildMs < 200, `reconstruction de l'index : ${buildMs.toFixed(1)} ms`);
  assert.equal(index.members.size, 1000);

  const filler = 'le la les un une des et ou mais donc or ni car je tu il nous vous ils bonjour salut merci message serveur salon discord jeu soir demain hier aujourd\'hui'.split(' ');
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const messages = Array.from({ length: 2000 }, (_, i) => {
    const words = Array.from({ length: 20 + rand(60) }, () => filler[rand(filler.length)]);
    if (i % 4 === 0) words.splice(rand(words.length), 0, 'Gadget');
    if (i % 10 === 0) words.splice(rand(words.length), 0, `mot${rand(1000)}x${2 + rand(8)}`);
    if (i % 50 === 0) words.splice(rand(words.length), 0, 'Docteur', 'GANG');
    return words.join(' ');
  });
  for (const m of messages.slice(0, 200)) H.findMatches(index, m); // préchauffage
  const start = performance.now();
  let hits = 0;
  for (const m of messages) hits += H.findMatches(index, m).size;
  const perMessage = (performance.now() - start) / messages.length;
  assert.ok(hits > 0);
  t.diagnostic(`index : ${buildMs.toFixed(1)} ms · recherche : ${(perMessage * 1000).toFixed(1)} µs par message`);
  assert.ok(perMessage < 1, `${perMessage.toFixed(3)} ms par message`);
  // Exactitude : le propriétaire d'un mot-clé unique est trouvé.
  assert.ok(H.findMatches(index, 'regardez mot123x5 !').has(String(300000000000000000n + 123n)));
});

// ---------------------------------------------------------------- alertes : dépôt et service

test('HighlightRepository : JSON robuste, échecs comptés, pause, suppression', () => {
  const { db } = memoryDb();
  const repo = new HighlightRepository(db);
  assert.deepEqual(parseList('{"a":1}'), []);
  assert.deepEqual(parseList('pas du json'), []);
  assert.deepEqual(parseList('["a", 3, null, "b"]'), ['a', 'b']);
  repo.save({ guildId: GUILD, userId: ALICE, words: ['gadget'], blockedChannels: [CHAN] });
  assert.deepEqual(repo.get(GUILD, ALICE).words, ['gadget']);
  assert.equal(repo.recordFailure(GUILD, ALICE), 1);
  assert.equal(repo.recordFailure(GUILD, ALICE), 2);
  assert.ok(repo.resetFailures(GUILD, ALICE));
  assert.equal(repo.resetFailures(GUILD, ALICE), false, 'écriture inutile');
  repo.recordFailure(GUILD, ALICE);
  assert.ok(repo.setPaused(GUILD, ALICE, PAUSE.auto));
  const row = repo.get(GUILD, ALICE);
  assert.equal(row.paused, 2);
  assert.equal(row.dmFailures, 0);
  db.prepare('UPDATE highlights SET words = ? WHERE user_id = ?').run('corrompu', ALICE);
  assert.deepEqual(repo.get(GUILD, ALICE).words, []);
  assert.equal(repo.listByGuild(GUILD).length, 1);
  assert.ok(repo.delete(GUILD, ALICE));
  assert.equal(repo.get(GUILD, ALICE), null);
});

function hlWorld() {
  const { db, config } = configService();
  const repo = new HighlightRepository(db);
  const client = { services: { logging: { suppressed: new Map() } } };
  const svc = new HighlightService({ client, highlights: repo, config, delayMs: 0 });
  const dms = [];
  const failing = new Set();
  const denied = new Set(); // `${channelId}:${userId}`
  const members = new Collection();
  const guild = {
    id: GUILD,
    name: 'Gadget',
    members: {
      cache: members,
      fetch: async (id) => {
        throw Object.assign(new Error(`Unknown Member ${id}`), { code: 10007 });
      },
    },
  };
  const addMember = (id) => {
    const m = {
      id,
      user: { id, bot: false },
      async send(payload) {
        if (failing.has(id)) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        dms.push({ userId: id, payload });
        return {};
      },
    };
    members.set(id, m);
    return m;
  };
  const channel = (id, extra = {}) => ({
    id,
    guild,
    type: ChannelType.GuildText,
    parentId: null,
    parent: null,
    nsfw: false,
    permissionsFor: (m) => new PermissionsBitField(denied.has(`${id}:${m.id}`) ? 0n : PermissionsBitField.All),
    toString: () => `<#${id}>`,
    ...extra,
  });
  let seq = 1;
  const message = (ch, authorId, content) => ({
    id: String(600000000000000000n + BigInt(seq++)),
    guild,
    guildId: GUILD,
    channel: ch,
    channelId: ch.id,
    author: { id: authorId, bot: false, username: `u${authorId.slice(-2)}`, toString: () => `<@${authorId}>`, displayAvatarURL: () => null },
    content,
    url: `https://discord.com/channels/${GUILD}/${ch.id}/${seq}`,
    createdTimestamp: Date.now(),
    attachments: new Collection(),
  });
  const deliver = async (msg) => svc.process(msg, H.findMatches(svc.index(GUILD), msg.content));
  return { db, config, repo, svc, dms, failing, denied, guild, addMember, channel, message, deliver, client };
}

test('HighlightService : gestion (ajout, doublon, 10 au plus, retrait, blocages bornés, pause), index reconstruit', () => {
  const w = hlWorld();
  w.svc.addWord(GUILD, ALICE, 'Gadget');
  assert.ok(w.svc.index(GUILD).words.get('gadget').has(ALICE), 'index non reconstruit à l\'ajout');
  assert.throws(() => w.svc.addWord(GUILD, ALICE, 'GADGÉT'), /figure déjà/);
  for (let i = 1; i < 10; i += 1) w.svc.addWord(GUILD, ALICE, `mot${i}`);
  assert.throws(() => w.svc.addWord(GUILD, ALICE, 'onze'), /10 mots-clés au plus/);
  assert.equal(w.svc.removeWord(GUILD, ALICE, 'gadgét').word, 'Gadget');
  assert.ok(!w.svc.index(GUILD).words.has('gadget'), 'index non reconstruit au retrait');
  assert.throws(() => w.svc.removeWord(GUILD, ALICE, 'absent'), /ne figure pas/);
  for (let i = 0; i < 25; i += 1) w.svc.toggleChannel(GUILD, ALICE, String(400000000000000100n + BigInt(i)));
  assert.throws(() => w.svc.toggleChannel(GUILD, ALICE, CHAN), /25 salons/);
  assert.equal(w.svc.toggleChannel(GUILD, ALICE, '400000000000000100').blocked, false);
  assert.deepEqual(w.svc.setBlockedUsers(GUILD, ALICE, [BOB, ALICE, BOB]).blockedUsers, [BOB], 'soi-même ou doublon bloqué');
  w.svc.setPaused(GUILD, ALICE, true);
  assert.ok(!w.svc.index(GUILD).members.has(ALICE), 'membre en pause encore indexé');
  w.svc.setPaused(GUILD, ALICE, false);
  assert.ok(w.svc.index(GUILD).members.has(ALICE));
  assert.deepEqual(w.svc.stats(GUILD), { members: 1, words: 9, paused: 0 });
  assert.ok(w.svc.forget(GUILD, ALICE));
  assert.equal(w.svc.index(GUILD).members.size, 0);
});

test('HighlightService : accès au salon, blocages, cooldown, activité, NSFW, message supprimé', async () => {
  const w = hlWorld();
  w.addMember(ALICE);
  w.addMember(BOB);
  w.svc.addWord(GUILD, ALICE, 'gadget');
  w.svc.addWord(GUILD, BOB, 'gadget');
  const ch = w.channel(CHAN);
  // Bob ne peut pas voir le salon : seule Alice est alertée ; l'auteur n'est jamais alerté.
  w.denied.add(`${CHAN}:${BOB}`);
  assert.equal(await w.deliver(w.message(ch, CAROL, 'voici gadget')), 1);
  assert.equal(w.dms[0].userId, ALICE);
  assert.match(w.dms[0].payload.embeds[0].title, /« gadget »/);
  assert.deepEqual(w.dms[0].payload.allowedMentions, { parse: [] });
  w.denied.clear();
  // Cooldown de 5 min par (membre, salon) : Bob reçoit, Alice non ; autre salon : Alice reçoit.
  assert.equal(await w.deliver(w.message(ch, CAROL, 'gadget')), 1);
  assert.equal(w.dms.at(-1).userId, BOB);
  assert.equal(await w.deliver(w.message(w.channel(OTHER), CAROL, 'gadget')), 2);
  // Activité : Alice a écrit dans le salon il y a peu → pas d'alerte.
  w.svc.cooldowns.clear();
  w.svc.handleMessage(w.message(ch, ALICE, 'je suis là'));
  const before = w.dms.length;
  await w.deliver(w.message(ch, CAROL, 'gadget'));
  assert.deepEqual(w.dms.slice(before).map((d) => d.userId), [BOB]);
  // Blocages : membre, catégorie (via le parent du salon).
  w.svc.cooldowns.clear();
  w.svc.activity.clear();
  w.svc.toggleUser(GUILD, ALICE, CAROL);
  w.svc.toggleChannel(GUILD, BOB, CATEGORY);
  const inCategory = w.channel(OTHER, { parentId: CATEGORY, parent: { id: CATEGORY, parentId: null } });
  assert.equal(await w.deliver(w.message(inCategory, CAROL, 'gadget')), 0);
  // Fil : hérite du blocage de la catégorie de son salon parent.
  const thread = w.channel('400000000000000077', { type: ChannelType.PublicThread, parentId: OTHER, parent: { id: OTHER, parentId: CATEGORY } });
  assert.equal(await w.deliver(w.message(thread, CAROL, 'gadget')), 0);
  w.svc.toggleUser(GUILD, ALICE, CAROL);
  w.svc.toggleChannel(GUILD, BOB, CATEGORY);
  // NSFW (salon ou parent) : jamais en MP.
  w.svc.cooldowns.clear();
  assert.equal(await w.deliver(w.message(w.channel(CHAN, { nsfw: true }), CAROL, 'gadget')), 0);
  // Supprimé (modérateur ou AutoMod) avant l'envoi : rien.
  const removed = w.message(ch, CAROL, 'gadget');
  w.svc.markDeleted(removed.id);
  assert.equal(await w.deliver(removed), 0);
  const filtered = w.message(ch, CAROL, 'gadget');
  w.client.services.logging.suppressed.set(filtered.id, Date.now() + 30_000);
  assert.equal(await w.deliver(filtered), 0);
  assert.equal(w.client.services.logging.suppressed.has(filtered.id), true, 'marque de l\'AutoMod consommée');
  // Membre parti (absent du cache, introuvable) : ignoré sans erreur.
  w.svc.addWord(GUILD, '200000000000000042', 'gadget');
  assert.equal(await w.deliver(w.message(ch, CAROL, 'gadget')), 2);
  // Désactivé sur le serveur : rien n'est programmé.
  w.config.update(GUILD, { memberTools: { highlights: { enabled: false } } });
  assert.equal(w.svc.handleMessage(w.message(ch, CAROL, 'gadget')), false);
});

test('HighlightService : fil privé (membres du fil seulement), plafond de MP par message', async () => {
  const w = hlWorld();
  for (const id of [ALICE, BOB]) {
    w.addMember(id);
    w.svc.addWord(GUILD, id, 'gadget');
  }
  const privateThread = w.channel('400000000000000078', { type: ChannelType.PrivateThread, members: { cache: new Collection([[ALICE, {}]]) } });
  assert.ok(canSee(privateThread, w.guild.members.cache.get(ALICE)));
  w.denied.add(`400000000000000078:${BOB}`);
  assert.ok(!canSee(privateThread, w.guild.members.cache.get(BOB)));
  w.denied.clear();
  // Bob a toutes les permissions (dont « Gérer les fils ») : il voit le fil privé.
  assert.ok(canSee(privateThread, w.guild.members.cache.get(BOB)));
  w.svc.maxDms = 1;
  assert.equal(await w.deliver(w.message(w.channel(CHAN), CAROL, 'gadget')), 1);
});

test('HighlightService : 3 MP refusés d\'affilée → pause automatique ; un MP reçu remet le compteur à zéro', async () => {
  const w = hlWorld();
  w.addMember(ALICE);
  w.svc.addWord(GUILD, ALICE, 'gadget');
  const ch = w.channel(CHAN);
  w.failing.add(ALICE);
  await w.deliver(w.message(ch, CAROL, 'gadget'));
  w.svc.cooldowns.clear();
  await w.deliver(w.message(ch, CAROL, 'gadget'));
  assert.equal(w.repo.get(GUILD, ALICE).dmFailures, 2);
  // Un envoi réussi entre-temps : compteur remis à zéro.
  w.failing.delete(ALICE);
  w.svc.cooldowns.clear();
  await w.deliver(w.message(ch, CAROL, 'gadget'));
  assert.equal(w.repo.get(GUILD, ALICE).dmFailures, 0);
  w.failing.add(ALICE);
  for (let i = 0; i < 3; i += 1) {
    w.svc.cooldowns.clear();
    await w.deliver(w.message(ch, CAROL, 'gadget'));
  }
  assert.equal(w.repo.get(GUILD, ALICE).paused, PAUSE.auto);
  assert.ok(!w.svc.index(GUILD).members.has(ALICE), 'index non reconstruit après la pause automatique');
  // Reprise : compteur à zéro, de nouveau indexée.
  w.svc.setPaused(GUILD, ALICE, false);
  assert.equal(w.repo.get(GUILD, ALICE).dmFailures, 0);
  assert.ok(w.svc.index(GUILD).members.has(ALICE));
});

test('HighlightService : handleMessage programme les MP après le délai et s\'arrête proprement', async () => {
  const w = hlWorld();
  w.addMember(ALICE);
  w.svc.addWord(GUILD, ALICE, 'gadget');
  w.svc.delayMs = 5;
  const ch = w.channel(CHAN);
  assert.equal(w.svc.handleMessage(w.message(ch, CAROL, 'rien à signaler')), false);
  assert.equal(w.svc.handleMessage({ ...w.message(ch, CAROL, 'gadget'), author: { id: CAROL, bot: true } }), false, 'message de bot');
  assert.equal(w.svc.handleMessage(w.message(ch, ALICE, 'mon gadget')), false, 'son propre mot-clé');
  w.svc.activity.clear(); // Alice vient d'écrire ici : elle ne serait pas alertée
  assert.equal(w.svc.handleMessage(w.message(ch, CAROL, 'gadget')), true);
  await sleep(20);
  assert.equal(w.dms.length, 1);
  w.svc.cooldowns.clear();
  assert.equal(w.svc.handleMessage(w.message(ch, CAROL, 'gadget')), true);
  w.svc.stop();
  await sleep(20);
  assert.equal(w.dms.length, 1, 'MP envoyé après l\'arrêt');
});

test('test de charge (service) : 1000 membres × 10 mots-clés en base, handleMessage < 1 ms par message', (t) => {
  const w = hlWorld();
  for (let u = 0; u < 1000; u += 1) {
    w.repo.save({ guildId: GUILD, userId: String(300000000000000000n + BigInt(u)), words: Array.from({ length: 10 }, (_, i) => `mot${u}x${i}`) });
  }
  const t0 = performance.now();
  w.svc.rebuild(GUILD);
  const rebuildMs = performance.now() - t0;
  assert.ok(rebuildMs < 500, `reconstruction depuis la base : ${rebuildMs.toFixed(1)} ms`);
  w.svc.delayMs = 60_000;
  const ch = w.channel(CHAN);
  const text = 'bonjour à tous, je cherche quelqu\'un pour une partie ce soir sur le serveur, qui est partant ? mot500x3 peut-être';
  const messages = Array.from({ length: 2000 }, (_, i) => w.message(ch, CAROL, i % 5 ? text.replace('mot500x3', 'personne') : text));
  for (const m of messages.slice(0, 100)) w.svc.handleMessage(m);
  const start = performance.now();
  for (const m of messages) w.svc.handleMessage(m);
  const perMessage = (performance.now() - start) / messages.length;
  w.svc.stop();
  t.diagnostic(`reconstruction depuis la base : ${rebuildMs.toFixed(1)} ms · handleMessage : ${(perMessage * 1000).toFixed(1)} µs par message`);
  assert.ok(perMessage < 1, `${perMessage.toFixed(3)} ms par message`);
});

// ---------------------------------------------------------------- snipe

function snipeWorld() {
  const { config } = configService();
  const logging = new LoggingService({ guilds: { cache: new Collection() } }, config);
  const client = { services: { logging } };
  const svc = new SnipeService({ client, config });
  let seq = 1;
  const channel = (id, extra = {}) => ({ id, parentId: null, parent: null, ...extra });
  const message = (ch, { authorId = ALICE, content = 'secret', bot = false, files = [], partial = false, webhookId = null } = {}) => ({
    id: String(700000000000000000n + BigInt(seq++)),
    guildId: GUILD,
    channel: ch,
    channelId: ch.id,
    partial,
    webhookId,
    system: false,
    author: partial ? null : { id: authorId, bot, username: 'alice', displayAvatarURL: () => null },
    content: partial ? null : content,
    attachments: new Collection(files.map((name, i) => [String(i), { name, url: `https://cdn.discordapp.com/x/${name}` }])),
    createdTimestamp: Date.now() - 1000,
    url: `https://discord.com/channels/${GUILD}/${ch.id}/1`,
  });
  return { config, logging, svc, channel, message };
}

test('SnipeService : suppression et modification retenues 10 min, un par salon, pièces jointes par nom', () => {
  const w = snipeWorld();
  const ch = w.channel(CHAN);
  assert.ok(w.svc.recordDelete(w.message(ch, { content: 'premier' })));
  assert.ok(w.svc.recordDelete(w.message(ch, { content: '', files: ['plan.pdf', 'photo.png'] })));
  const entry = w.svc.get(CHAN, 'deleted');
  assert.equal(entry.content, '');
  assert.deepEqual(entry.files, ['plan.pdf', 'photo.png']);
  assert.ok(!JSON.stringify(entry).includes('cdn.discordapp.com'), 'URL de pièce jointe retenue');
  assert.equal(w.svc.recordDelete(w.message(ch, { content: '' })), false, 'message vide retenu');
  // Modification : avant/après ; texte identique ou ancien message inconnu ignorés.
  const old = w.message(ch, { content: 'avant' });
  assert.ok(w.svc.recordEdit(old, { ...old, content: 'après' }));
  assert.deepEqual([w.svc.get(CHAN, 'edited').before, w.svc.get(CHAN, 'edited').after], ['avant', 'après']);
  assert.equal(w.svc.recordEdit(old, { ...old }), false);
  assert.equal(w.svc.recordEdit({ partial: true }, old), false);
  // Expiration.
  w.svc.store.get(CHAN).deleted.expiresAt = Date.now() - 1;
  assert.equal(w.svc.get(CHAN, 'deleted'), null);
  assert.ok(w.svc.get(CHAN, 'edited'));
});

test('SnipeService : bots, webhooks, partiels, salons ignorés des logs (parent, catégorie), désactivation', () => {
  const w = snipeWorld();
  const ch = w.channel(CHAN);
  assert.equal(w.svc.recordDelete(w.message(ch, { bot: true })), false);
  assert.equal(w.svc.recordDelete(w.message(ch, { webhookId: '1' })), false);
  assert.equal(w.svc.recordDelete(w.message(ch, { partial: true })), false);
  w.config.update(GUILD, { logs: { ignoredChannels: [CATEGORY] } });
  const inCategory = w.channel(OTHER, { parentId: CATEGORY, parent: { id: CATEGORY, parentId: null } });
  const thread = w.channel('400000000000000077', { parentId: OTHER, parent: { id: OTHER, parentId: CATEGORY } });
  assert.ok(isLogIgnored(w.config.get(GUILD), inCategory));
  assert.ok(isLogIgnored(w.config.get(GUILD), thread));
  assert.equal(w.svc.recordDelete(w.message(inCategory)), false);
  assert.equal(w.svc.recordDelete(w.message(thread)), false);
  assert.ok(w.svc.recordDelete(w.message(ch)));
  w.config.update(GUILD, { memberTools: { snipe: { enabled: false } } });
  assert.equal(w.svc.recordDelete(w.message(ch)), false);
  assert.equal(w.svc.clearGuild(GUILD), 1);
  assert.equal(w.svc.get(CHAN, 'deleted'), null);
});

test('SnipeService : message supprimé par l\'AutoMod jamais retenu, marque lue SANS être consommée', () => {
  const w = snipeWorld();
  const ch = w.channel(CHAN);
  const msg = w.message(ch, { content: 'avant' });
  assert.ok(w.svc.recordEdit(msg, { ...msg, content: 'contenu filtré' }));
  w.logging.suppressMessage(msg.id);
  assert.equal(w.svc.recordDelete(msg), false);
  assert.equal(w.svc.get(CHAN, 'edited'), null, 'modification du message filtré conservée');
  // La marque est toujours là pour messageDelete.js (pas de log « Message supprimé » en double).
  assert.equal(w.logging.isSuppressed(msg.id), true);
});

test('SnipeService : mémoire bornée (salons les plus anciens oubliés)', () => {
  const w = snipeWorld();
  w.svc.maxChannels = 3;
  for (let i = 0; i < 6; i += 1) w.svc.recordDelete(w.message(w.channel(String(400000000000000200n + BigInt(i)))));
  assert.equal(w.svc.store.size, 3);
  assert.ok(w.svc.get('400000000000000205', 'deleted'));
  assert.equal(w.svc.get('400000000000000200', 'deleted'), null);
  w.svc.stop();
  assert.equal(w.svc.store.size, 0);
});

// ---------------------------------------------------------------- vues de /alertes

function viewClient() {
  const { db, config } = configService();
  const highlights = new HighlightService({ highlights: new HighlightRepository(db), config });
  const afk = new AfkService({ afk: new AfkRepository(db), config });
  return { services: { config, highlights, afk, snipe: new SnipeService({ config }) } };
}

test('/alertes liste : limites Discord au maximum (10 mots-clés de 40 caractères, 25 salons et 25 membres bloqués)', () => {
  const client = viewClient();
  const channels = new Collection();
  for (let i = 0; i < 30; i += 1) channels.set(String(400000000000000300n + BigInt(i)), { id: String(400000000000000300n + BigInt(i)) });
  const guild = { id: GUILD, channels: { cache: channels }, members: { me: null } };
  const svc = client.services.highlights;
  for (let i = 0; i < 10; i += 1) svc.addWord(GUILD, ALICE, `${'motcle'.repeat(6)}${String(i).padStart(4, '0')}`.slice(-40));
  svc.setBlockedChannels(GUILD, ALICE, [...channels.keys()]);
  svc.setBlockedUsers(GUILD, ALICE, Array.from({ length: 30 }, (_, i) => String(200000000000000100n + BigInt(i))));
  const view = alertes.listView(client, guild, ALICE, '✅ test');
  assert.deepEqual(validateMessageBody(body(view)), []);
  assert.ok(view.components.length <= 5);
  // Membre sans mot-clé : pas de menu de retrait, vue valide.
  assert.deepEqual(validateMessageBody(body(alertes.listView(client, guild, BOB))), []);
  // Pause automatique expliquée.
  client.services.highlights.repo.setPaused(GUILD, ALICE, PAUSE.auto);
  assert.match(json(alertes.listView(client, guild, ALICE).embeds[0]).description, /pause automatique/);
});

test('/alertes config : une bascule par fonction (valeur cible en argument), vue valide', () => {
  const client = viewClient();
  const guild = { id: GUILD, channels: { cache: new Collection() }, members: { me: { permissions: new PermissionsBitField(0n) } } };
  const view = alertes.configView(client, guild);
  assert.deepEqual(validateMessageBody(body(view)), []);
  const ids = view.components.flatMap((r) => json(r).components.map((c) => c.custom_id));
  assert.deepEqual(ids, ['cmd:alertes:cfg:afk:off', 'cmd:alertes:cfg:nick:off', 'cmd:alertes:cfg:highlights:off', 'cmd:alertes:cfg:snipe:off', 'cmd:alertes:cfgview']);
  assert.match(JSON.stringify(json(view.embeds[0])), /Gérer les pseudos/, 'permission manquante non signalée');
  client.services.config.update(GUILD, { memberTools: { snipe: { enabled: false } } });
  assert.ok(alertes.configView(client, guild).components.flatMap((r) => json(r).components.map((c) => c.custom_id)).includes('cmd:alertes:cfg:snipe:on'));
});
