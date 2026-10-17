'use strict';

/**
 * Régressions de la revue n° 6 (communauté) : tirage des giveaways, textes de membres
 * publiés par le bot (liens masqués, AutoMod), hiérarchie des récompenses de niveau…
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { memoryDb } = require('./db.helper');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { GiveawayService } = require('../src/services/GiveawayService');
const { pickWinners, lazyShuffle } = require('../src/utils/random');

const GUILD = '100000000000000001';

// ---------------------------------------------------------------- R109 : tirage O(n)

test('R109 tirage : 300 000 participants → la boucle d\'événements n\'est jamais gelée', async () => {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const id = repo.create({ guildId: GUILD, channelId: 'c', messageId: null, prize: 'Nitro', winners: 3, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() - 1 });
  const N = 300_000;
  const insert = db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 0; i < N; i += 1) insert.run(id, String(200000000000000000n + BigInt(i)));
  })();
  const sent = [];
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); return { id: 'a' }; }, messages: { fetch: async () => null } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async (uid) => ({ id: uid, bot: false }) }, guilds: { cache: new Map() }, repositories: {} };
  const service = new GiveawayService({ client, giveaways: repo });

  let maxGap = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const t = performance.now();
    maxGap = Math.max(maxGap, t - last);
    last = t;
  }, 5);
  const started = performance.now();
  let winners;
  try {
    winners = await service.end(id, { guildId: GUILD });
  } finally {
    clearInterval(ticker);
  }
  const total = performance.now() - started;
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners).size, 3);
  assert.ok(total < 3_000, `tirage en ${total.toFixed(0)} ms`);
  assert.ok(maxGap < 1_000, `boucle d'événements gelée ${maxGap.toFixed(0)} ms`);
});

test('R109 pickWinners / lazyShuffle : uniques, bornés, chaque élément tiré au plus une fois', () => {
  const pool = Array.from({ length: 50 }, (_, i) => i);
  const all = [...lazyShuffle(pool)];
  assert.equal(all.length, 50);
  assert.equal(new Set(all).size, 50);
  assert.deepEqual(pool, Array.from({ length: 50 }, (_, i) => i), 'pool modifié');
  assert.equal(pickWinners(pool, 3, () => 0.999).length, 3);
  assert.equal(new Set(pickWinners(pool, 50, () => 0)).size, 50);
  assert.deepEqual(pickWinners(pool, 0), []);
  // Répartition grossière : chaque élément d'un pool de 4 sort premier ~25 % du temps.
  const firsts = new Map();
  for (let i = 0; i < 4_000; i += 1) {
    const [w] = pickWinners(['a', 'b', 'c', 'd'], 1);
    firsts.set(w, (firsts.get(w) ?? 0) + 1);
  }
  for (const k of ['a', 'b', 'c', 'd']) assert.ok(firsts.get(k) > 800 && firsts.get(k) < 1_200, `${k} : ${firsts.get(k)}`);
});
