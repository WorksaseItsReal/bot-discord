'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, 'e2e', 'lib');

function fresh(mod) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(LIB)) delete require.cache[key];
  return require(path.join(LIB, mod));
}

test('overrides.d : fichiers fusionnés, clé en double refusée', (t) => {
  const file = path.join(LIB, 'overrides.d', 'zz-test-tmp.js');
  t.after(() => { fs.rmSync(file, { force: true }); fresh('overrides'); });
  fs.writeFileSync(file, "module.exports = { 'commande-test-tmp': { option: 1 } };\n");
  assert.deepEqual(fresh('overrides').OVERRIDES['commande-test-tmp'], { option: 1 });
  fs.writeFileSync(file, "module.exports = { timestamp: { quand: 'x' } };\n");
  assert.throws(() => fresh('overrides'), /déjà définie/);
});

test('fakeRoutes : routes ajoutées après les routes de base, ou avant avec prepend', async (t) => {
  const file = path.join(LIB, 'fakeRoutes', 'zz-test-tmp.js');
  fs.writeFileSync(file, `module.exports = (fake, route, helpers) => {
    route('GET', '/plugin-test/:id', function (params) { return { id: params.id, same: this === fake }; });
    route('GET', '/plugin-first', () => ({ first: true }), { prepend: true });
    fake.pluginHelpers = helpers;
  };\n`);
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}tests${path.sep}e2e${path.sep}`)) delete require.cache[key];
  const { createHarness } = require('./e2e/harness');
  const h = await createHarness();
  t.after(async () => {
    fs.rmSync(file, { force: true });
    await h.close();
  });
  const routes = h.fake.routes;
  assert.ok(routes[0].re.test('/plugin-first'), 'route « prepend » placée en tête');
  const added = routes.findIndex((r) => r.re.test('/plugin-test/42'));
  assert.ok(added > 1, 'route ajoutée après les routes de base');
  assert.deepEqual(await routes[added].handler({ id: '42' }, {}), { id: '42', same: true });
  assert.equal(typeof h.fake.pluginHelpers.error, 'function');
});
