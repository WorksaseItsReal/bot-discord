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
const { AutomodQuarantineRepository } = require('../src/database/repositories/AutomodQuarantineRepository');
const { GiveawayService } = require('../src/services/GiveawayService');
const { pickWinners, lazyShuffle } = require('../src/utils/random');
const Welcome = require('../src/services/WelcomeService');
const Levels = require('../src/services/LevelService');
const Birthdays = require('../src/services/BirthdayService');
const { safeName, neutralizeMaskedLinks } = require('../src/utils/safeText');

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

// ---------------------------------------------------------------- R77 : quarantaine en cours

test('R77 AutomodQuarantineRepository.hasPendingRoles : quarantaine non levée avec rôles retirés', () => {
  const { db } = memoryDb();
  const repo = new AutomodQuarantineRepository(db);
  const U = '200000000000000009';
  assert.equal(repo.hasPendingRoles(GUILD, U), false);
  const noRoles = repo.add({ guildId: GUILD, userId: U, roles: [] });
  assert.equal(repo.hasPendingRoles(GUILD, U), false, 'quarantaine sans rôle retiré');
  const id = repo.add({ guildId: GUILD, userId: U, roles: ['300000000000000001'] });
  assert.equal(repo.hasPendingRoles(GUILD, U), true);
  assert.equal(repo.hasPendingRoles('100000000000000099', U), false, 'autre serveur');
  repo.lift(GUILD, id, 'mod');
  repo.lift(GUILD, noRoles, 'mod');
  assert.equal(repo.hasPendingRoles(GUILD, U), false, 'quarantaine levée');
});

// ---------------------------------------------------------------- R85 : pseudos en lien masqué

/** Un lien masqué « [texte](url) » est-il encore cliquable ? (crochet ouvrant non échappé suivi de « ](http ») */
const clickable = (text) => /(^|[^\\])\[[^\]]*[^\\]\]\(https?:/.test(String(text));
const EVIL = '[Nitro gratuit](https://dlsc.rd)';

test('R85 safeName / neutralizeMaskedLinks : aucun lien masqué cliquable, même plusieurs ou précédés d\'une barre oblique', () => {
  for (const raw of [EVIL, `${EVIL} et [b](https://x.y)`, `\\${EVIL}`, `**${EVIL}**`]) {
    assert.ok(!clickable(safeName(raw)), `safeName : ${safeName(raw)}`);
    assert.ok(!clickable(neutralizeMaskedLinks(raw)), `neutralize : ${neutralizeMaskedLinks(raw)}`);
  }
  assert.equal(safeName('Jean_Dupont'), 'Jean\\_Dupont');
  assert.equal(neutralizeMaskedLinks('**gras**'), '**gras**', 'le Markdown hors liens est conservé');
});

test('R85 cartes publiques : départ / arrivée, niveau, anniversaire ne rendent jamais un pseudo en lien masqué', () => {
  const vars = { id: null, name: EVIL, server: EVIL, count: 3, age: '1 an' };
  assert.ok(!clickable(Welcome.renderTemplate('**{pseudo}** a quitté {serveur} ({membre})', vars)), Welcome.renderTemplate('**{pseudo}** a quitté {serveur} ({membre})', vars));
  const lvl = Levels.renderTemplate('Bravo {pseudo} ({membre}) sur {serveur} : niveau {niveau}', { member: '<@1>', level: 3, name: EVIL, server: EVIL });
  assert.ok(!clickable(lvl), lvl);
  assert.equal(Levels.renderTemplate('{pseudo}', { name: 'a$&b' }), 'a$&b', 'motif de remplacement interprété');
  const bday = Birthdays.renderBirthday('Joyeux anniversaire {pseudo} {membre} sur {serveur}', { id: null, name: EVIL, server: EVIL, age: null });
  assert.ok(!clickable(bday), bday);
});

// ---------------------------------------------------------------- R82 : double reroll

function giveawayWorld() {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const sent = [];
  const message = { id: 'm1', embeds: [], url: 'https://discord.com/channels/1/2/3', edit: async () => message };
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); return message; }, messages: { fetch: async () => message } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async (uid) => ({ id: uid, bot: false }) }, guilds: { cache: new Map() }, repositories: {} };
  const service = new GiveawayService({ client, giveaways: repo });
  return { db, repo, service, sent };
}

test('R82 reroll : double clic ou deux organisateurs → un seul nouveau tirage, le second est refusé', async () => {
  const { repo, service, sent } = giveawayWorld();
  const id = repo.create({ guildId: GUILD, channelId: 'c', messageId: 'm1', prize: 'Nitro', winners: 1, hostId: 'h', requiredRole: null, forbiddenRole: null, endsAt: Date.now() - 1 });
  for (let i = 0; i < 10; i += 1) repo.addEntry(id, String(200000000000000000n + BigInt(i)));
  await service.end(id, { guildId: GUILD });
  const before = sent.length;
  const results = await Promise.allSettled([
    service.end(id, { reroll: true, guildId: GUILD }),
    service.end(id, { reroll: true, guildId: GUILD }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'deux tirages');
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /vient d'être fait|patientez/i);
  assert.equal(sent.length - before, 1, 'deux annonces de gagnants (deux pings)');
  assert.equal(repo.winners(id).length, 2, 'gagnants mémorisés : premier tirage + un reroll');
});
