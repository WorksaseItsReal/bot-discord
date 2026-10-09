'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, ChannelType, Collection, GatewayIntentBits, Partials } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { StarboardRepository } = require('../src/database/repositories/StarboardRepository');
const { StickyRepository } = require('../src/database/repositories/StickyRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { StarboardService } = require('../src/services/StarboardService');
const { StickyService } = require('../src/services/StickyService');
const { AutoResponderService, channelAllowed, MAX_TRIGGERS } = require('../src/services/AutoResponderService');
const C = require('../src/utils/community');
const communaute = require('../src/commands/configuration/communaute');
const sticky = require('../src/commands/utility/sticky');
const { intents, partials } = require('../src/config/intents');
const { defaultGuildConfig } = require('../src/config/defaults');
const { migrations } = require('../src/database/schema');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Attend qu'une condition devienne vraie (au plus `timeout` ms). */
async function until(predicate, timeout = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return false;
    await sleep(5);
  }
  return true;
}

const GUILD = '100000000000000001';
const BOT = '999999999999999999';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const CAROL = '200000000000000004';
const CHAN = '400000000000000001';
const BOARD = '400000000000000002';
const NSFW = '400000000000000003';
const CATEGORY = '400000000000000009';

// ---------------------------------------------------------------- briques pures

test('intents et partials : réactions reçues, objets partiels acceptés', () => {
  assert.ok(intents.includes(GatewayIntentBits.GuildMessageReactions));
  assert.ok(partials.includes(Partials.Reaction));
  assert.ok(partials.includes(Partials.Message));
});

test('migration 15 et bloc de configuration dédié', () => {
  const m = migrations.find((x) => x.id === 15);
  assert.ok(m && /CREATE TABLE IF NOT EXISTS starboard/.test(m.up) && /CREATE TABLE IF NOT EXISTS sticky_messages/.test(m.up));
  const { db } = memoryDb();
  const cols = db.prepare('PRAGMA table_info(starboard)').all().map((c) => c.name);
  for (const c of ['guild_id', 'message_id', 'channel_id', 'author_id', 'star_message_id', 'stars', 'updated_at']) assert.ok(cols.includes(c), c);
  assert.ok(db.prepare('PRAGMA table_info(sticky_messages)').all().length >= 8);
  const d = defaultGuildConfig.community;
  assert.equal(d.starboard.enabled, false);
  assert.equal(d.starboard.emoji, '⭐');
  assert.equal(d.starboard.threshold, 3);
  assert.equal(d.autoResponses.enabled, false);
  assert.deepEqual(d.autoResponses.triggers, []);
});

test('parseEmoji / emojiMatches : un seul emoji, Unicode ou personnalisé', () => {
  for (const ok of ['⭐', '🌟', '👍🏽', '🇫🇷', '1️⃣', '👨‍👩‍👧', '❤️', '<:gadget:123456789012345678>', '<a:dance:123456789012345678>']) assert.ok(C.parseEmoji(ok), ok);
  for (const ko of ['', 'abc', '⭐⭐', 'x⭐', '<:a:1>', ':star:', '<@123456789012345678>', 'a'.repeat(80)]) assert.equal(C.parseEmoji(ko), null, ko);
  assert.equal(C.parseEmoji('<:gadget:123456789012345678>').id, '123456789012345678');
  assert.ok(C.emojiMatches('⭐', { id: null, name: '⭐' }));
  assert.ok(C.emojiMatches('❤️', { id: null, name: '❤' }), 'sélecteur de variante ignoré');
  assert.ok(!C.emojiMatches('⭐', { id: null, name: '🌟' }));
  assert.ok(C.emojiMatches('<:gadget:123456789012345678>', { id: '123456789012345678', name: 'autre' }));
  assert.ok(!C.emojiMatches('<:gadget:123456789012345678>', { id: null, name: 'gadget' }));
});

test('matchesTrigger : modes sûrs, comparaison littérale (jamais de regex)', () => {
  assert.ok(C.matchesTrigger('BONJOUR à tous', 'bonjour', 'word'));
  assert.ok(C.matchesTrigger('re-bonjour !', 'bonjour', 'word'));
  assert.ok(!C.matchesTrigger('bonjourno', 'bonjour', 'word'));
  assert.ok(C.matchesTrigger('Il fait été', 'ete', 'word'), 'accents ignorés');
  assert.ok(C.matchesTrigger('a ?? b', '??', 'word'), 'motif sans lettre : pas de limite de mot exigée');
  assert.ok(C.matchesTrigger('bonjourno', 'bonjour', 'contains'));
  assert.ok(C.matchesTrigger('Bonjour le monde', 'bonjour', 'starts'));
  assert.ok(!C.matchesTrigger('le bonjour', 'bonjour', 'starts'));
  assert.ok(C.matchesTrigger('  Merci   beaucoup ', 'merci beaucoup', 'exact'));
  assert.ok(!C.matchesTrigger('merci beaucoup !', 'merci beaucoup', 'exact'));
  // Un « motif regex » n'est qu'un texte.
  assert.ok(!C.matchesTrigger('n\'importe quoi', '.*', 'contains'));
  assert.ok(C.matchesTrigger('regardez .* ici', '.*', 'contains'));
  assert.ok(!C.matchesTrigger('aaaa', '(a+)+$', 'contains'));
  assert.ok(!C.matchesTrigger('bonjour', 'bonjour', 'regex'), 'mode inconnu refusé');
  // Pas de ReDoS possible : entrée géante traitée vite.
  const start = Date.now();
  C.matchesTrigger('a'.repeat(4000), `${'a'.repeat(99)}b`, 'word');
  assert.ok(Date.now() - start < 200);
});

test('renderResponse, firstImage, isNsfwChannel', () => {
  assert.equal(C.renderResponse('Salut {membre} sur {serveur} {MEMBRE}', { member: '<@1>', server: 'Gadget' }), 'Salut <@1> sur Gadget <@1>');
  assert.equal(C.renderResponse('x'.repeat(3000)).length, 2000);
  const attachments = new Collection([['1', { name: 'doc.pdf', url: 'https://x/doc.pdf', contentType: 'application/pdf' }], ['2', { name: 'chat.PNG', url: 'https://x/chat.PNG' }]]);
  assert.equal(C.firstImage({ attachments }), 'https://x/chat.PNG');
  assert.equal(C.firstImage({ attachments: new Collection(), embeds: [{ image: { url: 'https://x/e.png' } }] }), 'https://x/e.png');
  assert.equal(C.firstImage({ attachments: new Collection(), embeds: [] }), null);
  assert.ok(C.isNsfwChannel({ nsfw: true }));
  assert.ok(C.isNsfwChannel({ nsfw: false, parent: { nsfw: true } }), 'un fil hérite de son salon');
  assert.ok(!C.isNsfwChannel({ nsfw: false }));
});

test('/communaute : parseCooldown et parsePattern', () => {
  assert.equal(communaute.parseCooldown('30'), 30);
  assert.equal(communaute.parseCooldown('5m'), 300);
  assert.equal(communaute.parseCooldown('0'), 0);
  assert.equal(communaute.parseCooldown(''), 30);
  assert.equal(communaute.parseCooldown('1h'), 3600);
  for (const bad of ['2h', '-1', 'abc', '3601']) assert.throws(() => communaute.parseCooldown(bad), /Délai/);
  assert.equal(communaute.parsePattern('  bonjour   à  tous '), 'bonjour à tous');
  assert.throws(() => communaute.parsePattern('a'), /Déclencheur/);
  assert.throws(() => communaute.parsePattern('x'.repeat(101)), /Déclencheur/);
});

// ---------------------------------------------------------------- dépôts

test('StarboardRepository : upsert, recherche par carte, compte, suppression', () => {
  const { db } = memoryDb();
  const repo = new StarboardRepository(db);
  repo.upsert({ guildId: GUILD, messageId: '1', channelId: CHAN, authorId: ALICE, starMessageId: '9', stars: 3 });
  repo.upsert({ guildId: GUILD, messageId: '1', channelId: CHAN, authorId: ALICE, starMessageId: '9', stars: 5 });
  repo.upsert({ guildId: GUILD, messageId: '2', channelId: CHAN, stars: 1 });
  assert.equal(repo.get(GUILD, '1').stars, 5);
  assert.equal(repo.byStarMessage('9').message_id, '1');
  assert.equal(repo.byStarMessage(null), null);
  assert.equal(repo.count(GUILD), 1, 'seuls les messages avec carte comptent');
  assert.equal(repo.top(GUILD, 5)[0].message_id, '1');
  assert.equal(repo.delete(GUILD, '1'), 1);
  assert.equal(repo.get(GUILD, '1'), null);
});

test('StickyRepository : un par salon, dernier message conservé à la modification', () => {
  const { db } = memoryDb();
  const repo = new StickyRepository(db);
  repo.upsert({ guildId: GUILD, channelId: CHAN, title: 'T', content: 'A', threshold: 2 });
  repo.setLastMessage(CHAN, '77');
  const row = repo.upsert({ guildId: GUILD, channelId: CHAN, title: null, content: 'B', threshold: 4 });
  assert.equal(row.content, 'B');
  assert.equal(row.threshold, 4);
  assert.equal(row.last_message_id, '77');
  assert.equal(repo.count(GUILD), 1);
  assert.equal(repo.listByGuild(GUILD).length, 1);
  assert.equal(repo.delete(CHAN), 1);
  assert.equal(repo.all().length, 0);
});

// ---------------------------------------------------------------- faux Discord

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const channels = new Collection();
  const me = { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All) };
  const guild = { id: GUILD, name: 'Gadget', ownerId: ALICE, channels: { cache: channels }, members: { me }, emojis: { cache: new Collection() }, roles: { cache: new Collection() } };
  let seq = 900000000000000000n;
  const makeChannel = (id, extra = {}) => {
    const messages = new Collection();
    const ch = {
      id,
      name: `salon-${id.slice(-1)}`,
      type: ChannelType.GuildText,
      guild,
      guildId: GUILD,
      parentId: null,
      nsfw: false,
      sent: [],
      edits: [],
      deleted: [],
      lastMessageId: null,
      isTextBased: () => true,
      permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
      async send(payload) {
        const msg = { id: String(seq++), payload, channelId: id, delete: async () => ch.deleted.push(msg.id) };
        ch.sent.push(msg);
        ch.lastMessageId = msg.id;
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
          if (ch.missing?.has(mid)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          ch.edits.push({ id: mid, payload });
        },
        delete: async (mid) => ch.deleted.push(mid),
      },
      toString: () => `<#${id}>`,
      ...extra,
    };
    channels.set(id, ch);
    return ch;
  };
  const client = {
    user: { id: BOT },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    channels: { cache: channels },
    repositories: {},
    services: { config, logging: { suppressed: new Map() } },
  };
  return { db, config, guild, client, makeChannel };
}

const user = (id, bot = false) => ({ id, bot, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' });

function fakeMessage(channel, { id = '500000000000000001', author = user(ALICE), content = 'Superbe', reactors = [], count } = {}) {
  const users = new Collection(reactors.map((u) => [u.id, u]));
  const reaction = { emoji: { id: null, name: '⭐' }, count: count ?? users.size, users: { cache: users, fetch: async () => users } };
  const msg = {
    id,
    channelId: channel.id,
    channel,
    guildId: GUILD,
    author,
    content,
    partial: false,
    system: false,
    webhookId: null,
    createdTimestamp: Date.now() - 1000,
    url: `https://discord.com/channels/${GUILD}/${channel.id}/${id}`,
    attachments: new Collection(),
    embeds: [],
    reactions: { cache: new Collection(users.size || count ? [['⭐', reaction]] : []) },
    reaction,
  };
  channel.messages.cache.set(id, msg);
  return msg;
}

function starboardWorld(patch = {}) {
  const w = world();
  const source = w.makeChannel(CHAN);
  const board = w.makeChannel(BOARD);
  w.config.update(GUILD, { community: { starboard: { enabled: true, channelId: BOARD, threshold: 2, ...patch } } });
  const repo = new StarboardRepository(w.db);
  const svc = new StarboardService({ client: w.client, starboard: repo, config: w.config, debounceMs: 5, minEditIntervalMs: 5 });
  return { ...w, source, board, repo, svc };
}

// ---------------------------------------------------------------- starboard

test('starboard : l\'auteur et les bots ne comptent pas ; estimation au-delà de 100', async () => {
  const { svc, source } = starboardWorld();
  const emoji = C.parseEmoji('⭐');
  const msg = fakeMessage(source, { reactors: [user(ALICE), user(BOB), user(CAROL), user('300000000000000001', true)] });
  assert.equal(await svc.countStars(msg, emoji), 2);
  const big = fakeMessage(source, { id: '500000000000000002', reactors: [user(ALICE), user(BOB)], count: 150 });
  assert.equal(await svc.countStars(big, emoji), 149, '150 moins l\'auteur trouvé dans les 100 premiers');
  const none = fakeMessage(source, { id: '500000000000000003' });
  assert.equal(await svc.countStars(none, emoji), 0);
});

test('starboard : éligibilité (bots, système, salon exclu, starboard, NSFW)', () => {
  const { svc, source, board, makeChannel } = starboardWorld({ excludedChannels: [CATEGORY] });
  const cfg = svc.cfg(GUILD);
  assert.equal(svc.ineligibility(fakeMessage(source), cfg, board), null);
  assert.equal(svc.ineligibility(fakeMessage(source, { author: user(BOB, true) }), cfg, board), 'message de bot');
  assert.equal(svc.ineligibility({ ...fakeMessage(source), system: true }, cfg, board), 'message système');
  assert.equal(svc.ineligibility(fakeMessage(board), cfg, board), 'salon starboard');
  const inCat = makeChannel('400000000000000005', { parentId: CATEGORY });
  assert.equal(svc.ineligibility(fakeMessage(inCat), cfg, board), 'salon exclu');
  const nsfw = makeChannel(NSFW, { nsfw: true });
  assert.equal(svc.ineligibility(fakeMessage(nsfw), cfg, board), 'salon NSFW');
  assert.equal(svc.ineligibility(fakeMessage(nsfw), cfg, { ...board, nsfw: true }), null, 'starboard NSFW : accepté');
});

test('starboard : publication, mise à jour, carte disparue recréée, retrait sous le seuil', async () => {
  const { svc, source, board, repo, config } = starboardWorld();
  const msg = fakeMessage(source, { reactors: [user(BOB)] });
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'below');
  assert.equal(board.sent.length, 0);

  msg.reaction.users.cache.set(CAROL, user(CAROL));
  msg.reaction.count = 2;
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'posted');
  const card = board.sent[0].payload;
  assert.match(card.embeds[0].title, /⭐\s+2/);
  assert.deepEqual(card.allowedMentions, { parse: [] });
  assert.equal(json(card.components[0]).components[0].url, msg.url);
  assert.equal(repo.get(GUILD, msg.id).star_message_id, board.sent[0].id);
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'unchanged', 'pas d\'édition inutile');

  msg.reaction.users.cache.set('200000000000000005', user('200000000000000005'));
  msg.reaction.count = 3;
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'updated');
  assert.equal(board.edits.length, 1);
  assert.match(board.edits[0].payload.embeds[0].title, /3/);

  // Carte supprimée à la main : recréée à la mise à jour suivante.
  board.missing = new Set([board.sent[0].id]);
  msg.reaction.users.cache.set('200000000000000006', user('200000000000000006'));
  msg.reaction.count = 4;
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'posted');
  assert.equal(board.sent.length, 2);

  // Sous le seuil, option « garder » : la carte reste, compteur mis à jour.
  config.update(GUILD, { community: { starboard: { removeBelow: false } } });
  for (const id of [CAROL, '200000000000000005', '200000000000000006']) msg.reaction.users.cache.delete(id);
  msg.reaction.count = 1;
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'updated');
  assert.ok(repo.get(GUILD, msg.id));
  // Option « retirer » : carte supprimée, ligne oubliée.
  config.update(GUILD, { community: { starboard: { removeBelow: true } } });
  msg.reaction.users.cache.delete(BOB);
  msg.reaction.count = 0;
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), 'removed');
  assert.ok(board.deleted.includes(board.sent[1].id));
  assert.equal(repo.get(GUILD, msg.id), null);
});

test('starboard : anti-rebond (une seule mise à jour par rafale), filtres d\'événements, arrêt', async () => {
  const { svc, source } = starboardWorld();
  const msg = fakeMessage(source);
  let flushes = 0;
  svc.flush = async () => {
    flushes += 1;
  };
  const reaction = { emoji: { id: null, name: '⭐' }, message: msg };
  for (let i = 0; i < 20; i += 1) assert.equal(svc.handleReaction(reaction, user(BOB)), true);
  assert.equal(svc.handleReaction(reaction, user(BOB, true)), false, 'bot ignoré');
  assert.equal(svc.handleReaction(reaction, { id: BOT }), false, 'le bot lui-même ignoré');
  assert.equal(svc.handleReaction({ ...reaction, emoji: { id: null, name: '👍' } }, user(BOB)), false, 'autre emoji');
  assert.equal(svc.handleReaction({ ...reaction, message: { ...msg, channelId: BOARD } }, user(BOB)), false, 'réaction dans le starboard');
  await sleep(40);
  assert.equal(flushes, 1);
  svc.handleReaction(reaction, user(CAROL));
  await svc.stop();
  await sleep(30);
  assert.equal(flushes, 1, 'recompte programmé annulé à l\'arrêt');
  assert.equal(svc.handleReaction(reaction, user(CAROL)), false);
});

test('starboard : désactivé ou sans salon → aucun traitement ; suppression du message d\'origine', async () => {
  const { svc, source, board, repo, config } = starboardWorld();
  const msg = fakeMessage(source);
  repo.upsert({ guildId: GUILD, messageId: msg.id, channelId: CHAN, starMessageId: '777', stars: 3 });
  await svc.handleDelete({ id: msg.id, guildId: GUILD });
  assert.equal(repo.get(GUILD, msg.id), null);
  assert.ok(board.deleted.includes('777'));
  // Carte supprimée à la main : la ligne est oubliée.
  repo.upsert({ guildId: GUILD, messageId: msg.id, channelId: CHAN, starMessageId: '888', stars: 3 });
  await svc.handleDelete({ id: '888', guildId: GUILD });
  assert.equal(repo.get(GUILD, msg.id), null);
  config.update(GUILD, { community: { starboard: { enabled: false } } });
  assert.equal(svc.isRelevant(GUILD, CHAN, { id: null, name: '⭐' }), false);
  assert.equal(await svc.flush(GUILD, CHAN, msg.id), null);
});

// ---------------------------------------------------------------- sticky

function stickyWorld(opts = {}) {
  const w = world();
  const channel = w.makeChannel(CHAN);
  const repo = new StickyRepository(w.db);
  const svc = new StickyService({ client: w.client, sticky: repo, minIntervalMs: 0, settleMs: 5, idleMs: 1_000, ...opts });
  return { ...w, channel, repo, svc };
}

const incoming = (channel, id, author = ALICE) => ({ id, guildId: GUILD, channelId: channel.id, author: { id: author } });

test('sticky : définition, seuil de messages, écho ignoré, ancien message supprimé', async () => {
  const { svc, channel, repo } = stickyWorld();
  const { posted } = await svc.set({ guildId: GUILD, channel, title: 'Règles', content: 'Soyez gentils @everyone', threshold: 2, authorId: ALICE });
  assert.ok(posted);
  assert.equal(channel.sent.length, 1);
  const payload = channel.sent[0].payload;
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.embeds[0].title, 'Règles');
  const first = channel.sent[0].id;
  assert.equal(repo.get(CHAN).last_message_id, first);

  // Écho de notre propre message : ignoré.
  assert.equal(svc.handleMessage(incoming(channel, first, BOT)), false);
  assert.equal(svc.handleMessage(incoming(channel, '600000000000000001')), true);
  await sleep(20);
  assert.equal(channel.sent.length, 1, 'republié sous le seuil');
  svc.handleMessage(incoming(channel, '600000000000000002'));
  assert.ok(await until(() => channel.deleted.includes(first)));
  assert.equal(channel.sent.length, 2);
  assert.ok(channel.deleted.includes(first), 'ancien message non supprimé');
  assert.equal(repo.get(CHAN).last_message_id, channel.sent[1].id);
  await svc.stop();
});

test('sticky : intervalle minimal, délai d\'inactivité, rafale', async () => {
  const { svc, channel } = stickyWorld({ minIntervalMs: 300, settleMs: 5, idleMs: 30 });
  await svc.set({ guildId: GUILD, channel, content: 'Bas du salon', threshold: 5 });
  const postedAt = Date.now();
  for (let i = 0; i < 12; i += 1) svc.handleMessage(incoming(channel, `60000000000000010${i}`));
  assert.ok(await until(() => channel.sent.length === 2));
  assert.ok(Date.now() - postedAt >= 250, 'intervalle minimal non respecté');
  await sleep(30);
  assert.equal(channel.sent.length, 2, 'une seule republication pour la rafale');
  // Un seul message (< seuil) : republication après le délai d'inactivité (et l'intervalle minimal).
  svc.handleMessage(incoming(channel, '600000000000000200'));
  assert.ok(await until(() => channel.sent.length === 3));
  await svc.stop();
});

test('sticky : redémarrage (rattrapage), suppression manuelle, salon supprimé, retrait, limites', async () => {
  const { svc, channel, repo, client } = stickyWorld();
  await svc.set({ guildId: GUILD, channel, content: 'A', threshold: 3 });
  await svc.stop();
  // Nouveau service : relit la base. Le dernier message du salon n'est plus le sticky.
  channel.lastMessageId = '700000000000000001';
  const reborn = new StickyService({ client, sticky: repo, minIntervalMs: 0, settleMs: 5 });
  assert.equal(reborn.resume(), 1);
  assert.ok(await until(() => channel.sent.length === 2));
  assert.equal(reborn.resume(), 0, 'déjà en bas : rien à faire');

  reborn.handleDelete({ id: channel.sent[1].id, channelId: CHAN });
  assert.equal(repo.get(CHAN).last_message_id, null);

  assert.equal(await reborn.remove(CHAN), true);
  assert.equal(repo.get(CHAN), null);
  assert.equal(await reborn.remove(CHAN), false);

  await reborn.set({ guildId: GUILD, channel, content: 'B', threshold: 99 });
  assert.equal(reborn.get(CHAN).threshold, 50, 'seuil borné');
  reborn.handleChannelDelete({ id: CHAN });
  assert.equal(repo.get(CHAN), null);
  await reborn.stop();
});

test('sticky : permissions manquantes → rien n\'est publié', async () => {
  const { svc, channel } = stickyWorld();
  channel.permissionsFor = () => new PermissionsBitField(0n);
  const { posted } = await svc.set({ guildId: GUILD, channel, content: 'A' });
  assert.equal(posted, false);
  assert.equal(channel.sent.length, 0);
  await svc.stop();
});

// ---------------------------------------------------------------- réponses automatiques

function arWorld(triggers, patch = {}) {
  const w = world();
  const channel = w.makeChannel(CHAN);
  w.config.update(GUILD, { community: { autoResponses: { enabled: true, triggers, ...patch } } });
  const svc = new AutoResponderService({ client: w.client, config: w.config, delayMs: 5 });
  return { ...w, channel, svc };
}

function userMessage(channel, content, { id = '800000000000000001', bot = false, author = ALICE } = {}) {
  const reactions = [];
  return {
    id,
    content,
    guildId: GUILD,
    guild: channel.guild,
    channelId: channel.id,
    channel,
    author: { id: author, bot },
    webhookId: null,
    system: false,
    reactions,
    react: async (e) => reactions.push(e),
  };
}

const T = (extra = {}) => ({ id: 'abc123', pattern: 'bonjour', mode: 'word', response: 'Salut {membre} sur {serveur} @everyone', reaction: '👋', cooldownSeconds: 60, channels: [], excludedChannels: [], enabled: true, ...extra });

test('réponses automatiques : réponse sans mention, réaction, cooldown par salon', async () => {
  const { svc, channel, makeChannel } = arWorld([T()]);
  const msg = userMessage(channel, 'Bonjour tout le monde');
  assert.equal((await svc.process(msg))?.id, 'abc123');
  const sent = channel.sent[0].payload;
  assert.equal(sent.content, `Salut <@${ALICE}> sur Gadget @everyone`);
  assert.deepEqual(sent.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(sent.reply.messageReference, msg.id);
  assert.deepEqual(msg.reactions, ['👋']);
  assert.equal(await svc.process(userMessage(channel, 'bonjour', { id: '800000000000000002' })), null, 'cooldown');
  const other = makeChannel('400000000000000007');
  assert.ok(await svc.process(userMessage(other, 'bonjour', { id: '800000000000000003' })), 'cooldown propre au salon');
});

test('réponses automatiques : bots, AutoMod, suppression, désactivation, salons autorisés/exclus', async () => {
  const { svc, channel, client, config, makeChannel } = arWorld([T({ cooldownSeconds: 0 })]);
  assert.equal(svc.handleMessage(userMessage(channel, 'bonjour', { bot: true })), false, 'bot ignoré');
  assert.equal(svc.handleMessage({ ...userMessage(channel, 'bonjour'), webhookId: '1' }), false, 'webhook ignoré');
  assert.equal(svc.handleMessage(userMessage(channel, 'bonsoir')), false, 'aucun déclencheur');
  // Message filtré par l'AutoMod pendant le délai.
  const filtered = userMessage(channel, 'bonjour', { id: '800000000000000010' });
  assert.equal(svc.handleMessage(filtered), true);
  client.services.logging.suppressed.set(filtered.id, Date.now() + 30_000);
  await sleep(20);
  assert.equal(channel.sent.length, 0, 'réponse à un message filtré par l\'AutoMod');
  assert.ok(client.services.logging.suppressed.has(filtered.id), 'marque de l\'AutoMod consommée');
  // Supprimé par un modérateur.
  const removed = userMessage(channel, 'bonjour', { id: '800000000000000011' });
  svc.handleMessage(removed);
  svc.markDeleted(removed.id);
  await sleep(20);
  assert.equal(channel.sent.length, 0);

  const cat = makeChannel('400000000000000008', { parentId: CATEGORY });
  const t = T({ cooldownSeconds: 0, channels: [CATEGORY] });
  assert.ok(channelAllowed(cat, t));
  assert.ok(!channelAllowed(channel, t), 'hors des salons autorisés');
  assert.ok(!channelAllowed(cat, { ...t, excludedChannels: [cat.id] }), 'salon exclu');
  config.update(GUILD, { community: { autoResponses: { triggers: [T({ enabled: false })] } } });
  assert.equal(svc.match(userMessage(channel, 'bonjour')), null, 'déclencheur en pause');
  config.update(GUILD, { community: { autoResponses: { enabled: false, triggers: [T()] } } });
  assert.equal(svc.match(userMessage(channel, 'bonjour')), null, 'module désactivé');
  svc.stop();
});

// ---------------------------------------------------------------- tableaux de bord

function fakeInteraction(client, guild, { perms = PermissionsBitField.All, values, fields = {} } = {}) {
  const calls = { update: [], reply: [], modal: [] };
  return {
    calls,
    guild,
    guildId: guild.id,
    user: { id: ALICE },
    member: { permissionsIn: () => new PermissionsBitField(perms) },
    memberPermissions: new PermissionsBitField(perms),
    values,
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    update: async (p) => calls.update.push(p),
    reply: async (p) => calls.reply.push(p),
    showModal: async (m) => calls.modal.push(m),
    deferReply: async () => {},
    deferUpdate: async () => {},
    editReply: async (p) => calls.update.push(p),
  };
}

function assertComponents(view) {
  const rows = view.components.map(json);
  assert.ok(rows.length <= 5, `${rows.length} rangées`);
  const ids = rows.flatMap((r) => r.components.map((c) => c.custom_id)).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'customId en double');
  for (const id of ids) assert.ok(id.length <= 100);
  for (const r of rows) for (const c of r.components) if (c.options) assert.ok(c.options.length <= 25);
}

test('/communaute : chaque vue dans les limites, 25 déclencheurs, permissions revérifiées', async () => {
  const w = world();
  w.makeChannel(CHAN);
  w.client.repositories.starboard = new StarboardRepository(w.db);
  w.client.services.sticky = new StickyService({ client: w.client, sticky: new StickyRepository(w.db) });
  const triggers = Array.from({ length: MAX_TRIGGERS }, (_, i) => T({ id: `id${String(i).padStart(4, '0')}`, pattern: `mot ${i} ${'é'.repeat(90)}`, response: 'x'.repeat(1000) }));
  w.config.update(GUILD, { community: { autoResponses: { enabled: true, triggers }, starboard: { enabled: true } } });
  for (const view of ['home', 'starboard', 'auto', `trigger:${triggers[0].id}`, `confirmDel:${triggers[0].id}`]) {
    const v = communaute.render(w.client, w.guild, view);
    assertComponents(v);
    assert.ok(JSON.stringify(v.embeds.map(json)).length < 6000 + 2000);
  }
  const auto = communaute.render(w.client, w.guild, 'auto');
  const add = json(auto.components.at(-1)).components.find((c) => c.custom_id === 'cmd:communaute:aradd');
  assert.equal(add.disabled, true, 'bouton Ajouter désactivé à 25');

  // Sans « Gérer le serveur » : chaque handler refuse.
  const denied = fakeInteraction(w.client, w.guild, { perms: 0n, values: ['home'] });
  for (const [name, handler] of Object.entries(communaute.buttons)) {
    await assert.rejects(handler(denied, w.client, ['on', 'home']), /permission/i, `${name} accepté sans permission`);
  }
  assert.equal(denied.calls.update.length + denied.calls.modal.length, 0);
});

test('/communaute : formulaires validés (emoji, seuil, déclencheur, doublon)', async () => {
  const w = world();
  w.makeChannel(CHAN);
  w.client.repositories.starboard = new StarboardRepository(w.db);
  const ok = fakeInteraction(w.client, w.guild, { fields: { emoji: '🌟', threshold: '5' } });
  await communaute.buttons.sbsubmit(ok, w.client, []);
  assert.equal(w.config.get(GUILD).community.starboard.emoji, '🌟');
  assert.equal(w.config.get(GUILD).community.starboard.threshold, 5);
  await assert.rejects(communaute.buttons.sbsubmit(fakeInteraction(w.client, w.guild, { fields: { emoji: 'abc', threshold: '5' } }), w.client, []), /Emoji invalide/);
  await assert.rejects(communaute.buttons.sbsubmit(fakeInteraction(w.client, w.guild, { fields: { emoji: '⭐', threshold: '0' } }), w.client, []), /Seuil/);
  await assert.rejects(communaute.buttons.sbsubmit(fakeInteraction(w.client, w.guild, { fields: { emoji: '<:xy:123456789012345678>', threshold: '3' } }), w.client, []), /n'appartient pas/);

  const add = fakeInteraction(w.client, w.guild, { fields: { pattern: 'Bonjour', response: 'Salut {membre}', reaction: '', cooldown: '10s' } });
  await communaute.buttons.arsubmit(add, w.client, []);
  const [t] = w.config.get(GUILD).community.autoResponses.triggers;
  assert.equal(t.pattern, 'Bonjour');
  assert.equal(t.mode, 'word');
  assert.equal(t.cooldownSeconds, 10);
  assert.match(t.id, /^[a-z0-9]{6}$/);
  await assert.rejects(communaute.buttons.arsubmit(fakeInteraction(w.client, w.guild, { fields: { pattern: 'bonjour', response: 'x' } }), w.client, []), /existe déjà/);
  await assert.rejects(communaute.buttons.arsubmit(fakeInteraction(w.client, w.guild, { fields: { pattern: 'autre' } }), w.client, []), /réponse, une réaction/);
  await assert.rejects(communaute.buttons.arsubmit(fakeInteraction(w.client, w.guild, { fields: { pattern: 'autre', reaction: 'pas un emoji' } }), w.client, []), /Réaction/);
  // Mode : seules les valeurs connues ; le mode « regex » n'existe pas.
  await assert.rejects(communaute.buttons.armode(fakeInteraction(w.client, w.guild, { values: ['regex'] }), w.client, [t.id]), /Mode inconnu/);
  await communaute.buttons.armode(fakeInteraction(w.client, w.guild, { values: ['contains'] }), w.client, [t.id]);
  assert.equal(w.config.get(GUILD).community.autoResponses.triggers[0].mode, 'contains');
  await assert.rejects(communaute.buttons.artoggle(fakeInteraction(w.client, w.guild), w.client, ['../x', 'on']), /invalide/);
  await communaute.buttons.ardelete(fakeInteraction(w.client, w.guild), w.client, [t.id]);
  assert.equal(w.config.get(GUILD).community.autoResponses.triggers.length, 0);
});

test('/sticky : catégorie, sous-commandes, refus sans « Gérer les messages »', async () => {
  const data = sticky.data.toJSON();
  assert.equal(sticky.category, 'utility');
  assert.deepEqual(data.options.map((o) => o.name), ['definir', 'retirer', 'liste']);
  assert.equal(communaute.category, 'configuration');
  const w = world();
  w.makeChannel(CHAN);
  w.client.services.sticky = new StickyService({ client: w.client, sticky: new StickyRepository(w.db) });
  const denied = fakeInteraction(w.client, w.guild, { perms: 0n, values: [CHAN], fields: { content: 'x', threshold: '3' } });
  for (const [name, handler] of Object.entries(sticky.buttons)) {
    await assert.rejects(handler(denied, w.client, [CHAN]), /permission/i, `${name} accepté sans permission`);
  }
  await assert.rejects(sticky.execute({ ...denied, options: { getSubcommand: () => 'liste' } }, w.client), /permission/i);
});
