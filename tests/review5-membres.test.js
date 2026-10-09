'use strict';

/**
 * Régressions de la revue n° 5 (économie, mini-jeux, outils des membres) : briques pures et
 * services. Les scénarios Discord complets sont dans tests/e2e/review5-membres.e2e.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { EconomyRepository } = require('../src/database/repositories/EconomyRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { EconomyService } = require('../src/services/EconomyService');
const E = require('../src/utils/economy');
const eco = require('../src/commands/economy/eco');

const GUILD = '100000000000000001';
const ALICE = '200000000000000002';
const CAROL = '200000000000000004';

function world(patch = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new EconomyRepository(db);
  const svc = new EconomyService({ economy: repo, config });
  config.update(GUILD, { economy: { enabled: true, ...patch } });
  return { db, config, repo, svc };
}

const text = (view) => JSON.stringify(view.embeds.map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e)));

// ---------------------------------------------------------------- machine à sous

test('machine à sous : espérance EXACTE quelle que soit la mise (216 tirages × reste tiré au sort)', () => {
  const weight = Object.fromEntries(E.SLOT_SYMBOLS.map((s) => [s.emoji, s.weight]));
  const total = E.SLOT_SYMBOLS.reduce((n, s) => n + s.weight, 0);
  // 100 valeurs de rng régulièrement réparties : la moyenne du gain d'un tirage vaut exactement
  // partie entière + reste / 100 si le reste est tiré au sort, la partie entière seule sinon.
  const grid = Array.from({ length: 100 }, (_, k) => (k + 0.5) / 100);
  for (const edge of [1, 5, 50]) {
    const table = E.slotsTable(edge);
    const rtp = E.tableReturn(table);
    assert.ok(rtp <= 1 - edge / 100 + 1e-12, `avantage ${edge} % : retour ${rtp}`);
    for (const bet of [1, 7, 10, 100]) {
      let expected = 0;
      for (const a of E.SLOT_SYMBOLS) for (const b of E.SLOT_SYMBOLS) for (const c of E.SLOT_SYMBOLS) {
        const p = (weight[a.emoji] * weight[b.emoji] * weight[c.emoji]) / total ** 3;
        let sum = 0;
        for (const u of grid) sum += E.slotsPayout([a.emoji, b.emoji, c.emoji], table, bet, () => u).payout;
        expected += p * (sum / grid.length);
      }
      assert.ok(Math.abs(expected / bet - rtp) < 1e-9, `avantage ${edge} %, mise ${bet} : retour réel ${(expected / bet * 100).toFixed(3)} % ≠ annoncé ${(rtp * 100).toFixed(3)} %`);
    }
  }
  // Le reste n'est tiré qu'en cas de gain fractionnaire (rng non consommé sinon).
  const table = E.slotsTable(5);
  let calls = 0;
  const counting = () => { calls += 1; return 0; };
  assert.equal(E.slotsPayout(['🍋', '🍒', '🔔'], table, 7, counting).payout, 0);
  assert.equal(E.slotsPayout(['🍒', '🍒', '🍒'], table, 100, counting).payout, table[0].tripleCents);
  assert.equal(calls, 0);
  // Mise 1, paire de cerises (×0,94) : 1 pièce avec 94 % de chances, 0 sinon.
  assert.equal(E.slotsPayout(['🍒', '🍒', '🔔'], table, 1, () => 0.93).payout, 1);
  assert.equal(E.slotsPayout(['🍒', '🍒', '🔔'], table, 1, () => 0.95).payout, 0);
  assert.deepEqual(E.centsSplit(7, 94), { low: 6, high: 7, pHigh: 0.58 });
});

test('machine à sous : un gain inférieur à la mise est « Presque remboursé », pas « Perdu »', () => {
  const s = E.settingsOf({});
  const user = { id: ALICE, username: 'alice', displayName: 'Alice', toString: () => `<@${ALICE}>` };
  const table = E.slotsTable(5);
  const base = { reels: ['🍒', '🍒', '🔔'], table, kind: 'pair', symbol: '🍒', cents: 94, bet: 100, capped: false, edge: 5 };
  const partial = text(eco.gameView(s, 'slots', { ...base, payout: 94, balance: 994, delta: -6 }, user, 'pile'));
  assert.match(partial, /Presque remboursé/);
  assert.match(partial, /94 rendus sur 100 misés/);
  assert.doesNotMatch(partial, /Perdu/);
  const lost = text(eco.gameView(s, 'slots', { ...base, kind: null, symbol: null, cents: 0, payout: 0, balance: 900, delta: -100 }, user, 'pile'));
  assert.match(lost, /Perdu/);
});

// ---------------------------------------------------------------- plafond et taxe

test('jeux : un gain au-delà d\'un plafond abaissé ne fait jamais perdre ; une perte reste une perte', () => {
  const { svc, config } = world({ games: { coinflip: true, slots: true, cooldownSeconds: 0 } });
  svc.adminAdjust(GUILD, ALICE, 'set', 5000, CAROL);
  config.update(GUILD, { economy: { limits: { maxBalance: 1000 } } });
  const win = svc.play(GUILD, ALICE, 'coinflip', 100, { choice: 'pile', rng: () => 0 });
  assert.equal(win.won, true);
  assert.deepEqual([win.balance, win.delta, win.capped], [5000, 0, true], 'pile ou face gagné compté comme une perte');
  const jackpot = svc.play(GUILD, ALICE, 'slots', 100, { rng: () => 0.9999 });
  assert.equal(jackpot.kind, 'triple');
  assert.equal(jackpot.delta, 0, '7️⃣7️⃣7️⃣ compté comme une perte');
  const loss = svc.play(GUILD, ALICE, 'coinflip', 100, { choice: 'pile', rng: () => 0.99 });
  assert.deepEqual([loss.won, loss.balance, loss.delta], [false, 4900, -100]);
  // Sous le plafond : un gain est toujours plafonné au solde maximal.
  svc.adminAdjust(GUILD, ALICE, 'set', 950, CAROL);
  const capped = svc.play(GUILD, ALICE, 'coinflip', 100, { choice: 'pile', rng: () => 0 });
  assert.deepEqual([capped.balance, capped.delta], [1000, 50]);
});

test('virements : taxe arrondie au supérieur, plus d\'esquive par petits montants', () => {
  assert.deepEqual(EconomyService.transferSplit(9, 10), { tax: 1, received: 8 });
  assert.deepEqual(EconomyService.transferSplit(99, 1), { tax: 1, received: 98 });
  assert.deepEqual(EconomyService.transferSplit(200, 10), { tax: 20, received: 180 });
  assert.deepEqual(EconomyService.transferSplit(9, 0), { tax: 0, received: 9 });
  const { svc } = world({ transfers: { taxPercent: 10 } });
  svc.adminAdjust(GUILD, ALICE, 'give', 100, CAROL);
  let sent = 0;
  let received = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = svc.transfer(GUILD, ALICE, CAROL, 9);
    sent += r.amount;
    received += r.received;
  }
  assert.ok(sent - received >= sent * 0.1, `taxe esquivée : ${sent} envoyés, ${received} reçus`);
});

// ---------------------------------------------------------------- alertes de mots-clés

test('alertes : les abonnés d\'un mot-clé sont développés une seule fois par message, quelle que soit la répétition', () => {
  const { buildIndex, findMatches } = require('../src/utils/highlights');
  const entries = Array.from({ length: 50 }, (_, i) => ({ userId: String(300000000000000000n + BigInt(i)), words: ['gadget', 'inspecteur gadget'] }));
  const index = buildIndex(entries);
  // Ensembles d'abonnés instrumentés : chaque parcours complet est compté.
  let walks = 0;
  for (const [key, users] of index.words) {
    const counted = new Set(users);
    const iterate = counted[Symbol.iterator].bind(counted);
    counted[Symbol.iterator] = () => { walks += 1; return iterate(); };
    index.words.set(key, counted);
  }
  const hits = findMatches(index, 'inspecteur gadget '.repeat(300));
  assert.equal(hits.size, 50);
  assert.deepEqual([...hits.values()][0], new Set(['inspecteur gadget', 'gadget']));
  assert.equal(walks, 2, `abonnés parcourus ${walks} fois (une fois par occurrence au lieu d'une fois par clé)`);
});

// ---------------------------------------------------------------- rôles attribués automatiquement

test('hasForbiddenPermissions : une permission sensible accordée dans une surcharge de salon suffit à refuser le rôle', () => {
  const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
  const { hasForbiddenPermissions, forbiddenOverwriteChannel, FORBIDDEN_PERMISSIONS } = require('../src/commands/roles/rolemenu');
  const ROLE = '500000000000000001';
  const roleWith = (allow, { guildPerms = 0n, target = ROLE } = {}) => {
    const channel = { id: '600000000000000001', permissionOverwrites: { cache: new Map([[target, { allow: new PermissionsBitField(allow) }]]) } };
    const thread = { id: '600000000000000002' }; // un fil n'a pas de surcharges
    return { id: ROLE, permissions: new PermissionsBitField(guildPerms), guild: { channels: { cache: new Map([[channel.id, channel], [thread.id, thread]]) } } };
  };
  for (const flag of [P.ManageMessages, P.ManageRoles, P.ManageChannels, P.ManageWebhooks, P.MentionEveryone, P.ManageThreads, P.MuteMembers, P.MoveMembers, P.ManageEvents]) {
    assert.ok(FORBIDDEN_PERMISSIONS.includes(flag));
    const role = roleWith(flag);
    assert.equal(hasForbiddenPermissions(role), true, `surcharge ${new PermissionsBitField(flag).toArray()} acceptée`);
    assert.equal(forbiddenOverwriteChannel(role).id, '600000000000000001');
  }
  // Surcharges inoffensives, ou visant un autre rôle : acceptées. Rôle sans serveur connu : permissions seules.
  assert.equal(hasForbiddenPermissions(roleWith(P.ViewChannel | P.SendMessages | P.ReadMessageHistory)), false);
  assert.equal(hasForbiddenPermissions(roleWith(P.ManageMessages, { target: '500000000000000099' })), false);
  assert.equal(hasForbiddenPermissions({ permissions: new PermissionsBitField(P.SendMessages) }), false);
  assert.equal(hasForbiddenPermissions(roleWith(P.SendMessages, { guildPerms: P.BanMembers })), true);
});
