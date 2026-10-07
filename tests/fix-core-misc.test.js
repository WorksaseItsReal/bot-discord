'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { parseDuration, MAX_DURATION_MS } = require('../src/utils/time');
const { sanitize, redact } = require('../src/core/logger');
const { handleFatal, setShutdownHook, _resetFatalState } = require('../src/core/errors');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService, deepMerge } = require('../src/services/ConfigService');
const { CommandHandler } = require('../src/core/CommandHandler');

// ---------- parseDuration ----------

test('parseDuration : plafonné à 1 an', () => {
  assert.equal(parseDuration('52w'), 52 * 7 * 86_400_000);
  assert.equal(parseDuration('365d'), MAX_DURATION_MS);
  assert.equal(parseDuration('366d'), null);
  assert.equal(parseDuration('9999w'), null);
});

test('parseDuration : valeurs non finies / non entières sûres rejetées', () => {
  assert.equal(parseDuration(`${'9'.repeat(400)}s`), null); // Infinity
  assert.equal(parseDuration(`${'9'.repeat(20)}s`), null); // > MAX_SAFE_INTEGER
  assert.equal(parseDuration('0s'), null);
  assert.equal(parseDuration('1h30m'), 5_400_000);
});

// ---------- Logger ----------

test('logger : jetons webhook/interaction masqués', () => {
  assert.equal(
    redact('PATCH https://discord.com/api/v10/webhooks/123456/aBc-DeF_gh.ij/messages/@original'),
    'PATCH https://discord.com/api/v10/webhooks/123456/[REDACTED]/messages/@original',
  );
  assert.equal(redact('/interactions/987/tok3n/callback'), '/interactions/987/[REDACTED]/callback');
});

test('logger : DiscordAPIError sérialisée sans requestBody ni jeton', () => {
  class DiscordAPIError extends Error {}
  const err = new DiscordAPIError('Unknown interaction at /interactions/1/secret-token/callback');
  Object.assign(err, {
    code: 10062,
    status: 404,
    method: 'POST',
    url: 'https://discord.com/api/v10/interactions/1/secret-token/callback',
    requestBody: { json: { content: 'message privé' }, files: [] },
  });
  const out = sanitize(err);
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('secret-token'), out);
  assert.ok(!out.includes('message privé'), out);
  assert.ok(!out.includes('requestBody'), out);
  assert.ok(out.includes('10062'));
  // L'erreur d'origine n'est pas modifiée.
  assert.ok(err.requestBody);
});

test('logger : objets simples et cycles gérés', () => {
  const obj = { url: '/webhooks/1/tok', nested: { requestBody: 'x', ok: 1 } };
  obj.self = obj;
  const out = sanitize(obj);
  assert.equal(out.url, '/webhooks/1/[REDACTED]');
  assert.deepEqual(out.nested, { ok: 1 });
  assert.equal(out.self, '[Circular]');
});

// ---------- uncaughtException ----------

test('exception fatale : log, arrêt propre puis exit(1)', async () => {
  _resetFatalState();
  const order = [];
  const logger = { error: () => order.push('log') };
  setShutdownHook(async () => order.push('shutdown'));
  await handleFatal(logger, new Error('boom'), { exit: (code) => order.push(`exit:${code}`) });
  assert.deepEqual(order.filter((o) => o !== 'log').concat(), ['shutdown', 'exit:1']);
  assert.equal(order[0], 'log');
  _resetFatalState();
});

test('exception fatale : arrêt en échec ou absent → exit(1) quand même', async () => {
  _resetFatalState();
  const exits = [];
  setShutdownHook(async () => { throw new Error('db'); });
  await handleFatal({ error: () => {} }, new Error('boom'), { exit: (c) => exits.push(c) });
  _resetFatalState();
  await handleFatal({ error: () => {} }, new Error('boom'), { exit: (c) => exits.push(c) });
  assert.deepEqual(exits, [1, 1]);
  _resetFatalState();
});

// ---------- ConfigService ----------

test('deepMerge : une valeur stockée de mauvais type ne remplace pas un objet par défaut', () => {
  const defaults = { moderation: { dmOnSanction: true }, logs: { enabled: true }, list: [1], locale: 'fr', x: null };
  const merged = deepMerge(defaults, { moderation: null, logs: [1, 2], list: [3], locale: 'en', x: { a: 1 } });
  assert.deepEqual(merged.moderation, { dmOnSanction: true });
  assert.deepEqual(merged.logs, { enabled: true });
  assert.deepEqual(merged.list, [3]);
  assert.equal(merged.locale, 'en');
  assert.deepEqual(merged.x, { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: 'oops' }), { a: { b: 1 } });
});

test('ConfigService : section stockée à null → valeurs par défaut', () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  repo.set('g', { moderation: null, locale: 'en' });
  const cfg = new ConfigService(repo).get('g');
  assert.equal(cfg.moderation.dmOnSanction, true);
  assert.equal(cfg.locale, 'en');
});

test('ConfigService : JSON corrompu sauvegardé avant écrasement', () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  db.prepare('INSERT INTO guild_config (guild_id, data, updated_at) VALUES (?, ?, ?)').run('g', '{"locale":"en", oops', Date.now());
  const svc = new ConfigService(repo);
  assert.equal(svc.get('g').locale, 'fr');
  svc.update('g', { moderation: { requireReason: true } });
  const stored = repo.get('g');
  assert.equal(stored.moderation.requireReason, true);
  assert.equal(stored._corruptBackup.raw, '{"locale":"en", oops');
});

test('ConfigService : markLeft sans config stockée ne crée pas de ligne', () => {
  const { db } = memoryDb();
  const repo = new GuildConfigRepository(db);
  const svc = new ConfigService(repo);
  assert.equal(svc.markLeft('none'), false);
  assert.equal(repo.get('none'), null);
});

// ---------- CommandHandler ----------

test('CommandHandler : les échecs de chargement sont collectés', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gadget-cmds-'));
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'throw new Error("syntaxe");');
    fs.writeFileSync(path.join(dir, 'invalid.js'), 'module.exports = {};');
    const handler = new CommandHandler();
    handler.loadAll(dir);
    assert.equal(handler.commands.size, 0);
    assert.deepEqual(handler.failures.map((f) => f.file).sort(), ['broken.js', 'invalid.js']);
    assert.equal(CommandHandler.countFiles(dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- GadgetClient.shutdown ----------

test('shutdown : attend scheduler.stop() avant de fermer la base (idempotent)', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  const order = [];
  let release;
  client.services = { scheduler: { stop: () => new Promise((r) => { release = () => { order.push('scheduler'); r(); }; }) } };
  client.destroy = async () => order.push('destroy');
  client.database = { close: () => order.push('db') };
  const p1 = client.shutdown();
  const p2 = client.shutdown();
  assert.equal(p1, p2);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, []);
  release();
  await p1;
  assert.deepEqual(order, ['scheduler', 'destroy', 'db']);
});
