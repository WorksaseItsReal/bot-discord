'use strict';

/**
 * Réactions automatiques par salon (seconde passe d'AutoResponderService, /communaute › Réactions
 * automatiques) : saisie des emojis, salon / fil / forum, modes, file bornée, délai et suppression,
 * permissions du bot, indépendance des déclencheurs à motif, arrêt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const {
  AutoResponderService,
  parseReactionEmojis,
  reactionEntryFor,
  reactionModeMatches,
  REACT_QUEUE_PER_CHANNEL,
  REACT_QUEUE_TOTAL,
  AUTO_REACT_MAX_EMOJIS,
} = require('../src/services/AutoResponderService');
const { defaultGuildConfig } = require('../src/config/defaults');
const communaute = require('../src/commands/configuration/communaute');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return false;
    await sleep(5);
  }
  return true;
}

const GUILD = '100000000000000001';
const OTHER_GUILD_EMOJI = '700000000000000099';
const EMOJI = '700000000000000001';
const BOT = '999999999999999999';
const ALICE = '200000000000000002';
const CHAN = '400000000000000001';
const FORUM = '400000000000000002';
const THREAD = '400000000000000003';
const POST = '400000000000000004';

function world({ perms = PermissionsBitField.All } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const channels = new Collection();
  const emojis = new Collection([[EMOJI, { id: EMOJI, name: 'gadget', animated: false, available: true }]]);
  const guild = { id: GUILD, name: 'Gadget', channels: { cache: channels }, members: { me: { id: BOT } }, emojis: { cache: emojis } };
  const permissions = { value: new PermissionsBitField(perms) };
  const makeChannel = (id, extra = {}) => {
    const ch = {
      id,
      name: `salon-${id.slice(-1)}`,
      type: ChannelType.GuildText,
      guild,
      guildId: GUILD,
      parentId: null,
      sent: [],
      isThread: () => false,
      permissionsFor: () => permissions.value,
      async send(payload) {
        ch.sent.push(payload);
        return { id: String(ch.sent.length) };
      },
      ...extra,
    };
    channels.set(id, ch);
    return ch;
  };
  const client = { user: { id: BOT }, guilds: { cache: new Collection([[GUILD, guild]]) }, services: { config, logging: { suppressed: new Map() } } };
  const svc = new AutoResponderService({ client, config, delayMs: 5 });
  svc.reactGapMs = 1;
  return { db, config, guild, client, makeChannel, permissions, svc };
}

let seq = 800000000000000000n;
function message(channel, { content = 'Salut', bot = false, attachments = [], id } = {}) {
  const reactions = [];
  return {
    id: id ?? String(seq++),
    content,
    guildId: GUILD,
    guild: channel.guild,
    channelId: channel.id,
    channel,
    author: { id: ALICE, bot },
    webhookId: null,
    system: false,
    attachments: new Collection(attachments.map((a, i) => [String(i), a])),
    embeds: [],
    reactions,
    react: async (e) => {
      reactions.push(e);
    },
  };
}

// ---------------------------------------------------------------- saisie des emojis

test('emojis : Unicode, collés, :nom: et <:nom:id> du serveur ; inconnus, autre serveur et plus de 3 refusés', () => {
  const { guild } = world();
  assert.deepEqual(parseReactionEmojis('👍 👎', guild), { emojis: ['👍', '👎'] });
  assert.deepEqual(parseReactionEmojis('👍❤️🇫🇷', guild).emojis, ['👍', '❤️', '🇫🇷'], 'emojis collés');
  assert.deepEqual(parseReactionEmojis('👍, 👍', guild).emojis, ['👍'], 'doublon retiré');
  assert.deepEqual(parseReactionEmojis(':gadget:', guild).emojis, [`<:gadget:${EMOJI}>`], ':nom: résolu');
  assert.deepEqual(parseReactionEmojis(`<:gadget:${EMOJI}> ✅`, guild).emojis, [`<:gadget:${EMOJI}>`, '✅']);
  assert.match(parseReactionEmojis('bonjour', guild).error, /n'est pas un emoji/);
  assert.match(parseReactionEmojis(':inconnu:', guild).error, /n'existe pas sur ce serveur/);
  assert.match(parseReactionEmojis(`<:ailleurs:${OTHER_GUILD_EMOJI}>`, guild).error, /n'appartient pas à ce serveur/);
  assert.match(parseReactionEmojis('👍 👎 ❤️ 🎉', guild).error, new RegExp(`${AUTO_REACT_MAX_EMOJIS} emojis au plus`));
  assert.match(parseReactionEmojis('   ', guild).error, /au moins un emoji/);
});

test('bloc de configuration dédié : désactivé, aucun salon', () => {
  assert.deepEqual(defaultGuildConfig.autoReact, { enabled: false, channels: [] });
});

// ---------------------------------------------------------------- salon, fils, forum, modes

test('salon visé : salon direct, fils seulement si demandé, forum = message d\'ouverture du post', () => {
  const { makeChannel } = world();
  const text = makeChannel(CHAN);
  const forum = makeChannel(FORUM, { type: ChannelType.GuildForum });
  const thread = makeChannel(THREAD, { type: ChannelType.PublicThread, parentId: CHAN, parent: text, isThread: () => true });
  const post = makeChannel(POST, { type: ChannelType.PublicThread, parentId: FORUM, parent: forum, isThread: () => true });
  const cfg = (patch = {}) => ({ enabled: true, channels: [{ channelId: CHAN, emojis: ['👍'], mode: 'all', threads: false, ...patch }, { channelId: FORUM, emojis: ['💡'], mode: 'all' }] });
  assert.equal(reactionEntryFor(message(text), cfg()).channelId, CHAN);
  assert.equal(reactionEntryFor(message(thread), cfg()), null, 'fils exclus par défaut');
  assert.equal(reactionEntryFor(message(thread), cfg({ threads: true })).channelId, CHAN);
  assert.equal(reactionEntryFor(message(post, { id: POST }), cfg()).channelId, FORUM, 'ouverture du post');
  assert.equal(reactionEntryFor(message(post), cfg()), null, 'réponse dans un post : rien');
  assert.equal(reactionEntryFor(message(text), { ...cfg(), enabled: false }), null, 'désactivé');
  assert.equal(reactionEntryFor(message(text), { enabled: true, channels: [{ channelId: CHAN, emojis: [] }] }), null, 'sans emoji');
});

test('modes : tous, médias (image, vidéo, lien), texte seul', () => {
  const { makeChannel } = world();
  const ch = makeChannel(CHAN);
  const image = message(ch, { content: '', attachments: [{ contentType: 'image/png', name: 'chat.png' }] });
  const link = message(ch, { content: 'regardez https://exemple.fr' });
  const plain = message(ch, { content: 'bonjour' });
  assert.ok(reactionModeMatches(image, 'media'));
  assert.ok(reactionModeMatches(link, 'media'));
  assert.ok(!reactionModeMatches(plain, 'media'));
  assert.ok(reactionModeMatches(plain, 'text'));
  assert.ok(!reactionModeMatches(image, 'text'));
  assert.ok(reactionModeMatches(plain, 'all') && reactionModeMatches(image, 'all'));
});

// ---------------------------------------------------------------- traitement

test('réactions dans l\'ordre après le délai ; bot, webhook, supprimé, sans permission → rien', async () => {
  const { svc, config, makeChannel, permissions, client } = world();
  const ch = makeChannel(CHAN);
  config.update(GUILD, { autoReact: { enabled: true, channels: [{ channelId: CHAN, emojis: ['👍', `<:gadget:${EMOJI}>`, '👎'], mode: 'all', threads: false }] } });
  const ok = message(ch);
  assert.equal(svc.queueReactions(ok), true);
  assert.ok(await until(() => ok.reactions.length === 3));
  assert.deepEqual(ok.reactions, ['👍', `<:gadget:${EMOJI}>`, '👎'], 'ordre respecté');

  const bot = message(ch, { bot: true });
  assert.equal(svc.handleMessage(bot), false);
  const hook = { ...message(ch), webhookId: '1' };
  assert.equal(svc.queueReactions(hook), false);

  const removed = message(ch);
  assert.equal(svc.queueReactions(removed), true);
  svc.markDeleted(removed.id);
  const filtered = message(ch);
  svc.queueReactions(filtered);
  client.services.logging.suppressed.set(filtered.id, Date.now() + 30_000);
  await sleep(40);
  assert.equal(removed.reactions.length, 0, 'supprimé pendant le délai');
  assert.equal(filtered.reactions.length, 0, 'filtré par l\'AutoMod');

  permissions.value = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]);
  const denied = message(ch);
  svc.queueReactions(denied);
  await sleep(40);
  assert.equal(denied.reactions.length, 0, 'sans « Ajouter des réactions »');
  svc.stop();
});

test('emoji personnalisé supprimé du serveur : ignoré, les autres réactions passent', async () => {
  const { svc, config, makeChannel, guild } = world();
  const ch = makeChannel(CHAN);
  config.update(GUILD, { autoReact: { enabled: true, channels: [{ channelId: CHAN, emojis: [`<:gadget:${EMOJI}>`, '✅'], mode: 'all' }] } });
  guild.emojis.cache.delete(EMOJI);
  const msg = message(ch);
  svc.queueReactions(msg);
  assert.ok(await until(() => msg.reactions.length === 1));
  await sleep(20);
  assert.deepEqual(msg.reactions, ['✅']);
  svc.stop();
});

test('mode médias : seuls les messages avec image ou lien reçoivent les réactions', async () => {
  const { svc, config, makeChannel } = world();
  const ch = makeChannel(CHAN);
  config.update(GUILD, { autoReact: { enabled: true, channels: [{ channelId: CHAN, emojis: ['🔥'], mode: 'media' }] } });
  assert.equal(svc.queueReactions(message(ch, { content: 'juste du texte' })), false);
  const img = message(ch, { content: '', attachments: [{ contentType: 'image/gif', name: 'x.gif' }] });
  assert.equal(svc.queueReactions(img), true);
  assert.ok(await until(() => img.reactions.length === 1));
  svc.stop();
});

test('file bornée : 20 messages en attente au plus par salon, 500 au total, abandons comptés', () => {
  const { svc, config, makeChannel } = world();
  svc.delayMs = 60_000; // rien ne part pendant le test
  const list = [];
  for (let i = 0; i < 30; i += 1) list.push({ channelId: String(410000000000000000n + BigInt(i)), emojis: ['👍'], mode: 'all' });
  config.update(GUILD, { autoReact: { enabled: true, channels: list } });
  const first = makeChannel(list[0].channelId);
  for (let i = 0; i < REACT_QUEUE_PER_CHANNEL + 5; i += 1) svc.queueReactions(message(first));
  assert.equal(svc.reactionStats(GUILD).pending, REACT_QUEUE_PER_CHANNEL, 'plafond par salon');
  assert.equal(svc.reactionStats(GUILD).dropped, 5);
  for (const entry of list.slice(1)) {
    const ch = makeChannel(entry.channelId);
    for (let i = 0; i < REACT_QUEUE_PER_CHANNEL; i += 1) svc.queueReactions(message(ch));
  }
  assert.equal(svc.reactPending, REACT_QUEUE_TOTAL, 'plafond global');
  assert.equal(svc.reactionStats(GUILD).pending, REACT_QUEUE_TOTAL);
  assert.equal(svc.reactionStats(GUILD).dropped, 5 + (29 * REACT_QUEUE_PER_CHANNEL - (REACT_QUEUE_TOTAL - REACT_QUEUE_PER_CHANNEL)));
  svc.stop();
  assert.equal(svc.reactPending, 0, 'arrêt : file vidée');
  assert.equal(svc.reactionStats(GUILD).pending, 0);
});

test('indépendant des déclencheurs : un message qui correspond aussi à un motif reçoit les deux', async () => {
  const { svc, config, makeChannel } = world();
  const ch = makeChannel(CHAN);
  config.update(GUILD, {
    autoReact: { enabled: true, channels: [{ channelId: CHAN, emojis: ['⭐'], mode: 'all' }] },
    community: { autoResponses: { enabled: true, triggers: [{ id: 'abc123', pattern: 'bonjour', mode: 'word', response: 'Salut !', reaction: '👋', cooldownSeconds: 0, channels: [], excludedChannels: [], enabled: true }] } },
  });
  const msg = message(ch, { content: 'Bonjour à tous' });
  assert.equal(svc.handleMessage(msg), true, 'réponse programmée');
  assert.ok(await until(() => msg.reactions.includes('⭐') && msg.reactions.includes('👋') && ch.sent.length === 1));
  assert.equal(ch.sent[0].content, 'Salut !');
  svc.stop();
});

test('arrêt : les attentes en cours sont levées, rien n\'est posé ensuite', async () => {
  const { svc, config, makeChannel } = world();
  svc.delayMs = 200;
  const ch = makeChannel(CHAN);
  config.update(GUILD, { autoReact: { enabled: true, channels: [{ channelId: CHAN, emojis: ['👍'], mode: 'all' }] } });
  const msg = message(ch);
  svc.queueReactions(msg);
  svc.stop();
  assert.equal(svc.sleepers.size, 0);
  await sleep(250);
  assert.equal(msg.reactions.length, 0);
  assert.equal(svc.queueReactions(message(ch)), false, 'arrêté : plus rien en file');
});

// ---------------------------------------------------------------- tableau de bord

test('/communaute : vues « Réactions automatiques » conformes (rangées, customId, menus)', () => {
  const { config, client, makeChannel, guild } = world();
  makeChannel(CHAN);
  makeChannel(FORUM, { type: ChannelType.GuildForum, name: 'idees' });
  client.repositories = {};
  config.update(GUILD, {
    autoReact: { enabled: true, channels: [{ channelId: CHAN, emojis: ['⭐', `<:gadget:${EMOJI}>`], mode: 'media', threads: true }, { channelId: FORUM, emojis: ['💡'], mode: 'all' }] },
    community: { starboard: { enabled: true, emoji: '⭐' } },
  });
  const view = communaute.render(client, guild, 'react');
  assert.ok(view.components.length <= 5);
  const desc = view.embeds[0].data.description;
  assert.match(desc, /aussi l'emoji du starboard/, 'avertissement : même emoji que le starboard');
  const ids = view.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  assert.ok(ids.includes('cmd:communaute:rxpick') && ids.includes('cmd:communaute:rxadd'));
  for (const id of ids) assert.ok(id.length <= 100);
  const detail = communaute.render(client, guild, `rx.${FORUM}`);
  const labels = detail.components.flatMap((r) => r.components.map((c) => c.data.label)).filter(Boolean);
  assert.ok(!labels.some((l) => l.startsWith('Fils')), 'forum : pas de bouton « Fils »');
  assert.match(detail.embeds[0].data.description, /message d'ouverture de chaque post/);
  const text = communaute.render(client, guild, `rx.${CHAN}`);
  assert.ok(text.components.flatMap((r) => r.components).some((c) => c.data.custom_id === `cmd:communaute:rxthreads:${CHAN}:off`), 'bouton « Fils » : valeur cible');
  assert.throws(() => communaute.render(client, guild, 'rx.400000000000000077'), /n'a plus de réactions automatiques/);
});
