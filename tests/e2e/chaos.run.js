'use strict';

/**
 * `npm run test:chaos` : version longue de la revue par le chaos (toutes les valeurs
 * hostiles, plusieurs rôles et serveurs, toutes les cibles de clics simultanés,
 * plusieurs marches aléatoires de 500 actions).
 * Graine : `CHAOS_SEED=1234 npm run test:chaos` (par défaut : graine fixe, journalisée).
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const files = ['chaos.e2e.test.js', 'chaos-walk.e2e.test.js'].map((f) => path.join(__dirname, f));
const env = { ...process.env, CHAOS_LONG: '1' };
console.log(`Revue par le chaos (version longue) · graine ${env.CHAOS_SEED || '20261009 (par défaut)'}`);
const res = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], { stdio: 'inherit', env });
process.exit(res.status ?? 1);
