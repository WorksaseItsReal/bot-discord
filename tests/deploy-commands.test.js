'use strict';

/**
 * scripts/deploy-commands.js : les commandes de portée « owner » (/bot) ne partent JAMAIS dans
 * le lot global ; le serveur propriétaire est validé AVANT le premier PUT (aucun déploiement à
 * moitié fait). Plan pur, puis vrai script dans un processus fils avec un REST simulé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planDeployment, countBody, isNotInGuild } = require('../scripts/deploy-commands');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deploy-commands.js');
const DEV = '500000000000000001';
const OWNER = '500000000000000002';
const CLIENT = '500000000000000009';

const slash = (name) => ({ name, type: 1 });
const globalBody = [slash('ping'), slash('ban'), { name: 'Signaler', type: 3 }];
const ownerBody = [slash('bot')];

test('plan : --global → PUT global SANS /bot puis PUT owner ; validation du serveur propriétaire', () => {
  const plan = planDeployment({ global: true, devGuildId: DEV, ownerGuildId: OWNER, globalBody, ownerBody });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.targets.map((t) => [t.kind, t.guildId ?? null, t.body.map((c) => c.name)]), [
    ['global', null, ['ping', 'ban', 'Signaler']],
    ['guild', OWNER, ['bot']],
  ]);
  assert.equal(plan.validateOwner, OWNER);
});

test('plan : mode dev → un seul PUT fusionné si DEV = OWNER, sinon PUT dev puis PUT owner', () => {
  const same = planDeployment({ devGuildId: DEV, ownerGuildId: DEV, globalBody, ownerBody });
  assert.equal(same.targets.length, 1);
  assert.deepEqual(same.targets[0].body.map((c) => c.name), ['ping', 'ban', 'Signaler', 'bot']);
  assert.equal(same.targets[0].merged, true);
  const split = planDeployment({ devGuildId: DEV, ownerGuildId: OWNER, globalBody, ownerBody });
  assert.deepEqual(split.targets.map((t) => [t.guildId, t.body.length]), [[DEV, 3], [OWNER, 1]]);
});

test('plan : sans OWNER_GUILD_ID ou avec --skip-owner → avertissement, JAMAIS de repli en global', () => {
  for (const opts of [{ ownerGuildId: '' }, { ownerGuildId: OWNER, skipOwner: true }]) {
    const plan = planDeployment({ global: true, globalBody, ownerBody, ...opts });
    assert.equal(plan.targets.length, 1);
    assert.ok(!plan.targets[0].body.some((c) => c.name === 'bot'));
    assert.equal(plan.validateOwner, null);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /\/bot/);
  }
});

test('plan : --clear-guild (avertit si DEV = OWNER), incompatibilités, plafonds de Discord', () => {
  const clear = planDeployment({ clearGuild: true, devGuildId: DEV, ownerGuildId: DEV, ownerBody });
  assert.deepEqual(clear.targets.map((t) => [t.guildId, t.body.length]), [[DEV, 0]]);
  assert.match(clear.warnings[0], /AUSSI supprimées/);
  assert.deepEqual(planDeployment({ clearGuild: true, devGuildId: DEV, ownerGuildId: OWNER }).warnings, []);
  assert.match(planDeployment({ clearGuild: true }).errors[0], /DEV_GUILD_ID/);
  assert.match(planDeployment({ clearGuild: true, global: true, devGuildId: DEV }).errors[0], /incompatibles/);
  const many = Array.from({ length: 101 }, (_, i) => slash(`c${i}`));
  assert.match(planDeployment({ global: true, globalBody: many }).errors[0], /100 au plus/);
  // DEV = OWNER : 100 commandes globales + /bot dépasseraient la limite du serveur.
  assert.match(planDeployment({ devGuildId: DEV, ownerGuildId: DEV, globalBody: many.slice(0, 100), ownerBody }).errors[0], /101 commandes slash/);
  const menus = Array.from({ length: 6 }, (_, i) => ({ name: `M${i}`, type: 2 }));
  assert.match(planDeployment({ global: true, globalBody: menus }).errors[0], /Menus contextuels/);
  assert.deepEqual(countBody(globalBody), { slash: 2, userMenus: 0, messageMenus: 1, menus: 1 });
  assert.equal(isNotInGuild({ code: 50001 }), true);
  assert.equal(isNotInGuild({ code: 10004 }), true);
  assert.equal(isNotInGuild({ status: 403 }), true);
  assert.equal(isNotInGuild({ status: 500 }), false);
});

// ---------------------------------------------------------------- vrai script, REST simulé

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gadget-deploy-'));
const PRELOAD = path.join(TMP, 'fake-rest.js');
fs.writeFileSync(PRELOAD, `'use strict';
const fs = require('node:fs');
const { REST, DiscordAPIError } = require(${JSON.stringify(require.resolve('discord.js', { paths: [ROOT] }))});
const record = (entry) => fs.appendFileSync(process.env.FAKE_REST_LOG, JSON.stringify(entry) + '\\n');
REST.prototype.get = async function (route) {
  record({ method: 'GET', route });
  const code = Number(process.env.FAKE_REST_GET_ERROR || 0);
  if (code) throw new DiscordAPIError({ code, message: 'Missing Access' }, code, code === 10004 ? 404 : 403, 'GET', 'https://discord.com/api/v10' + route, {});
  return [];
};
REST.prototype.put = async function (route, opts) {
  record({ method: 'PUT', route, names: (opts && opts.body ? opts.body : []).map((c) => c.name) });
  return [];
};
`);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Lance le script avec un environnement MINIMAL (aucune variable héritée du parent). */
function deploy(args, { env = {}, token = true } = {}) {
  const log = path.join(TMP, `rest-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const res = spawnSync(process.execPath, ['-r', PRELOAD, SCRIPT, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      CLIENT_ID: CLIENT,
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'info',
      DATABASE_PATH: ':memory:',
      FAKE_REST_LOG: log,
      ...(token ? { DISCORD_TOKEN: 'jeton-de-test' } : {}),
      ...env,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: res.status, out: `${res.stdout}\n${res.stderr}`, calls };
}

const route = (guild) => (guild ? `/applications/${CLIENT}/guilds/${guild}/commands` : `/applications/${CLIENT}/commands`);

test('script --global : GET owner d\'abord, PUT global sans /bot, puis PUT owner séparé', () => {
  const { code, calls, out } = deploy(['--global'], { env: { DEV_GUILD_ID: DEV, OWNER_GUILD_ID: OWNER } });
  assert.equal(code, 0, out);
  assert.deepEqual(calls.map((c) => [c.method, c.route]), [['GET', route(OWNER)], ['PUT', route(null)], ['PUT', route(OWNER)]]);
  assert.ok(!calls[1].names.includes('bot'), '/bot absent du PUT global');
  assert.ok(calls[1].names.length >= 60 && calls[1].names.length <= 100 + 10);
  assert.deepEqual(calls[2].names, ['bot']);
});

test('script mode dev : PUT unique fusionné si DEV = OWNER ; sinon PUT dev puis PUT owner', () => {
  const same = deploy([], { env: { DEV_GUILD_ID: DEV, OWNER_GUILD_ID: DEV } });
  assert.equal(same.code, 0, same.out);
  const puts = same.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].route, route(DEV));
  assert.ok(puts[0].names.includes('bot') && puts[0].names.includes('ping'));
  const split = deploy([], { env: { DEV_GUILD_ID: DEV, OWNER_GUILD_ID: OWNER } });
  assert.equal(split.code, 0, split.out);
  assert.deepEqual(split.calls.map((c) => [c.method, c.route]), [['GET', route(OWNER)], ['PUT', route(DEV)], ['PUT', route(OWNER)]]);
  assert.ok(!split.calls[1].names.includes('bot'));
});

test('script : bot absent de OWNER_GUILD_ID (50001, 10004) → arrêt SANS AUCUN PUT ; --skip-owner déploie le lot global', () => {
  for (const code of [50001, 10004]) {
    const res = deploy(['--global'], { env: { OWNER_GUILD_ID: OWNER, FAKE_REST_GET_ERROR: String(code) } });
    assert.equal(res.code, 1, res.out);
    assert.deepEqual(res.calls.map((c) => c.method), ['GET'], 'aucun PUT');
    assert.match(res.out, /le bot n'est pas dans OWNER_GUILD_ID/);
  }
  const skip = deploy(['--global', '--skip-owner'], { env: { OWNER_GUILD_ID: OWNER, FAKE_REST_GET_ERROR: '50001' } });
  assert.equal(skip.code, 0, skip.out);
  assert.deepEqual(skip.calls.map((c) => [c.method, c.route]), [['PUT', route(null)]]);
  assert.ok(!skip.calls[0].names.includes('bot'));
  assert.match(skip.out, /--skip-owner/);
});

test('script sans OWNER_GUILD_ID : avertissement, lot global seul, /bot nulle part', () => {
  const res = deploy(['--global']);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.calls.map((c) => [c.method, c.route]), [['PUT', route(null)]]);
  assert.ok(!res.calls[0].names.includes('bot'));
  assert.match(res.out, /OWNER_GUILD_ID non défini/);
});

test('script --dry-run : les deux cibles affichées, aucun appel, aucun jeton requis', () => {
  const res = deploy(['--global', '--dry-run'], { env: { OWNER_GUILD_ID: OWNER }, token: false });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.calls, []);
  assert.match(res.out, /\[dry-run\] \d+ commande\(s\) seraient déployée\(s\) globalement/);
  assert.match(res.out, new RegExp(`\\[dry-run\\] 1 commande\\(s\\) seraient déployée\\(s\\) sur le serveur propriétaire ${OWNER}[^"]*: bot`));
});

test('script --clear-guild : PUT [] sur DEV_GUILD_ID, avertissement si DEV = OWNER', () => {
  const res = deploy(['--clear-guild'], { env: { DEV_GUILD_ID: DEV, OWNER_GUILD_ID: DEV } });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.calls, [{ method: 'PUT', route: route(DEV), names: [] }]);
  assert.match(res.out, /AUSSI supprimées/);
});
