'use strict';

/**
 * Revue n° 6 (tickets, ModMail, candidatures) : tests de régression unitaires.
 * Chaque test échoue sans le correctif correspondant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { ModmailRepository } = require('../src/database/repositories/ModmailRepository');
const { ModmailService } = require('../src/services/ModmailService');
const modmailCmd = require('../src/commands/tickets/modmail');

const USER = '500000000000000001';
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const text = (e) => {
  const j = json(e);
  return [j?.title, j?.description, ...(j?.fields ?? []).flatMap((f) => [f.name, f.value])].filter(Boolean).join('\n');
};

// ---------------------------------------------------------------- R65

/** Serveur factice avec ModMail : salons créés et messages publiés. */
function fakeGuild(id, name) {
  const sent = [];
  const channels = new Collection();
  const guild = {
    id,
    name,
    sent,
    iconURL: () => null,
    roles: { everyone: { id }, cache: new Collection() },
    members: { me: { id: '999' }, cache: new Collection([[USER, { id: USER, joinedTimestamp: 1 }]]), fetch: async () => ({ id: USER }) },
    channels: {
      cache: channels,
      fetch: async () => null,
      create: async (opts) => {
        const ch = { id: `${id}9`, name: opts.name, guild: null, send: async (p) => (sent.push(p), { id: 'm' }) };
        ch.guild = guild;
        channels.set(ch.id, ch);
        return ch;
      },
    },
  };
  return guild;
}

function multiGuildWorld() {
  const { db } = memoryDb();
  const repo = new ModmailRepository(db);
  const A = fakeGuild('100000000000000001', 'Serveur A');
  const B = fakeGuild('100000000000000002', 'Serveur B');
  const client = { guilds: { cache: new Collection([[A.id, A], [B.id, B]]) }, users: { fetch: async () => null } };
  const config = { get: () => ({ modmail: { enabled: true }, tickets: {} }) };
  const service = new ModmailService({ client, modmail: repo, config });
  const replies = [];
  const acks = [];
  const dm = (content) => ({
    id: String(Date.now()),
    author: { id: USER, username: 'membre', tag: 'membre', displayAvatarURL: () => null, send: async (p) => acks.push(p) },
    content,
    attachments: new Collection(),
    react: async () => {},
    reply: async (p) => (replies.push(p), { id: 'r' }),
  });
  return { repo, A, B, client, service, replies, acks, dm };
}

const relayedTo = (guild, needle) => guild.sent.some((p) => (p.embeds ?? []).some((e) => text(e).includes(needle)));

test('R65 ModMail : membre de plusieurs serveurs → choix du serveur AVANT tout relais, puis relais au serveur choisi', async () => {
  const { repo, A, B, client, service, replies, dm } = multiGuildWorld();
  await service.handleUserDM(dm('Bonjour le staff de B : un modérateur de A me harcèle'));
  await service.handleUserDM(dm('Voici les preuves'));
  assert.equal(A.channels.cache.size + B.channels.cache.size, 0, 'conversation ouverte sans choix du serveur');
  assert.equal(repo.getOpenByUser(USER), undefined);
  assert.equal(replies.length, 1, 'un seul sélecteur de serveur');
  const menu = json(replies[0].components[0]).components[0];
  assert.equal(menu.custom_id, 'cmd:modmail:pick');
  assert.deepEqual(menu.options.map((o) => o.value).sort(), [A.id, B.id]);
  assert.match(text(replies[0].embeds[0]), /Quel serveur/);

  // Le membre choisit B : ses deux messages partent chez B uniquement.
  const calls = { deferUpdate: 0, editReply: [] };
  const interaction = {
    user: { id: USER },
    values: [B.id],
    inGuild: () => false,
    deferUpdate: async () => (calls.deferUpdate += 1),
    editReply: async (p) => calls.editReply.push(p),
  };
  await modmailCmd.buttons.pick(interaction, { services: { modmail: service }, guilds: client.guilds });
  assert.equal(calls.deferUpdate, 1);
  assert.match(text(calls.editReply[0].embeds[0]), /Serveur B/);
  assert.deepEqual(calls.editReply[0].components, []);
  assert.equal(A.channels.cache.size, 0, 'message livré au staff de A');
  assert.ok(relayedTo(B, 'me harcèle') && relayedTo(B, 'Voici les preuves'), 'messages non relayés chez B');
  assert.equal(repo.getOpenByUser(USER).guild_id, B.id);

  // Conversation ouverte : les MP suivants vont chez B sans nouvelle question.
  await service.handleUserDM(dm('Merci'));
  assert.ok(relayedTo(B, 'Merci'));
  assert.equal(replies.length, 1);

  // Choix rejoué (ancien sélecteur) : expiré, rien n'est relayé.
  await assert.rejects(modmailCmd.buttons.pick(interaction, { services: { modmail: service }, guilds: client.guilds }), /expiré/);
  assert.equal(modmailCmd.dmButtons.includes('pick'), true, 'sélecteur inutilisable en MP');
});

test('R65 ModMail : un serveur choisi doit rester éligible (membre, ModMail actif)', async () => {
  const { A, B, client, service, dm } = multiGuildWorld();
  await service.handleUserDM(dm('Bonjour'));
  B.members.cache.delete(USER);
  B.members.fetch = async () => null;
  const interaction = { user: { id: USER }, values: [B.id], inGuild: () => false, deferUpdate: async () => {}, editReply: async () => {} };
  await assert.rejects(modmailCmd.buttons.pick(interaction, { services: { modmail: service }, guilds: client.guilds }), /plus disponible/);
  assert.equal(A.channels.cache.size + B.channels.cache.size, 0);
});

test('R65 ModMail : un seul serveur éligible → relais direct, comme avant', async () => {
  const { A, B, service, replies, dm } = multiGuildWorld();
  A.members.cache.delete(USER);
  A.members.fetch = async () => null;
  await service.handleUserDM(dm('Bonjour B'));
  assert.equal(replies.length, 0);
  assert.ok(relayedTo(B, 'Bonjour B'));
});
