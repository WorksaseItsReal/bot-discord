'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { EconomyRepository } = require('../src/database/repositories/EconomyRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { EconomyService, roleIssue } = require('../src/services/EconomyService');
const E = require('../src/utils/economy');
const eco = require('../src/commands/economy/eco');
const economie = require('../src/commands/economy/economie');
const { defaultGuildConfig } = require('../src/config/defaults');
const { migrations } = require('../src/database/schema');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');
const { CATEGORIES } = require('../src/utils/categories');

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const GUILD = '100000000000000001';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const CAROL = '200000000000000004';
const BOT = '999999999999999999';
const H = 3_600_000;
const T0 = Date.parse('2026-01-10T12:00:00Z');

function world(patch = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new EconomyRepository(db);
  const svc = new EconomyService({ economy: repo, config });
  config.update(GUILD, { economy: { enabled: true, ...patch } });
  return { db, config, repo, svc };
}

/** rng déterministe : renvoie les valeurs données en boucle. */
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

// ---------------------------------------------------------------- schéma et configuration

test('migration 18 : tables, contraintes et index ; bloc de configuration dédié', () => {
  const m = migrations.find((x) => x.id === 18);
  assert.ok(m && m.name === 'economy');
  const { db } = memoryDb();
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['guild_id', 'user_id', 'balance', 'last_daily', 'last_weekly', 'last_work', 'daily_streak', 'updated_at']) assert.ok(cols('economy_accounts').includes(c), c);
  for (const c of ['id', 'guild_id', 'user_id', 'delta', 'balance_after', 'kind', 'ref', 'created_at']) assert.ok(cols('economy_transactions').includes(c), c);
  assert.ok(cols('economy_items').includes('stock'));
  assert.ok(cols('economy_inventory').includes('quantity'));
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_economy%'").all().map((r) => r.name);
  assert.ok(indexes.length >= 5, indexes.join(', '));
  // Dernier rempart : un solde négatif est refusé par SQLite.
  const repo = new EconomyRepository(db);
  repo.ensure(GUILD, ALICE);
  assert.throws(() => repo.setBalance(GUILD, ALICE, -1), /CHECK/);

  const d = defaultGuildConfig.economy;
  assert.equal(d.enabled, false, 'désactivée par défaut');
  assert.equal(d.currency.emoji, '🪙');
  assert.ok(d.games.houseEdgePercent >= 1, 'espérance négative par défaut');
  assert.equal(EVENT_CATEGORY.economy, 'server');
  assert.ok(CATEGORIES.economy);
  assert.equal(eco.category, 'economy');
  assert.equal(economie.category, 'economy');
});

test('settingsOf : valeurs abîmées bornées, minimum de travail ≤ maximum', () => {
  const s = E.settingsOf({ enabled: 'oui', daily: { amount: -5, streakMax: 9999 }, work: { min: 500, max: 10 }, games: { houseEdgePercent: 0, cooldownSeconds: 'x' }, currency: { name: '   ', emoji: '' }, limits: { maxBet: 1e20 } });
  assert.equal(s.enabled, false);
  assert.equal(s.daily.amount, 1);
  assert.equal(s.daily.streakMax, 365);
  assert.equal(s.work.min, 500);
  assert.equal(s.work.max, 500);
  assert.equal(s.games.houseEdgePercent, 1, 'l\'avantage de la maison ne descend jamais sous 1 %');
  assert.equal(s.games.cooldownSeconds, defaultGuildConfig.economy.games.cooldownSeconds);
  assert.equal(s.currency.name, 'pièces');
  assert.equal(s.limits.maxBet, E.HARD_MAX);
  assert.deepEqual(E.settingsOf(undefined).daily, defaultGuildConfig.economy.daily);
});

// ---------------------------------------------------------------- briques pures

test('dailyReward : 24 h entre deux réclamations, série sous 48 h, bonus plafonné', () => {
  const s = E.settingsOf({ daily: { amount: 100, streakBonus: 10, streakMax: 3 } });
  assert.deepEqual(E.dailyReward(s, null, T0), { ready: true, streak: 1, base: 100, bonus: 0, amount: 100 });
  const acc = { last_daily: T0, daily_streak: 1 };
  assert.deepEqual(E.dailyReward(s, acc, T0 + 23 * H), { ready: false, nextAt: T0 + 24 * H });
  assert.equal(E.dailyReward(s, acc, T0 + 30 * H).streak, 2);
  assert.equal(E.dailyReward(s, acc, T0 + 30 * H).amount, 110);
  assert.equal(E.dailyReward(s, { last_daily: T0, daily_streak: 9 }, T0 + 25 * H).bonus, 30, 'bonus plafonné à 3 jours');
  assert.equal(E.dailyReward(s, acc, T0 + 49 * H).streak, 1, 'série rompue après 48 h');
  assert.equal(E.liveStreak(acc, T0 + 47 * H), 1);
  assert.equal(E.liveStreak(acc, T0 + 49 * H), 0);
  assert.equal(E.weeklyNext({ last_weekly: T0 }, T0 + 24 * H), T0 + E.WEEK_MS);
  assert.equal(E.weeklyNext({ last_weekly: T0 }, T0 + E.WEEK_MS), null);
  assert.equal(E.workNext(s, { last_work: T0 }, T0 + 10 * 60_000), T0 + 60 * 60_000);
  assert.equal(E.workNext(s, { last_work: null }, T0), null);
});

test('workOutcome : gain borné, message varié avec {montant}', () => {
  const s = E.settingsOf({ work: { min: 20, max: 80 } });
  assert.equal(E.workOutcome(s, () => 0).amount, 20);
  assert.equal(E.workOutcome(s, () => 0.999999).amount, 80);
  for (let i = 0; i < 200; i += 1) {
    const { amount, template } = E.workOutcome(s);
    assert.ok(amount >= 20 && amount <= 80);
    assert.match(template, /\{montant\}/);
  }
  assert.ok(new Set(E.WORK_MESSAGES).size >= 12, 'messages variés');
});

test('pile ou face : probabilité (1 − avantage) / 2, gain du double, espérance négative', () => {
  const win = E.playCoinflip(10, 'face', 5, () => 0.47);
  assert.deepEqual([win.won, win.side, win.payout], [true, 'face', 20]);
  assert.equal(win.winChance, 0.475);
  const loss = E.playCoinflip(10, 'face', 5, () => 0.475);
  assert.deepEqual([loss.won, loss.side, loss.payout], [false, 'pile', 0]);
  for (const edge of [1, 5, 50]) assert.ok(2 * E.playCoinflip(1, 'pile', edge, () => 1).winChance < 1, `avantage ${edge} %`);
});

test('machine à sous : table mise à l\'échelle, retour exact ≤ 1 − avantage (énumération complète)', () => {
  const weights = Object.fromEntries(E.SLOT_SYMBOLS.map((s) => [s.emoji, s.weight]));
  const total = E.SLOT_SYMBOLS.reduce((n, s) => n + s.weight, 0);
  for (const edge of [1, 2, 5, 10, 25, 50]) {
    const table = E.slotsTable(edge);
    const rtp = E.tableReturn(table);
    assert.ok(rtp <= 1 - edge / 100 + 1e-12, `avantage ${edge} % : retour ${rtp}`);
    assert.ok(rtp >= 1 - edge / 100 - 0.01, `avantage ${edge} % : retour trop faible ${rtp}`);
    // Énumération de tous les tirages : la formule et slotsPayout concordent.
    let expected = 0;
    for (const a of E.SLOT_SYMBOLS) for (const b of E.SLOT_SYMBOLS) for (const c of E.SLOT_SYMBOLS) {
      const p = (weights[a.emoji] * weights[b.emoji] * weights[c.emoji]) / total ** 3;
      expected += p * E.slotsPayout([a.emoji, b.emoji, c.emoji], table, 100).payout;
    }
    assert.ok(Math.abs(expected / 100 - rtp) < 1e-9, `énumération ${expected / 100} ≠ ${rtp}`);
  }
  const table = E.slotsTable(5);
  assert.equal(E.slotsPayout(['🍒', '🍒', '🍒'], table, 100).kind, 'triple');
  assert.equal(E.slotsPayout(['🍋', '🍒', '🍋'], table, 100).symbol, '🍋');
  assert.equal(E.slotsPayout(['🍋', '🍒', '🍒'], table, 100).kind, 'pair');
  assert.equal(E.slotsPayout(['🍋', '🍒', '🔔'], table, 100).payout, 0);
  assert.deepEqual(E.spinSlots(() => 0), ['🍒', '🍒', '🍒']);
  assert.deepEqual(E.spinSlots(() => 0.9999), ['7️⃣', '7️⃣', '7️⃣']);
  // Calcul exact même pour une mise énorme.
  assert.equal(BigInt(E.applyCents(E.HARD_MAX - 1, 14123)), (BigInt(E.HARD_MAX - 1) * 14123n) / 100n);
  assert.equal(E.applyCents(7, 94), 6);
});

test('mise en forme : montants, historique, saisie', () => {
  const s = E.settingsOf({});
  assert.match(E.money(1500, s), /^\*\*1\s500\*\* 🪙$/u);
  assert.equal(E.signed(5), '+5');
  assert.equal(E.signed(-5), '−5');
  assert.equal(E.capCredit(90, 50, 100), 10);
  assert.equal(E.capCredit(120, 50, 100), 0);
  assert.match(E.txLine({ kind: 'transfer_out', delta: -50, ref: BOB, created_at: T0 }), new RegExp(`📤 \\*\\*−50\\*\\* · Virement envoyé · à <@${BOB}>`));
  assert.match(E.txLine({ kind: 'admin', delta: 10, ref: `give:${ALICE}`, created_at: T0 }), /Don par <@/);
  assert.match(E.txLine({ kind: 'buy', delta: -10, ref: '3:Ticket **VIP**', created_at: T0 }), /Achat · Ticket VIP/);
  assert.match(E.txLine({ kind: 'inconnu', delta: 0, ref: null, created_at: T0 }), /Mouvement/);
  assert.doesNotMatch(E.txLine({ kind: 'daily', delta: 1, ref: null, created_at: T0 }), /null|undefined/);
  assert.equal(E.parseAmount('1 500', [1, 10_000]), 1500);
  assert.equal(E.parseAmount('1 500', [1, 10_000]), 1500);
  for (const bad of ['', '-5', '1,5', 'abc', '0', '99999']) assert.equal(E.parseAmount(bad, [1, 10_000]), null, bad);
  assert.equal(economie.parseLabel('  Ticket   VIP ', [1, 50], 'Nom'), 'Ticket VIP');
  assert.throws(() => economie.parseLabel('', [1, 50], 'Nom'), /Nom/);
  assert.throws(() => economie.parseLabel('x'.repeat(51), [1, 50], 'Nom'), /Nom/);
});

// ---------------------------------------------------------------- dépôt

test('dépôt : historique borné, classement, rang, statistiques', () => {
  const { repo } = world();
  repo.ensure(GUILD, ALICE, T0);
  for (let i = 0; i < E.TX_KEEP + 30; i += 1) repo.addTransaction({ guildId: GUILD, userId: ALICE, delta: 1, balanceAfter: i + 1, kind: 'work', now: T0 + i });
  const history = repo.history(GUILD, ALICE, 1000);
  assert.equal(history.length, E.TX_KEEP, 'historique non borné');
  assert.equal(history[0].balance_after, E.TX_KEEP + 30, 'les plus récentes sont conservées');
  repo.setBalance(GUILD, ALICE, 50);
  repo.ensure(GUILD, BOB);
  repo.setBalance(GUILD, BOB, 50);
  repo.ensure(GUILD, CAROL);
  assert.deepEqual(repo.leaderboard(GUILD, 10, 0).map((r) => r.user_id), [ALICE, BOB], 'égalité départagée, soldes nuls exclus');
  assert.equal(repo.rank(GUILD, BOB), 2);
  assert.equal(repo.rank(GUILD, CAROL), null);
  assert.equal(repo.countRanked(GUILD), 2);
  const stats = repo.stats(GUILD, 0);
  assert.equal(stats.supply, 100);
  assert.equal(stats.accounts, 3);
  assert.equal(stats.holders, 2);
  assert.equal(repo.lastOfKind(GUILD, BOB, 'buy').id, 0);
});

test('dépôt : articles, stock, inventaire supprimé en cascade, réinitialisations', () => {
  const { repo } = world();
  const item = repo.insertItem({ guildId: GUILD, name: 'Badge', price: 10, stock: 1 });
  assert.equal(repo.takeStock(GUILD, item.id), true);
  assert.equal(repo.takeStock(GUILD, item.id), false, 'stock négatif');
  repo.restoreStock(GUILD, item.id);
  assert.equal(repo.getItem(GUILD, item.id).stock, 1);
  const unlimited = repo.insertItem({ guildId: GUILD, name: 'Sticker', price: 1 });
  for (let i = 0; i < 5; i += 1) assert.ok(repo.takeStock(GUILD, unlimited.id));
  assert.equal(repo.getItem(GUILD, unlimited.id).stock, null);
  repo.addInventory(GUILD, ALICE, item.id, 1);
  repo.addInventory(GUILD, ALICE, item.id, 2);
  assert.equal(repo.inventory(GUILD, ALICE)[0].quantity, 3);
  assert.deepEqual(repo.owners(item.id), { n: 1, qty: 3 });
  assert.equal(repo.updateItem(GUILD, item.id, { name: 'Badge doré', price: 20, stock: null }).name, 'Badge doré');
  assert.equal(repo.updateItem(GUILD, 9999, { name: 'x', price: 1 }), null);
  assert.ok(repo.deleteItem(GUILD, item.id));
  assert.equal(repo.inventory(GUILD, ALICE).length, 0, 'inventaire non supprimé en cascade');
  repo.ensure(GUILD, ALICE);
  repo.addTransaction({ guildId: GUILD, userId: ALICE, delta: 1, balanceAfter: 1, kind: 'work' });
  repo.addInventory(GUILD, ALICE, unlimited.id, 1);
  assert.equal(repo.deleteMember(GUILD, ALICE), true);
  assert.equal(repo.get(GUILD, ALICE), null);
  assert.equal(repo.history(GUILD, ALICE).length, 0);
  assert.equal(repo.inventory(GUILD, ALICE).length, 0);
  repo.ensure(GUILD, BOB);
  repo.ensure('100000000000000999', BOB);
  assert.equal(repo.deleteGuild(GUILD), 1);
  assert.ok(repo.get('100000000000000999', BOB), 'un autre serveur a été effacé');
  assert.equal(repo.countItems(GUILD), 1, 'la boutique est conservée');
});

// ---------------------------------------------------------------- service

test('service : désactivé → refus ; gains, délais, plafond', () => {
  const { svc, config, repo } = world({ limits: { maxBalance: 250 } });
  config.update(GUILD, { economy: { enabled: false } });
  assert.throws(() => svc.claimDaily(GUILD, ALICE, T0), /pas activée/);
  config.update(GUILD, { economy: { enabled: true } });
  assert.equal(svc.claimDaily(GUILD, ALICE, T0).balance, 100);
  assert.throws(() => svc.claimDaily(GUILD, ALICE, T0 + H), /déjà récupéré/);
  const second = svc.claimDaily(GUILD, ALICE, T0 + 25 * H);
  assert.deepEqual([second.streak, second.bonus, second.balance], [2, 10, 210]);
  const weekly = svc.claimWeekly(GUILD, ALICE, T0 + 25 * H);
  assert.deepEqual([weekly.credited, weekly.capped, weekly.balance], [40, true, 250], 'plafond de solde');
  assert.throws(() => svc.work(GUILD, ALICE, T0 + 26 * H), /plafond/);
  assert.equal(repo.get(GUILD, ALICE).last_work, null, 'refus au plafond : délai non consommé');
  config.update(GUILD, { economy: { limits: { maxBalance: 10_000 } } });
  const w = svc.work(GUILD, ALICE, T0 + 26 * H, () => 0);
  assert.equal(w.credited, 20);
  assert.throws(() => svc.work(GUILD, ALICE, T0 + 26 * H + 59 * 60_000), /fatigué/);
  assert.ok(svc.work(GUILD, ALICE, T0 + 27 * H));
  // L'historique suit chaque gain et reflète le solde.
  const [last] = repo.history(GUILD, ALICE, 1);
  assert.equal(last.kind, 'work');
  assert.equal(last.balance_after, svc.account(GUILD, ALICE).balance);
});

test('service : virements (taxe détruite, refus, atomicité)', () => {
  const { svc, config, repo } = world({ transfers: { taxPercent: 10 }, limits: { maxBalance: 1000 } });
  svc.adminAdjust(GUILD, ALICE, 'give', 500, CAROL, T0);
  assert.throws(() => svc.transfer(GUILD, ALICE, ALICE, 10), /vous-même/);
  assert.throws(() => svc.transfer(GUILD, ALICE, BOB, 0), /entier positif/);
  assert.throws(() => svc.transfer(GUILD, ALICE, BOB, 1.5), /entier positif/);
  assert.throws(() => svc.transfer(GUILD, ALICE, BOB, 501), /Solde insuffisant/);
  const r = svc.transfer(GUILD, ALICE, BOB, 200, T0);
  assert.deepEqual([r.tax, r.received, r.fromBalance, r.toBalance], [20, 180, 300, 180]);
  assert.deepEqual(repo.history(GUILD, BOB, 1).map((t) => [t.kind, t.delta, t.ref]), [['transfer_in', 180, ALICE]]);
  assert.deepEqual(repo.history(GUILD, ALICE, 1).map((t) => [t.kind, t.delta, t.ref]), [['transfer_out', -200, BOB]]);
  // Le destinataire dépasserait le plafond : rien n'est débité.
  svc.adminAdjust(GUILD, BOB, 'set', 950, CAROL);
  assert.throws(() => svc.transfer(GUILD, ALICE, BOB, 100), /plafond/);
  assert.equal(svc.account(GUILD, ALICE).balance, 300);
  // Taxe arrondie à l'inférieur : le destinataire reçoit toujours au moins 1.
  config.update(GUILD, { economy: { transfers: { taxPercent: 50 } } });
  assert.deepEqual(EconomyService.transferSplit(1, 50), { tax: 0, received: 1 });
  assert.equal(svc.transfer(GUILD, ALICE, CAROL, 3).received, 2);
  assert.equal(svc.account(GUILD, ALICE).balance, 297);
});

test('service : achats (jeton anti-double-clic, stock, solde, inventaire, remboursement)', () => {
  const { svc } = world();
  svc.adminAdjust(GUILD, ALICE, 'give', 100, CAROL);
  const badge = svc.addItem(GUILD, { name: 'Badge', price: 30, stock: 2 });
  const role = svc.addItem(GUILD, { name: 'VIP', price: 50, kind: 'role', roleId: '300000000000000001' });
  assert.throws(() => svc.addItem(GUILD, { name: 'VIP bis', price: 5, kind: 'role', roleId: '300000000000000001' }), /déjà en vente/);
  const token = svc.purchaseToken(GUILD, ALICE);
  assert.equal(token, 0);
  const first = svc.buy(GUILD, ALICE, badge.id, token);
  assert.equal(first.balance, 70);
  // Second clic avec le même jeton (double clic) : refusé, rien n'est débité.
  assert.throws(() => svc.buy(GUILD, ALICE, badge.id, token), /double clic/);
  assert.equal(svc.account(GUILD, ALICE).balance, 70);
  const next = svc.purchaseToken(GUILD, ALICE);
  assert.equal(next, first.txId);
  svc.buy(GUILD, ALICE, badge.id, next);
  assert.equal(svc.getItem(GUILD, badge.id).stock, 0);
  assert.throws(() => svc.buy(GUILD, ALICE, badge.id, svc.purchaseToken(GUILD, ALICE)), /rupture/);
  assert.deepEqual(svc.inventory(GUILD, ALICE).map((i) => [i.name, i.quantity]), [['Badge', 2]]);
  assert.throws(() => svc.buy(GUILD, ALICE, role.id, svc.purchaseToken(GUILD, ALICE)), /Solde insuffisant/);
  svc.adminAdjust(GUILD, ALICE, 'give', 100, CAROL);
  const r = svc.buy(GUILD, ALICE, role.id, svc.purchaseToken(GUILD, ALICE));
  assert.equal(svc.inventory(GUILD, ALICE).length, 1, 'un rôle ne va pas dans l\'inventaire');
  assert.equal(svc.refund(GUILD, ALICE, r.item).balance, 140);
  assert.throws(() => svc.buy(GUILD, ALICE, 999, svc.purchaseToken(GUILD, ALICE)), /n'existe plus/);
  for (let i = 0; i < 23; i += 1) svc.addItem(GUILD, { name: `Objet ${i}`, price: 1 });
  assert.throws(() => svc.addItem(GUILD, { name: 'Trop', price: 1 }), /25 articles/);
  assert.equal(svc.deleteItem(GUILD, badge.id).name, 'Badge');
  assert.throws(() => svc.deleteItem(GUILD, badge.id), /n'existe plus/);
});

test('service : jeux (mise plafonnée, délai, solde, désactivation, plafond de gain)', () => {
  const { svc, config } = world({ games: { cooldownSeconds: 10 }, limits: { maxBet: 100, maxBalance: 1000 } });
  svc.adminAdjust(GUILD, ALICE, 'give', 990, CAROL);
  assert.throws(() => svc.play(GUILD, ALICE, 'coinflip', 101), /Mise maximale/);
  assert.throws(() => svc.play(GUILD, ALICE, 'coinflip', 0), /entier positif/);
  const win = svc.play(GUILD, ALICE, 'coinflip', 100, { choice: 'face', now: T0, rng: () => 0 });
  assert.equal(win.side, 'face');
  assert.deepEqual([win.balance, win.capped], [1000, true], 'gain plafonné au solde maximal');
  assert.throws(() => svc.play(GUILD, ALICE, 'slots', 10, { now: T0 + 5000 }), /Doucement/);
  const loss = svc.play(GUILD, ALICE, 'slots', 100, { now: T0 + 10_000, rng: seq(0, 0.5, 0.99) });
  assert.equal(loss.payout, 0);
  assert.equal(loss.balance, 900);
  config.update(GUILD, { economy: { games: { slots: false } } });
  assert.throws(() => svc.play(GUILD, ALICE, 'slots', 10, { now: T0 + 60_000 }), /désactivée/);
  svc.adminAdjust(GUILD, BOB, 'give', 5, CAROL);
  assert.throws(() => svc.play(GUILD, BOB, 'coinflip', 10, { now: T0 }), /Solde insuffisant/);
});

test('service : aucun solde négatif, historique cohérent sur 2 000 opérations aléatoires', () => {
  const { svc, repo } = world({ games: { cooldownSeconds: 0 }, limits: { maxBet: 500, maxBalance: 5000 }, transfers: { taxPercent: 5 } });
  const users = [ALICE, BOB, CAROL];
  const item = svc.addItem(GUILD, { name: 'Objet', price: 40, stock: 30 });
  let rng = 42;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) % 2 ** 31;
    return rng / 2 ** 31;
  };
  let now = T0;
  for (let i = 0; i < 2000; i += 1) {
    now += 7 * 60_000;
    const u = users[Math.floor(rand() * 3)];
    const op = Math.floor(rand() * 6);
    try {
      if (op === 0) svc.claimDaily(GUILD, u, now);
      else if (op === 1) svc.work(GUILD, u, now, rand);
      else if (op === 2) svc.transfer(GUILD, u, users[(users.indexOf(u) + 1) % 3], 1 + Math.floor(rand() * 400), now);
      else if (op === 3) svc.play(GUILD, u, rand() < 0.5 ? 'coinflip' : 'slots', 1 + Math.floor(rand() * 500), { now, rng: rand });
      else if (op === 4) svc.buy(GUILD, u, item.id, rand() < 0.8 ? svc.purchaseToken(GUILD, u) : 123, now);
      else svc.adminAdjust(GUILD, u, rand() < 0.5 ? 'give' : 'take', Math.floor(rand() * 300), CAROL, now);
    } catch (err) {
      assert.ok(err.isUserError, `erreur inattendue : ${err.stack}`);
    }
    for (const id of users) {
      const acc = repo.get(GUILD, id);
      if (!acc) continue;
      assert.ok(acc.balance >= 0 && acc.balance <= 5000, `solde hors bornes : ${acc.balance}`);
      const [last] = repo.history(GUILD, id, 1);
      if (last) assert.equal(last.balance_after, acc.balance, 'historique incohérent');
    }
  }
  assert.ok(svc.getItem(GUILD, item.id).stock >= 0);
  const sold = 30 - svc.getItem(GUILD, item.id).stock;
  const owned = users.reduce((n, id) => n + (svc.inventory(GUILD, id)[0]?.quantity ?? 0), 0);
  assert.equal(owned, sold, 'stock et inventaires désaccordés');
});

test('service : ajustements d\'administration et réinitialisations', () => {
  const { svc } = world({ limits: { maxBalance: 1000 } });
  assert.deepEqual(svc.adminAdjust(GUILD, ALICE, 'give', 1500, CAROL), { before: 0, after: 1000, capped: true });
  assert.deepEqual(svc.adminAdjust(GUILD, ALICE, 'take', 5000, CAROL), { before: 1000, after: 0, capped: true });
  assert.throws(() => svc.adminAdjust(GUILD, ALICE, 'set', 1001, CAROL), /solde maximal/);
  assert.deepEqual(svc.adminAdjust(GUILD, ALICE, 'set', 42, CAROL), { before: 0, after: 42, capped: false });
  assert.throws(() => svc.adminAdjust(GUILD, ALICE, 'steal', 1, CAROL), /inconnue/);
  assert.equal(svc.resetMember(GUILD, ALICE), true);
  assert.equal(svc.resetMember(GUILD, ALICE), false);
  svc.adminAdjust(GUILD, BOB, 'give', 1, CAROL);
  assert.equal(svc.resetGuild(GUILD), 1);
});

// ---------------------------------------------------------------- rôles vendables

function fakeRole(id, position, { perms = 0n, managed = false } = {}) {
  return { id, name: `Rôle ${id.slice(-2)}`, position, managed, permissions: new PermissionsBitField(perms) };
}

function fakeGuild({ botPerms = PermissionsBitField.All, botPosition = 10 } = {}) {
  const roles = new Collection();
  const guild = { id: GUILD, name: 'Gadget', ownerId: ALICE, roles: { cache: roles } };
  guild.members = { me: { permissions: new PermissionsBitField(botPerms), roles: { highest: { position: botPosition } } }, cache: new Collection() };
  roles.set(GUILD, fakeRole(GUILD, 0));
  roles.set('300000000000000001', fakeRole('300000000000000001', 2));
  roles.set('300000000000000002', fakeRole('300000000000000002', 3, { perms: PermissionsBitField.Flags.BanMembers }));
  roles.set('300000000000000003', fakeRole('300000000000000003', 4, { managed: true }));
  roles.set('300000000000000004', fakeRole('300000000000000004', 12));
  return guild;
}

test('roleIssue : rôle vendable (hiérarchie, permissions sensibles, rôle géré, @everyone)', () => {
  const g = fakeGuild();
  assert.equal(roleIssue(g, '300000000000000001'), null);
  assert.match(roleIssue(g, GUILD), /@everyone/);
  assert.match(roleIssue(g, '300000000000000002'), /modération/);
  assert.match(roleIssue(g, '300000000000000003'), /intégration/);
  assert.match(roleIssue(g, '300000000000000004'), /au-dessus/);
  assert.match(roleIssue(g, '300000000000000009'), /n'existe plus/);
  assert.match(roleIssue(fakeGuild({ botPerms: 0n }), '300000000000000001'), /Gérer les rôles/);
});

// ---------------------------------------------------------------- tableaux de bord et vues

function fakeInteraction(client, guild, { perms = PermissionsBitField.All, values, fields = {}, userId = BOB, highest = 5 } = {}) {
  const calls = { update: [], reply: [], modal: [] };
  return {
    calls,
    guild,
    guildId: guild.id,
    user: { id: userId, toString: () => `<@${userId}>` },
    member: { roles: { highest: { position: highest }, cache: new Collection() } },
    memberPermissions: new PermissionsBitField(perms),
    values,
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    update: async (p) => calls.update.push(p),
    reply: async (p) => calls.reply.push(p),
    showModal: async (m) => calls.modal.push(m),
    deferUpdate: async () => {},
    editReply: async (p) => calls.update.push(p),
  };
}

function dashboardWorld() {
  const w = world();
  const guild = fakeGuild();
  guild.emojis = { cache: new Collection() };
  const client = { services: { config: w.config, economy: w.svc, logging: { send: async () => true } }, repositories: { economy: w.repo } };
  return { ...w, guild, client };
}

function assertLimits(view) {
  const rows = (view.components ?? []).map(json);
  assert.ok(rows.length <= 5, `${rows.length} rangées`);
  const ids = rows.flatMap((r) => r.components.map((c) => c.custom_id)).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, `customId en double : ${ids.join(', ')}`);
  for (const id of ids) assert.ok(id.length <= 100, id);
  for (const r of rows) {
    assert.ok(r.components.length <= 5);
    for (const c of r.components) {
      if (c.options) assert.ok(c.options.length <= 25);
      if (c.label) assert.ok(c.label.length <= 80);
    }
  }
  const embeds = view.embeds.map(json);
  const size = JSON.stringify(embeds).length;
  assert.ok(size < 8000, `embed trop long : ${size}`);
  assert.doesNotMatch(JSON.stringify(embeds), /undefined|NaN|\bnull\b|\[object/);
}

test('/economie : chaque vue dans les limites (25 articles aux noms longs), permissions revérifiées', async () => {
  const { client, guild, svc } = dashboardWorld();
  for (let i = 0; i < 24; i += 1) svc.addItem(GUILD, { name: `${'Article très long '.repeat(3).slice(0, 48)}${i}`, description: 'd'.repeat(200), price: E.HARD_MAX - i, stock: i % 2 ? null : 1_000_000 });
  svc.addItem(GUILD, { name: 'Rôle VIP', price: 5, kind: 'role', roleId: '300000000000000001' });
  svc.adminAdjust(GUILD, ALICE, 'give', 5000, BOB);
  const [first] = svc.listItems(GUILD);
  for (const view of ['home', 'gains', 'rules', 'shop', `item:${first.id}`, `confirmDelItem.${first.id}`, 'manage', `member:${ALICE}`, `confirmMember.${ALICE}`, 'confirmResetAll', 'stats']) {
    assertLimits(economie.render(client, guild, view));
  }
  const shop = json(economie.render(client, guild, 'shop').components[1]);
  assert.equal(shop.components[0].disabled, true, 'sélecteur de rôle actif à 25 articles');
  assert.throws(() => economie.render(client, guild, 'item:abc'), /invalide/);
  assert.throws(() => economie.render(client, guild, 'member:../x'), /invalide/);

  // Sans « Gérer le serveur » : chaque handler refuse, rien n'est écrit.
  const denied = fakeInteraction(client, guild, { perms: 0n, values: ['home'], fields: { amount: '5' } });
  for (const [name, handler] of Object.entries(economie.buttons)) {
    await assert.rejects(handler(denied, client, ['give', ALICE]), /permission/i, `${name} accepté sans permission`);
  }
  assert.equal(denied.calls.update.length + denied.calls.modal.length, 0);
});

test('/economie : chaque formulaire tient dans les limites (≤ 5 champs, libellés entiers ≤ 45)', async () => {
  const { client, guild, svc } = dashboardWorld();
  const item = svc.addItem(GUILD, { name: 'Badge', price: 10 });
  const opened = [];
  for (const [name, args, values] of [['currency', []], ['daily', []], ['work', []], ['transfers', []], ['games', []], ['itemadd', []], ['itemedit', [String(item.id)]], ['adjust', ['set', ALICE]], ['itemrole', [], ['300000000000000001']]]) {
    const i = fakeInteraction(client, guild, { values, userId: ALICE });
    await economie.buttons[name](i, client, args);
    assert.equal(i.calls.modal.length, 1, `${name} : formulaire non ouvert`);
    opened.push(json(i.calls.modal[0]));
  }
  for (const modal of opened) {
    assert.ok(modal.title.length <= 45 && modal.custom_id.length <= 100);
    assert.ok(modal.components.length <= 5);
    for (const r of modal.components) {
      const input = r.components[0];
      assert.ok(input.label.length <= 45 && !input.label.endsWith('…'), `libellé tronqué : ${input.label}`);
      if (input.value != null) assert.ok(String(input.value).length <= input.max_length, `${input.custom_id} : valeur > max`);
    }
  }
});

test('/economie : formulaires validés (bornes, emoji du serveur, rôle au-dessus de l\'auteur)', async () => {
  const { client, guild, config, svc } = dashboardWorld();
  const submit = (name, fields, args = []) => economie.buttons[name](fakeInteraction(client, guild, { fields }), client, args);
  await submit('dailysubmit', { daily: '150', bonus: '0', streakMax: '0', weekly: '1 000' });
  assert.deepEqual(config.get(GUILD).economy.daily, { amount: 150, streakBonus: 0, streakMax: 0 });
  assert.equal(config.get(GUILD).economy.weekly.amount, 1000);
  await assert.rejects(submit('dailysubmit', { daily: '0', bonus: '0', streakMax: '0', weekly: '5' }), /Montant quotidien/);
  await assert.rejects(submit('worksubmit', { min: '50', max: '10', cooldown: '5' }), /inférieur ou égal/);
  await assert.rejects(submit('worksubmit', { min: '5', max: '10', cooldown: '0' }), /Délai/);
  await assert.rejects(submit('transferssubmit', { tax: '51', confirm: '0', maxBalance: '1000' }), /Taxe/);
  await assert.rejects(submit('gamessubmit', { maxBet: '10', edge: '0', cooldown: '0' }), /Avantage/);
  await submit('gamessubmit', { maxBet: '10', edge: '20', cooldown: '0' });
  assert.equal(config.get(GUILD).economy.games.houseEdgePercent, 20);
  await assert.rejects(submit('currencysubmit', { name: 'crédits', emoji: '<:coin:123456789012345678>' }), /n'appartient pas/);
  await assert.rejects(submit('currencysubmit', { name: 'crédits', emoji: 'abc' }), /Emoji/);
  await submit('currencysubmit', { name: 'crédits', emoji: '💎' });
  assert.deepEqual(config.get(GUILD).economy.currency, { name: 'crédits', emoji: '💎' });
  // Articles.
  await assert.rejects(submit('itemcreate', { name: 'Badge', price: '0' }, ['0']), /Prix/);
  await assert.rejects(submit('itemcreate', { name: 'Badge', price: '10', stock: 'beaucoup' }, ['0']), /Stock/);
  await submit('itemcreate', { name: 'Badge', price: '10', stock: '', emoji: '🏅' }, ['0']);
  await assert.rejects(submit('itemcreate', { name: 'Ban', price: '10' }, ['300000000000000002']), /modération/);
  // Rôle au niveau de l'auteur (position 5 ≥ 5) refusé ; propriétaire du serveur dispensé.
  guild.roles.cache.set('300000000000000005', fakeRole('300000000000000005', 5));
  await assert.rejects(submit('itemcreate', { name: 'Haut', price: '10' }, ['300000000000000005']), /votre rôle le plus haut/);
  await economie.buttons.itemcreate(fakeInteraction(client, guild, { fields: { name: 'Haut', price: '10' }, userId: ALICE }), client, ['300000000000000005']);
  assert.deepEqual(svc.listItems(GUILD).map((i) => [i.name, i.kind]), [['Badge', 'item'], ['Haut', 'role']]);
  const [badge] = svc.listItems(GUILD);
  await submit('itemupdate', { name: 'Badge doré', price: '20', stock: '3' }, [String(badge.id)]);
  assert.deepEqual([svc.getItem(GUILD, badge.id).name, svc.getItem(GUILD, badge.id).stock], ['Badge doré', 3]);
  await assert.rejects(submit('adjustsubmit', { amount: '-5' }, ['give', ALICE]), /Montant/);
  await assert.rejects(submit('adjustsubmit', { amount: '5' }, ['steal', ALICE]), /invalide/);
  await submit('adjustsubmit', { amount: '5' }, ['give', ALICE]);
  assert.equal(svc.account(GUILD, ALICE).balance, 5);
  await assert.rejects(economie.buttons.game(fakeInteraction(client, guild), client, ['poker', 'on']), /invalide/);
  await assert.rejects(economie.buttons.toggle(fakeInteraction(client, guild), client, ['peut-être']), /invalide/);
});

test('/eco : sous-commandes, vues membres dans les limites (boutique paginée, classement, jeux)', () => {
  const data = eco.data.toJSON();
  assert.deepEqual(data.options.map((o) => o.name), ['solde', 'quotidien', 'hebdo', 'travail', 'payer', 'boutique', 'inventaire', 'classement', 'pile-ou-face', 'machine-a-sous', 'historique']);
  assert.equal(data.default_member_permissions, undefined, '/eco est ouverte aux membres');
  assert.equal(economie.data.toJSON().default_member_permissions, String(PermissionsBitField.Flags.ManageGuild));
  const { client, guild, svc } = dashboardWorld();
  for (let i = 0; i < 25; i += 1) svc.addItem(GUILD, { name: `Objet ${'x'.repeat(45)} ${i}`, description: 'Une description.', price: 10 + i, stock: i === 0 ? 0 : null });
  svc.adminAdjust(GUILD, ALICE, 'give', 12, BOB);
  for (let i = 0; i < 25; i += 1) svc.adminAdjust(GUILD, `2000000000000001${String(i).padStart(2, '0')}`, 'give', 100 + i, BOB);
  const s = svc.settings(GUILD);
  for (const page of [0, 2, 4, 99]) {
    const view = eco.shopView(client, guild, ALICE, page);
    assertLimits(view);
    const buys = json(view.components[0]).components;
    assert.ok(buys.length <= 5 && buys.every((b) => b.custom_id.startsWith('cmd:eco:buy:')));
  }
  const firstPage = json(eco.shopView(client, guild, ALICE, 0).components[0]).components;
  assert.equal(firstPage[0].disabled, true, 'rupture de stock achetable');
  assert.ok(!firstPage[1].disabled, 'article abordable désactivé');
  assert.equal(firstPage[4].disabled, true, 'article trop cher achetable');
  assertLimits(eco.inventoryView(client, guild, ALICE));
  for (const page of [0, 1, 2, 50]) assertLimits(eco.boardView(client, guild, page, ALICE));
  assertLimits(eco.historyView(client, guild, ALICE));
  const user = { id: ALICE, username: 'alice', displayName: 'Alice', toString: () => `<@${ALICE}>` };
  assertLimits({ embeds: eco.balanceView(client, guild, user, null, ALICE).embeds, components: [] });
  const flip = { ...E.playCoinflip(10, 'pile', 5, () => 0), bet: 10, balance: 25, delta: 10, capped: false, edge: 5 };
  assertLimits(eco.gameView(s, 'coinflip', flip, user, 'pile'));
  const slots = { ...E.playSlots(E.HARD_MAX, 5, () => 0.9999), bet: E.HARD_MAX, balance: 0, delta: -5, capped: true, edge: 5 };
  const view = eco.gameView(s, 'slots', slots, user, 'pile');
  assertLimits(view);
  assert.match(JSON.stringify(json(view.embeds[0])), /espérance négative/);
  assert.match(JSON.stringify(json(view.embeds[0])), /sans valeur réelle/);
});
