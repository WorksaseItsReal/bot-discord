'use strict';

/**
 * Revue n° 6, lot « logs » : tests unitaires (LoggingService, LogSetupService, troncature).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P, Collection, ChannelType } = require('discord.js');
const { LoggingService } = require('../src/services/LoggingService');
const { card } = require('../src/utils/ui');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const GUILD = '100000000000000001';
const LOGS = '200000000000000001';

function configService() {
  const { db } = memoryDb();
  return new ConfigService(new GuildConfigRepository(db));
}

/** Serveur minimal en cache avec un salon de logs dont `send` est fourni par le test. */
function world(send, { perms = PermissionsBitField.All } = {}) {
  const config = configService();
  config.update(GUILD, { logChannels: { messages: LOGS } });
  const me = { id: '999999999999999999' };
  const guild = { id: GUILD, members: { me }, channels: { cache: new Collection() } };
  const channel = { id: LOGS, type: ChannelType.GuildText, guild, send, permissionsFor: () => new PermissionsBitField(perms) };
  guild.channels.cache.set(LOGS, channel);
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) } };
  return { logging: new LoggingService(client, config), channel };
}

const embed = () => card({ tone: 'danger', title: 'Suppression en masse', fields: [] });
const file = { name: 'purge.txt' };

// ---------------------------------------------------------------- R54

test('R54 : Discord refuse la pièce jointe (50013) → la carte repart sans le fichier, avec une explication', async () => {
  const payloads = [];
  const { logging } = world(async (payload) => {
    payloads.push(payload);
    if (payload.files?.length) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    return { id: '1' };
  });
  const ok = await logging.send(GUILD, 'messages', embed(), undefined, { event: 'messageBulkDelete', files: [file] });
  assert.equal(ok, true, 'log perdu');
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].files, undefined);
  assert.match(JSON.stringify(payloads[1].embeds[0].toJSON()), /Joindre des fichiers/);
});

test('R54 : « Joindre des fichiers » manquant d\'après le cache → envoi direct sans fichier', async () => {
  const payloads = [];
  const { logging } = world(async (payload) => {
    payloads.push(payload);
    return { id: '1' };
  }, { perms: P.ViewChannel | P.SendMessages | P.EmbedLinks });
  assert.equal(await logging.send(GUILD, 'messages', embed(), undefined, { files: [file] }), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].files, undefined);
  assert.match(JSON.stringify(payloads[0].embeds[0].toJSON()), /Joindre des fichiers/);
});

test('R54 : une autre erreur n\'est pas réessayée', async () => {
  let calls = 0;
  const { logging } = world(async () => {
    calls += 1;
    throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
  });
  assert.equal(await logging.send(GUILD, 'messages', embed(), undefined, { files: [file] }), false);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------- R56

test('R56 : file bornée par salon — cartes en trop abandonnées et comptées, prioritaires jamais abandonnées', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  const { logging } = world(async (payload) => {
    await gate;
    sent.push(payload);
    return { id: String(sent.length) };
  });
  const config = logging.config;
  config.update(GUILD, { logChannels: { voice: LOGS, security: LOGS } });
  const voice = (i) => logging.send(GUILD, 'voice', card({ title: `Connexion vocale ${i}` }), undefined, { event: 'voiceJoin' });
  const results = [];
  for (let i = 0; i < 205; i++) results.push(voice(i));
  const alert = logging.send(GUILD, 'security', card({ title: 'ALERTE' }), undefined, { event: 'antiraid' });
  release();
  const done = await Promise.all(results);
  assert.equal(await alert, true, 'alerte prioritaire abandonnée');
  // 1 carte en cours d'envoi + 200 en attente ; les 4 suivantes sont abandonnées.
  assert.equal(done.filter((x) => x === false).length, 4);
  await new Promise((r) => setImmediate(r));
  const titles = sent.flatMap((p) => p.embeds.map((e) => e.title ?? e.data?.title ?? ''));
  assert.equal(titles.filter((t) => /Connexion vocale/.test(t)).length, 201);
  assert.ok(sent.length < 40, `${sent.length} messages : aucun regroupement`);
  // L'alerte part juste après la carte déjà en cours d'envoi, devant les 200 en attente.
  assert.match(JSON.stringify(sent[1].embeds), /ALERTE/);
  // Fin de l'inondation : une carte indique combien de logs ont été ignorés.
  assert.match(JSON.stringify(sent.at(-1).embeds), /4\*\* log\(s\) ignoré/);
  assert.equal(logging.queues.size, 0, 'file non libérée');
});
