'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { config, parseNumberEnv } = require('../src/config');
const { createLogger, formatJson } = require('../src/core/logger');
const { startHealthServer, snapshot, renderMetrics } = require('../src/core/healthServer');
const { DatabaseManager } = require('../src/database');
const {
  backupDatabase,
  rotateBackups,
  listBackups,
  backupFileName,
  backupStem,
  defaultBackupDir,
  AutoBackup,
} = require('../src/database/backup');

const ROOT = path.join(__dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gadget-devops-'));
}

/** Faux client Discord : juste ce que lit le serveur de supervision. */
function fakeClient({ ready = true, ping = 42, guilds = 3, database } = {}) {
  return {
    isReady: () => ready,
    ws: { ping },
    guilds: { cache: { size: guilds } },
    uptime: 125_000,
    commands: { size: 7 },
    stats: { commandsRun: 11, errors: 2 },
    database,
  };
}

// ---------- Configuration ----------

test('config : parseNumberEnv (vide, bornes, entiers)', () => {
  assert.equal(parseNumberEnv(undefined), null);
  assert.equal(parseNumberEnv(''), null);
  assert.equal(parseNumberEnv('  '), null);
  assert.equal(parseNumberEnv('8080', { min: 0, max: 65535 }), 8080);
  assert.equal(parseNumberEnv('0', { min: 0, max: 65535 }), 0);
  assert.equal(parseNumberEnv('70000', { min: 0, max: 65535 }), null);
  assert.equal(parseNumberEnv('abc'), null);
  assert.equal(parseNumberEnv('1.5'), null);
  assert.equal(parseNumberEnv('1.5', { integer: false }), 1.5);
  assert.equal(parseNumberEnv('-3'), null);
});

test('config : valeurs par défaut de l\'exploitation', () => {
  assert.equal(typeof config.logFormat, 'string');
  assert.ok(config.dbBackupKeep >= 1);
  assert.ok(config.healthPort === null || Number.isInteger(config.healthPort));
});

// ---------- Logs JSON ----------

test('logs JSON : une ligne, champs time/level/scope/msg/err', () => {
  const err = new Error('boom');
  err.code = 50013;
  const line = formatJson('error', 'db', ['Échec :', err, { a: 1 }], new Date('2026-01-02T03:04:05.000Z'));
  assert.ok(!line.includes('\n'), 'une seule ligne');
  const entry = JSON.parse(line);
  assert.equal(entry.time, '2026-01-02T03:04:05.000Z');
  assert.equal(entry.level, 'error');
  assert.equal(entry.scope, 'db');
  assert.equal(entry.msg, 'Échec : { a: 1 }');
  assert.equal(entry.err.name, 'Error');
  assert.equal(entry.err.message, 'boom');
  assert.equal(entry.err.code, 50013);
  assert.match(entry.err.stack, /boom/);
});

test('logs JSON : rédaction des jetons et requestBody conservée', () => {
  const err = new Error('Invalid Webhook Token');
  err.url = 'https://discord.com/api/v10/webhooks/123/SECRETTOKEN/messages/@original';
  err.requestBody = { json: { content: 'message privé' }, files: [] };
  const line = formatJson('warn', '', ['vu /interactions/99/AUTRESECRET/callback', err]);
  assert.ok(!line.includes('SECRETTOKEN'));
  assert.ok(!line.includes('AUTRESECRET'));
  assert.ok(!line.includes('message privé'));
  assert.ok(!line.includes('requestBody'));
  const entry = JSON.parse(line);
  assert.equal(entry.scope, '');
  assert.match(entry.err.url, /\[REDACTED\]/);
  assert.match(entry.msg, /\/interactions\/99\/\[REDACTED\]\/callback/);
});

test('logs JSON : erreur seule → msg = message ; BigInt et cycles sûrs', () => {
  const only = JSON.parse(formatJson('error', 's', [new Error('seule')]));
  assert.equal(only.msg, 'seule');
  const cyc = { n: 1n };
  cyc.self = cyc;
  const entry = JSON.parse(formatJson('info', 's', ['x', cyc]));
  assert.match(entry.msg, /Circular/);
  assert.equal(entry.err, undefined);
});

test('logs : LOG_FORMAT=json et LOG_LEVEL respectés', (t) => {
  const prev = { format: config.logFormat, level: config.logLevel };
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(a));
  t.mock.method(console, 'error', (...a) => lines.push(a));
  try {
    config.logFormat = 'json';
    config.logLevel = 'info';
    const log = createLogger('ops');
    log.info('bonjour');
    log.debug('masqué');
    log.child('sub').warn('attention');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].length, 1, 'une seule chaîne par entrée');
    assert.deepEqual(
      lines.map(([l]) => JSON.parse(l)).map(({ level, scope, msg }) => ({ level, scope, msg })),
      [
        { level: 'info', scope: 'ops', msg: 'bonjour' },
        { level: 'warn', scope: 'ops:sub', msg: 'attention' },
      ],
    );
    // Format texte : inchangé (préfixe coloré + arguments séparés).
    config.logFormat = 'text';
    lines.length = 0;
    log.info('texte', 1);
    assert.equal(lines[0].length, 3);
    assert.match(lines[0][0], /INFO \[ops\]/);
  } finally {
    config.logFormat = prev.format;
    config.logLevel = prev.level;
  }
});

// ---------- Serveur de supervision ----------

test('healthz : instantané cohérent', () => {
  const manager = new DatabaseManager(':memory:');
  manager.connect();
  try {
    assert.deepEqual(snapshot(fakeClient({ database: manager })), {
      status: 'ok', ready: true, ping: 42, guilds: 3, uptime: 125, db: 'ok',
    });
    assert.equal(snapshot(fakeClient({ ready: false, database: manager })).status, 'unavailable');
  } finally {
    manager.close();
  }
  assert.equal(snapshot(fakeClient({ database: manager })).db, 'closed');
  assert.equal(snapshot(fakeClient({ database: { db: { prepare() { throw new Error('disk I/O'); } } } })).db, 'error');
});

test('healthz : 200 si prêt et base OK, 503 sinon ; metrics ; 404/405 ; fermeture', async () => {
  const manager = new DatabaseManager(':memory:');
  manager.connect();
  const client = fakeClient({ database: manager });
  const srv = await startHealthServer(client, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    assert.ok(srv.port > 0);

    let res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['db', 'guilds', 'ping', 'ready', 'status', 'uptime']);
    assert.equal(body.status, 'ok');
    assert.equal(body.ready, true);

    client.isReady = () => false;
    res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ready, false);

    client.isReady = () => true;
    manager.close();
    res = await fetch(`${base}/healthz?x=1`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).db, 'closed');

    res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /^# HELP gadget_up /m);
    assert.match(text, /^gadget_guilds 3$/m);
    assert.match(text, /^gadget_ws_ping_milliseconds 42$/m);
    assert.match(text, /^gadget_commands_run_total 11$/m);
    assert.match(text, /^gadget_db_up 0$/m);
    assert.match(text, /^process_resident_memory_bytes \d+$/m);

    res = await fetch(`${base}/inconnu`);
    assert.equal(res.status, 404);
    res = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    res = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(res.status, 503);
  } finally {
    await srv.close();
    await srv.close(); // idempotent
  }
  await assert.rejects(fetch(`${base}/healthz`));
});

test('metrics : format Prometheus (HELP + TYPE par métrique)', () => {
  const text = renderMetrics(fakeClient({ ready: false }));
  const names = [...text.matchAll(/^# TYPE (\S+) (gauge|counter)$/gm)].map((m) => m[1]);
  assert.ok(names.includes('gadget_errors_total'));
  for (const n of names) assert.match(text, new RegExp(`^${n} -?\\d+$`, 'm'));
  assert.ok(text.endsWith('\n'));
});

test('healthz : port occupé → rejet (le bot journalise et continue)', async () => {
  const a = await startHealthServer(fakeClient(), { port: 0 });
  try {
    await assert.rejects(startHealthServer(fakeClient(), { port: a.port }), /EADDRINUSE/);
  } finally {
    await a.close();
  }
});

test('GadgetClient : serveur de supervision démarré puis fermé par shutdown()', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  client.database = new DatabaseManager(':memory:');
  client.database.connect();
  await client.startOperations({ healthPort: 0, healthHost: '127.0.0.1', dbBackupIntervalHours: null });
  assert.ok(client.healthServer);
  const url = `http://127.0.0.1:${client.healthServer.port}/healthz`;
  const res = await fetch(url);
  assert.equal(res.status, 503, 'pas encore connecté à Discord');
  await res.text();
  await client.shutdown();
  await assert.rejects(fetch(url));
  assert.equal(client.database.db, null, 'base fermée');
});

test('GadgetClient : sans HEALTH_PORT ni intervalle, rien ne démarre', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  await client.startOperations({ healthPort: null, dbBackupIntervalHours: null });
  assert.equal(client.healthServer, undefined);
  assert.equal(client.autoBackup, undefined);
  await client.destroy();
});

// ---------- Sauvegardes de la base ----------

function seedDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 50; i++) ins.run(`ligne ${i}`);
  return db;
}

test('sauvegarde : nommage, préfixe et dossier par défaut', () => {
  assert.equal(backupFileName('gadget', new Date(2026, 0, 5, 7, 3)), 'gadget-20260105-0703.sqlite');
  assert.equal(backupStem('/app/data/gadget.sqlite'), 'gadget');
  assert.equal(backupStem('./data/prod.db'), 'prod');
  assert.equal(backupStem(':memory:'), 'gadget');
  assert.equal(defaultBackupDir('/app/data/gadget.sqlite'), path.join('/app/data', 'backups'));
});

test('sauvegarde : copie cohérente lisible (base WAL en cours d\'utilisation)', async () => {
  const dir = tmpDir();
  const db = seedDb(path.join(dir, 'gadget.sqlite'));
  try {
    const res = await backupDatabase(db, { dir: path.join(dir, 'backups'), stem: 'gadget', keep: 14, now: new Date(2026, 9, 7, 14, 30) });
    assert.equal(path.basename(res.file), 'gadget-20261007-1430.sqlite');
    assert.ok(res.size > 0);
    assert.deepEqual(res.removed, []);
    assert.ok(!fs.existsSync(`${res.file}.partial`));
    const copy = new Database(res.file, { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM t').get().n, 50);
    copy.close();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sauvegarde : rotation (garde les N plus récentes, ignore les autres fichiers)', async () => {
  const dir = tmpDir();
  const db = seedDb(path.join(dir, 'gadget.sqlite'));
  const bdir = path.join(dir, 'backups');
  try {
    for (let d = 1; d <= 5; d++) {
      await backupDatabase(db, { dir: bdir, stem: 'gadget', keep: 3, now: new Date(2026, 0, d, 12, 0) });
    }
    fs.writeFileSync(path.join(bdir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(bdir, 'autre-20200101-0000.sqlite'), 'x');
    assert.deepEqual(listBackups(bdir, 'gadget'), [
      'gadget-20260103-1200.sqlite',
      'gadget-20260104-1200.sqlite',
      'gadget-20260105-1200.sqlite',
    ]);
    assert.deepEqual(rotateBackups(bdir, 'gadget', 1), ['gadget-20260103-1200.sqlite', 'gadget-20260104-1200.sqlite']);
    assert.ok(fs.existsSync(path.join(bdir, 'notes.txt')));
    assert.ok(fs.existsSync(path.join(bdir, 'autre-20200101-0000.sqlite')));
    assert.deepEqual(listBackups(path.join(dir, 'absent'), 'gadget'), []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sauvegarde : échec → pas de fichier partiel', async () => {
  const dir = tmpDir();
  try {
    const fakeDb = { backup: async (dest) => { fs.writeFileSync(dest, 'à moitié'); throw new Error('disque plein'); } };
    await assert.rejects(backupDatabase(fakeDb, { dir, stem: 'gadget', now: new Date(2026, 0, 1, 0, 0) }), /disque plein/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sauvegarde automatique : run(), délai initial, stop() attend la sauvegarde', async () => {
  const dir = tmpDir();
  const manager = new DatabaseManager(path.join(dir, 'gadget.sqlite'));
  manager.connect();
  const bdir = path.join(dir, 'backups');
  try {
    const auto = new AutoBackup({ database: manager, intervalHours: 24, dir: bdir, stem: 'gadget', keep: 2 });
    assert.equal(auto.intervalMs, 24 * 3_600_000);
    assert.equal(auto.firstDelay(), 60_000, 'aucune sauvegarde : première dans 1 min');

    const pending = auto.run();
    assert.equal(auto.run(), pending, 'une seule sauvegarde à la fois');
    const res = await pending;
    assert.ok(res && fs.existsSync(res.file));
    const delay = auto.firstDelay();
    assert.ok(delay > 23 * 3_600_000 && delay <= 24 * 3_600_000, 'sauvegarde récente : on attend l\'intervalle');
    assert.ok(auto.firstDelay(Date.now() + 48 * 3_600_000) === 60_000, 'sauvegarde ancienne : rattrapage rapide');

    auto.start();
    assert.ok(auto.timer);
    const inFlight = auto.run();
    await auto.stop();
    assert.equal(auto.current, null, 'stop() a attendu la sauvegarde en cours');
    assert.ok(await inFlight);
    assert.equal(auto.timer, null);

    // Base fermée : erreur journalisée, jamais propagée.
    manager.close();
    const origError = console.error;
    console.error = () => {};
    try {
      assert.equal(await new AutoBackup({ database: manager, intervalHours: 1, dir: bdir }).run(), null);
    } finally {
      console.error = origError;
    }
  } finally {
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GadgetClient : sauvegarde automatique arrêtée par shutdown()', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const dir = tmpDir();
  const client = new GadgetClient();
  client.database = new DatabaseManager(path.join(dir, 'gadget.sqlite'));
  client.database.connect();
  try {
    await client.startOperations({ healthPort: null, dbBackupIntervalHours: 24, dbBackupDir: '', dbBackupKeep: 3 });
    assert.ok(client.autoBackup?.timer);
    assert.equal(client.autoBackup.dir, path.join(dir, 'backups'));
    const running = client.autoBackup.run();
    await client.shutdown();
    assert.ok(await running, 'sauvegarde terminée avant la fermeture de la base');
    assert.equal(client.autoBackup.timer, null);
    assert.equal(client.database.db, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run backup:db : crée la sauvegarde et applique DB_BACKUP_KEEP', () => {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'gadget.sqlite');
  seedDb(dbFile).close();
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  for (const n of ['gadget-20200101-0000.sqlite', 'gadget-20200102-0000.sqlite']) fs.writeFileSync(path.join(bdir, n), 'ancien');
  try {
    const env = { ...process.env, DATABASE_PATH: dbFile, DB_BACKUP_KEEP: '2', DB_BACKUP_DIR: '', LOG_FORMAT: 'text' };
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup-db.js')], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const files = listBackups(bdir, 'gadget');
    assert.equal(files.length, 2);
    assert.equal(files[0], 'gadget-20200102-0000.sqlite');
    const copy = new Database(path.join(bdir, files[1]), { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM t').get().n, 50);
    copy.close();
    // La sauvegarde n'applique aucune migration à la base d'origine.
    const orig = new Database(dbFile, { readonly: true });
    assert.equal(orig.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_migrations'").get().n, 0);
    orig.close();

    const missing = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup-db.js')], {
      cwd: dir, env: { ...env, DATABASE_PATH: path.join(dir, 'absente.sqlite') }, encoding: 'utf8',
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Base introuvable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
