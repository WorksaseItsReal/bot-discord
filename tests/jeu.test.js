'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { GameScoreRepository, GAME_KEYS, normalizeEntry } = require('../src/database/repositories/GameScoreRepository');
const { GameService, GAME_ID } = require('../src/services/GameService');
const T = require('../src/utils/games/morpion');
const P4 = require('../src/utils/games/puissance4');
const H = require('../src/utils/games/pendu');
const Q = require('../src/utils/games/quiz');
const D = require('../src/utils/games/devine');
const jeu = require('../src/commands/fun/jeu');
const { isSafeArg } = require('../src/components/cmd');

const GUILD = '100000000000000001';
const ALICE = '200000000000000002';
const BOB = '200000000000000003';
const CAROL = '200000000000000004';
const BOT = '999999999999999999';
const CHAN = '400000000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

/** Générateur déterministe (tests reproductibles). */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ======================================================================== base

test('migration 24 : table game_scores (clé serveur + jeu + membre), ajoutée à son id', () => {
  const m = migrations.find((x) => x.id === 24);
  assert.ok(m && /CREATE TABLE IF NOT EXISTS game_scores/.test(m.up));
  const { db } = memoryDb();
  const cols = db.prepare('PRAGMA table_info(game_scores)').all().map((c) => c.name);
  for (const c of ['guild_id', 'user_id', 'game', 'wins', 'losses', 'draws', 'points']) assert.ok(cols.includes(c), c);
  assert.ok(db.prepare('SELECT 1 FROM _migrations WHERE id = 24').get());
});

test('GameScoreRepository : cumul, classement par jeu et global, rang, entrées invalides ignorées', () => {
  const { db } = memoryDb();
  const repo = new GameScoreRepository(db);
  assert.equal(repo.record([
    { guildId: GUILD, userId: ALICE, game: 'morpion', outcome: 'win', points: 3 },
    { guildId: GUILD, userId: BOB, game: 'morpion', outcome: 'loss', points: 0 },
    { guildId: GUILD, userId: ALICE, game: 'morpion', outcome: 'draw', points: 1 },
    { guildId: GUILD, userId: BOB, game: 'quiz', outcome: 'win', points: 7 },
    { guildId: GUILD, userId: CAROL, game: 'devine', outcome: 'win', points: 4 },
    // ignorées : jeu inconnu, issue inconnue, identifiants invalides
    { guildId: GUILD, userId: ALICE, game: 'echecs', outcome: 'win', points: 3 },
    { guildId: GUILD, userId: ALICE, game: 'morpion', outcome: 'victoire', points: 3 },
    { guildId: 'x', userId: ALICE, game: 'morpion', outcome: 'win' },
    null,
  ]), 5);
  const alice = repo.get(GUILD, ALICE, 'morpion');
  assert.deepEqual([alice.wins, alice.draws, alice.losses, alice.points], [1, 1, 0, 4]);
  assert.deepEqual(repo.leaderboard(GUILD, 'morpion').map((r) => r.user_id), [ALICE, BOB]);
  assert.deepEqual(repo.leaderboard(GUILD).map((r) => [r.user_id, r.points]), [[BOB, 7], [ALICE, 4], [CAROL, 4]]);
  assert.equal(repo.count(GUILD), 3);
  assert.equal(repo.count(GUILD, 'morpion'), 2);
  assert.equal(repo.rank(GUILD, BOB), 1);
  assert.equal(repo.rank(GUILD, ALICE), 2, 'à points égaux, plus de victoires… puis identifiant');
  assert.equal(repo.rank(GUILD, BOB, 'morpion'), 2);
  assert.equal(repo.rank(GUILD, CAROL, 'morpion'), null);
  assert.equal(repo.get(GUILD, ALICE).points, 4, 'total tous jeux');
  assert.equal(repo.count('100000000000000009'), 0);
  // Points bornés, jamais négatifs.
  assert.equal(normalizeEntry({ guildId: GUILD, userId: ALICE, game: 'quiz', outcome: 'win', points: -5 }).points, 0);
  assert.equal(normalizeEntry({ guildId: GUILD, userId: ALICE, game: 'quiz', outcome: 'win', points: 1e9 }).points, 1000);
  assert.deepEqual([...GAME_KEYS], Object.keys(jeu.GAMES));
});

// ======================================================================== morpion

test('morpion : victoire en ligne, colonne et diagonale ; nul ; grille en cours', () => {
  const { X, O, EMPTY: _ } = T;
  assert.deepEqual(T.winnerOf([X, X, X, O, O, _, _, _, _]), { mark: X, line: [0, 1, 2] });
  assert.deepEqual(T.winnerOf([O, X, X, O, X, _, O, _, _]).line, [0, 3, 6]);
  assert.deepEqual(T.winnerOf([X, O, _, O, X, _, _, _, X]).line, [0, 4, 8]);
  assert.deepEqual(T.winnerOf([X, X, O, _, O, _, O, X, _]).line, [2, 4, 6]);
  assert.deepEqual(T.outcomeOf([X, O, X, X, O, O, O, X, X]), { type: 'draw' });
  assert.equal(T.outcomeOf([X, _, _, _, _, _, _, _, _]), null);
  assert.equal(T.bestMove([X, X, X, O, O, _, _, _, _], O), -1, 'partie finie');
});

test('morpion : l\'IA gagne dès que possible et bloque toujours', () => {
  const { X, O, EMPTY: _ } = T;
  assert.equal(T.bestMove([O, O, _, X, X, _, _, _, _], O), 2, 'gagne plutôt que bloquer');
  assert.equal(T.bestMove([X, X, _, O, _, _, _, _, _], O), 2, 'bloque la ligne');
  assert.equal(T.bestMove([X, _, _, _, O, _, _, _, X], O) % 2, 1, 'parade du double coin : un bord');
});

test('morpion : l\'IA minimax est imbattable (toutes les parties possibles, qu\'elle commence ou non)', () => {
  let games = 0;
  const explore = (board, toMove, ai) => {
    const o = T.outcomeOf(board);
    if (o) {
      games += 1;
      assert.ok(o.type === 'draw' || o.mark === ai, `l'IA a perdu : ${board.join('')}`);
      return;
    }
    if (toMove === ai) {
      const cell = T.bestMove(board, ai, () => 0);
      const next = [...board];
      next[cell] = ai;
      explore(next, T.other(ai), ai);
      return;
    }
    for (const cell of T.freeCells(board)) {
      const next = [...board];
      next[cell] = toMove;
      explore(next, ai, ai);
    }
  };
  explore(T.newBoard(), T.X, T.O); // l'humain commence
  explore(T.newBoard(), T.X, T.X); // l'IA commence
  assert.ok(games > 500, `${games} parties jouées`);
});

// ======================================================================== puissance 4

test('puissance 4 : chute des jetons, colonne pleine, victoires dans les 4 directions', () => {
  const { RED: R, YELLOW: Y } = P4;
  const b = P4.newBoard();
  assert.equal(P4.drop(b, 0, R), 5);
  assert.equal(P4.drop(b, 0, Y), 4);
  for (let i = 0; i < 4; i += 1) P4.drop(b, 0, R);
  assert.equal(P4.drop(b, 0, Y), -1, 'colonne pleine');
  assert.ok(!P4.canPlay(b, 0) && P4.canPlay(b, 1) && !P4.canPlay(b, 7) && !P4.canPlay(b, -1) && !P4.canPlay(b, 1.5));
  assert.deepEqual(P4.playableColumns(b), [1, 2, 3, 4, 5, 6]);
  // Colonne : jetons 2 à 5 de la colonne 0 (rouges) → 4 alignés.
  assert.deepEqual(P4.lineThrough(b, 3, 0), [0, 7, 14, 21].map((i) => i + 0));

  const h = P4.newBoard();
  for (const c of [1, 2, 3, 4]) P4.drop(h, c, Y);
  assert.deepEqual(P4.lineThrough(h, 5, 3), [36, 37, 38, 39]);
  assert.equal(P4.winnerOf(h).mark, Y);

  // Diagonale montante (↗) et descendante (↘).
  const d = P4.newBoard();
  const fill = (board, col, n) => { for (let i = 0; i < n; i += 1) P4.drop(board, col, Y); };
  fill(d, 1, 1); fill(d, 2, 2); fill(d, 3, 3);
  for (const c of [0, 1, 2, 3]) P4.drop(d, c, R);
  assert.equal(P4.winnerOf(d).mark, R);
  assert.equal(P4.winnerOf(d).cells.length, 4);
  const e = P4.newBoard();
  fill(e, 0, 3); fill(e, 1, 2); fill(e, 2, 1);
  for (const c of [0, 1, 2, 3]) P4.drop(e, c, R);
  assert.equal(P4.winnerOf(e).mark, R);
  assert.equal(P4.winnerOf(P4.newBoard()), null);

  // Grille pleine sans alignement : nul.
  const full = [];
  for (let r = 0; r < 6; r += 1) for (let c = 0; c < 7; c += 1) full.push(((Math.floor(c / 2) + r) % 2) ? R : Y);
  assert.ok(P4.isFull(full));
  assert.equal(P4.winnerOf(full), null);
  assert.equal(P4.aiMove(full, R), -1);
});

test('puissance 4 : IA — gagne si possible, sinon bloque, n\'offre pas la victoire, préfère le centre', () => {
  const { RED: R, YELLOW: Y } = P4;
  const win = P4.newBoard();
  for (const c of [0, 1, 2]) P4.drop(win, c, R);
  for (const c of [0, 1, 2]) P4.drop(win, c, Y);
  assert.equal(P4.aiMove(win, R), 3, 'gagne');
  assert.equal(P4.aiMove(win, Y), 3, 'gagne aussi (rangée du dessus) ou bloque');
  const block = P4.newBoard();
  for (const c of [4, 5, 6]) P4.drop(block, c, Y);
  assert.equal(P4.aiMove(block, R), 3, 'bloque');
  assert.equal(P4.aiMove(P4.newBoard(), R), 3, 'centre');
  // Le centre offrirait une victoire immédiate juste au-dessus (rangée 4) : l'IA l'évite.
  const trap = P4.newBoard();
  const put = (r, c, mark) => { trap[r * P4.COLS + c] = mark; };
  put(5, 0, R); put(5, 1, Y); put(5, 2, R);
  put(4, 0, Y); put(4, 1, Y); put(4, 2, Y);
  const move = P4.aiMove(trap, R, () => 0);
  assert.notEqual(move, 3, 'jouer au centre offrirait la victoire');
  assert.ok([2, 4].includes(move), `colonne proche du centre attendue (${move})`);
  // Partie IA contre IA : toujours une issue valide (victoire ou grille pleine).
  for (let seed = 1; seed <= 20; seed += 1) {
    const rng = seeded(seed);
    const b = P4.newBoard();
    let mark = R;
    let last = null;
    while (!P4.isFull(b)) {
      const col = P4.aiMove(b, mark, rng);
      assert.ok(P4.canPlay(b, col));
      last = { col, row: P4.drop(b, col, mark) };
      if (P4.lineThrough(b, last.row, last.col)) break;
      mark = P4.other(mark);
    }
    assert.ok(P4.isFull(b) || P4.winnerOf(b));
  }
});

// ======================================================================== pendu

test('pendu : au moins 300 mots courants, uniques, une lettre A-Z par caractère après normalisation', () => {
  assert.ok(H.WORDS.length >= 300, `${H.WORDS.length} mots`);
  assert.equal(new Set(H.WORDS).size, H.WORDS.length, 'doublons');
  for (const w of H.WORDS) {
    const p = H.prepareWord(w);
    assert.match(p.plain, /^[A-Z]{4,14}$/, w);
    assert.equal([...p.display].length, p.plain.length, w);
  }
  assert.equal(H.normalizeWord('Éléphant'), 'ELEPHANT');
  assert.equal(H.normalizeWord('garçon'), 'GARCON');
  assert.deepEqual(H.FIRST_HALF.join(''), 'ABCDEFGHIJKLM');
  assert.deepEqual(H.SECOND_HALF.join(''), 'NOPQRSTUVWXYZ');
});

test('pendu : masque (accents conservés à l\'affichage), erreurs, victoire, dessin, points', () => {
  const word = H.prepareWord('éléphant');
  assert.equal(H.maskWord(word, new Set()), '_ _ _ _ _ _ _ _');
  assert.equal(H.maskWord(word, new Set(['E', 'A'])), 'É _ É _ _ A _ _', '« E » révèle les É');
  assert.equal(H.errorCount(word, new Set(['E', 'Z', 'K'])), 2);
  assert.ok(!H.isSolved(word, new Set(['E', 'L', 'P', 'H', 'A', 'N'])));
  assert.ok(H.isSolved(word, new Set(['E', 'L', 'P', 'H', 'A', 'N', 'T'])));
  assert.equal(H.DRAWINGS.length, H.MAX_ERRORS + 1);
  assert.equal(H.MAX_ERRORS, 6);
  assert.notEqual(H.drawing(0), H.drawing(6));
  assert.equal(H.drawing(99), H.drawing(6));
  assert.equal(H.winPoints(0), 7);
  assert.equal(H.winPoints(5), 2);
  assert.ok(H.isLetter('A') && !H.isLetter('a') && !H.isLetter('AB') && !H.isLetter('É'));
  const w = H.randomWord(() => 0);
  assert.equal(w.plain, H.normalizeWord(H.WORDS[0]));
});

// ======================================================================== quiz

test('quiz : au moins 120 questions, 5 thèmes, 4 choix distincts dont une seule bonne réponse', () => {
  assert.ok(Q.QUESTIONS.length >= 120, `${Q.QUESTIONS.length} questions`);
  const perTheme = {};
  for (const x of Q.QUESTIONS) {
    assert.ok(Object.hasOwn(Q.THEMES, x.theme), x.q);
    perTheme[x.theme] = (perTheme[x.theme] ?? 0) + 1;
    assert.equal(x.w.length, 3, x.q);
    const all = [x.a, ...x.w];
    assert.equal(new Set(all.map((s) => s.toLowerCase())).size, 4, `choix en double : ${x.q}`);
    for (const c of all) assert.ok(c.length >= 1 && c.length <= 80, `choix trop long : ${c}`);
    assert.ok(x.q.endsWith('?'), x.q);
    assert.ok(x.q.length <= 200);
  }
  assert.deepEqual(Object.keys(perTheme).sort(), Object.keys(Q.THEMES).sort());
  for (const [theme, n] of Object.entries(perTheme)) assert.ok(n >= 20, `${theme} : ${n}`);
  assert.equal(new Set(Q.QUESTIONS.map((x) => x.q)).size, Q.QUESTIONS.length, 'question en double');
});

test('quiz : quelques réponses vérifiées (exactitude du contenu embarqué)', () => {
  const answer = (start) => Q.QUESTIONS.find((x) => x.q.startsWith(start))?.a;
  assert.equal(answer('Quelle est la capitale de l\'Australie'), 'Canberra');
  assert.equal(answer('Combien d\'os compte le squelette'), '206');
  assert.equal(answer('Quel est le symbole chimique de l\'or'), 'Au');
  assert.equal(answer('En quelle année a eu lieu la prise de la Bastille'), '1789');
  assert.equal(answer('Combien de cartes compte un jeu de tarot'), '78');
  assert.equal(answer('En quelle année est sortie la console Nintendo Switch'), '2017');
  assert.equal(answer('Combien de planètes compte le système solaire'), '8');
  assert.equal(answer('Quel est le plus long fleuve de France'), 'La Loire');
});

test('quiz : tirage sans doublon par thème, choix mélangés, manches bornées, classement final', () => {
  const qs = Q.drawQuestions('geographie', 10, seeded(3));
  assert.equal(qs.length, 10);
  assert.equal(new Set(qs.map((x) => x.q)).size, 10);
  for (const x of qs) {
    assert.equal(x.theme, 'geographie');
    assert.equal(x.choices.length, 4);
    const src = Q.QUESTIONS.find((s) => s.q === x.q);
    assert.equal(x.choices[x.answer], src.a);
  }
  assert.equal(Q.drawQuestions(null, 3).length, 3);
  assert.equal(Q.drawQuestions('inconnu', 2).length, 2, 'thème inconnu : tous les thèmes');
  assert.equal(Q.clampRounds(0), 1);
  assert.equal(Q.clampRounds(99), 10);
  assert.equal(Q.clampRounds('abc'), Q.DEFAULT_ROUNDS);
  const ranking = Q.finalRanking(new Map([[ALICE, 3], [BOB, 1], [CAROL, 0]]));
  assert.deepEqual(ranking.map((r) => [r.userId, r.outcome]), [[ALICE, 'win'], [BOB, 'loss'], [CAROL, 'loss']]);
  assert.deepEqual(Q.finalRanking({ a: 2, b: 2 }).map((r) => r.outcome), ['draw', 'draw']);
  assert.deepEqual(Q.finalRanking(new Map([[ALICE, 0]])).map((r) => r.outcome), ['loss'], 'zéro point : pas de victoire');
  assert.deepEqual(Q.finalRanking(new Map()), []);
});

// ======================================================================== devine

test('devine : saisie, plus/moins, intervalle, points', () => {
  assert.equal(D.parseGuess(' 42 '), 42);
  assert.equal(D.parseGuess('100'), 100);
  for (const bad of ['0', '101', '-3', '4.5', 'abc', '', '1e2', '1000']) assert.equal(D.parseGuess(bad), null, bad);
  assert.equal(D.compare(42, 50), -1);
  assert.equal(D.compare(42, 10), 1);
  assert.equal(D.compare(42, 42), 0);
  assert.deepEqual(D.range(42, [50, 25, 40]), [41, 49]);
  assert.deepEqual(D.range(42, []), [1, 100]);
  assert.equal(D.winPoints(1), 10);
  assert.equal(D.winPoints(7), 4);
  assert.equal(D.winPoints(30), 1);
  for (let i = 0; i < 50; i += 1) {
    const n = D.secretNumber();
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 100);
  }
});

// ======================================================================== service

function service(opts = {}) {
  const { db } = memoryDb();
  const scores = new GameScoreRepository(db);
  return { scores, games: new GameService({ client: { user: { id: BOT } }, scores, ...opts }) };
}
const newGame = (games, extra = {}) => games.create({ type: 'devine', guildId: GUILD, channelId: CHAN, ownerId: ALICE, locks: [`devine:u:${ALICE}`], state: {}, ...extra });

test('GameService : verrous, identifiants sûrs, fin de partie, suppression du message ou du salon', () => {
  const { games } = service();
  const g = newGame(games);
  assert.match(g.id, GAME_ID);
  assert.ok(isSafeArg(g.id));
  assert.equal(games.get(g.id), g);
  assert.equal(games.get('../x'), null);
  assert.equal(games.get('constructor'), null);
  assert.equal(games.holder(`devine:u:${ALICE}`), g);
  assert.throws(() => newGame(games), /déjà en cours/);
  const other = newGame(games, { ownerId: BOB, locks: [`devine:u:${BOB}`] });
  assert.equal(games.count(GUILD), 2);
  assert.ok(games.sweeper, 'nettoyage démarré avec la première partie');
  assert.ok(games.end(g));
  assert.ok(!games.end(g), 'idempotent');
  assert.equal(games.holder(`devine:u:${ALICE}`), null);
  assert.equal(g.status, 'over');
  // Message supprimé → partie arrêtée.
  games.setMessage(other, '500000000000000001');
  assert.ok(games.endByMessage('500000000000000001'));
  assert.equal(games.get(other.id), null);
  assert.equal(games.sweeper, null, 'plus de partie : nettoyage arrêté');
  // Salon supprimé.
  newGame(games);
  newGame(games, { ownerId: BOB, locks: [`devine:u:${BOB}`], channelId: '400000000000000002' });
  assert.equal(games.endByChannel(CHAN), 1);
  assert.equal(games.count(), 1);
  games.stop();
});

test('GameService : Map bornée (total et par serveur), refus pendant l\'arrêt', () => {
  const { games } = service({ maxGames: 3, maxPerGuild: 2 });
  newGame(games, { locks: [] });
  newGame(games, { locks: [] });
  assert.throws(() => newGame(games, { locks: [] }), /sur ce serveur/);
  newGame(games, { guildId: '100000000000000002', locks: [] });
  assert.throws(() => newGame(games, { guildId: '100000000000000003', locks: [] }), /Trop de parties/);
  games.stop();
  assert.equal(games.count(), 0);
  assert.throws(() => newGame(games), /redémarre/);
});

test('GameService : expiration après inactivité (nettoyage et accès), carte désactivée via la dernière interaction', async () => {
  const { games } = service({ ttlMs: 30 });
  const edits = [];
  const view = (game) => ({ embeds: [], status: game.status });
  const a = newGame(games, { view });
  const b = newGame(games, { ownerId: BOB, locks: [`devine:u:${BOB}`], view });
  games.touch(a, { message: { id: '500000000000000009' }, editReply: async (p) => edits.push(['a', p.status]) });
  games.touch(b, { editReply: async (p) => edits.push(['b', p.status]) });
  assert.equal(a.messageId, '500000000000000009');
  assert.equal(games.sweep(), 0, 'parties encore actives');
  await sleep(50);
  // Accès direct à une partie inactive : terminée, sans édition (le clic désactive lui-même la carte).
  assert.equal(games.get(a.id), null);
  assert.equal(a.status, 'expired');
  assert.equal(games.sweep(), 1);
  await sleep(5);
  assert.deepEqual(edits, [['b', 'expired']]);
  assert.equal(games.count(), 0);
  // Édition qui échoue : jamais d'exception.
  const c = newGame(games, { view });
  games.touch(c, { editReply: async () => { throw new Error('Unknown Message'); } });
  assert.equal(await games.edit(c, {}), false);
  games.stop();
});

test('GameService : minuteurs nommés unref, remplacés, annulés à la fin et à l\'arrêt', async () => {
  const { games } = service();
  const g = newGame(games);
  const fired = [];
  games.timer(g, 'q', 10, () => fired.push('premier'));
  games.timer(g, 'q', 20, () => fired.push('second'));
  assert.equal(g.timers.size, 1);
  assert.equal(g.timers.get('q').hasRef(), false, 'minuteur unref');
  assert.equal(games.sweeper.hasRef(), false, 'nettoyage unref');
  await sleep(40);
  assert.deepEqual(fired, ['second']);
  games.timer(g, 'q', 10, () => fired.push('annulé'));
  games.end(g);
  const h = newGame(games);
  games.timer(h, 'x', 10, () => fired.push('après arrêt'));
  games.stop();
  await sleep(30);
  assert.deepEqual(fired, ['second']);
  assert.equal(games.sweeper, null);
});

test('GameService : scores — le bot n\'est jamais classé, une erreur de base ne casse rien', () => {
  const { games, scores } = service();
  games.record([
    { guildId: GUILD, userId: ALICE, game: 'morpion', outcome: 'loss', points: 0 },
    { guildId: GUILD, userId: BOT, game: 'morpion', outcome: 'win', points: 3 },
  ]);
  assert.equal(scores.count(GUILD), 1);
  const broken = new GameService({ client: { user: { id: BOT } }, scores: { record: () => { throw new Error('base fermée'); } } });
  assert.equal(broken.record([{ guildId: GUILD, userId: ALICE, game: 'quiz', outcome: 'win' }]), 0);
});

test('arrêt du bot : les mini-jeux sont arrêtés avant la fermeture de la base', async () => {
  const { GadgetClient } = require('../src/core/GadgetClient');
  const client = new GadgetClient();
  const order = [];
  client.services = { games: { stop: () => order.push('games') }, scheduler: { stop: async () => order.push('scheduler') } };
  client.destroy = async () => order.push('destroy');
  client.database = { close: () => order.push('db') };
  await client.shutdown();
  assert.ok(order.indexOf('games') >= 0 && order.indexOf('games') < order.indexOf('db'), order.join(' → '));
});

// ======================================================================== rendu

/** Vérifie les limites Discord d'un rendu et renvoie ses customId. */
function checkPayload(payload) {
  const rows = (payload.components ?? []).map(json);
  assert.ok(rows.length <= 5, `${rows.length} rangées`);
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length >= 1 && r.components.length <= 5);
    for (const c of r.components) {
      if (c.custom_id) ids.push(c.custom_id);
      if (c.options) {
        assert.ok(c.options.length >= 1 && c.options.length <= 25);
        assert.equal(new Set(c.options.map((o) => o.value)).size, c.options.length);
      }
      if (c.label) assert.ok(c.label.length <= 80);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'customId en double');
  for (const id of ids) {
    assert.ok(id.length <= 100, id);
    const [prefix, command, action, ...args] = id.split(':');
    assert.equal(prefix, 'cmd');
    if (command === '_') continue;
    assert.equal(command, 'jeu');
    assert.equal(typeof jeu.buttons[action], 'function', `handler manquant : ${action}`);
    assert.ok(args.every(isSafeArg), id);
  }
  const embed = json(payload.embeds[0]);
  const total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total < 6000);
  assert.doesNotMatch(JSON.stringify(payload.embeds.map(json)), /undefined|NaN|\bnull\b/);
  return ids;
}

const baseGame = (type, extra = {}) => ({ id: 'abcd1234', type, guildId: GUILD, channelId: CHAN, ownerId: ALICE, players: [ALICE, BOB], status: 'playing', result: null, ...extra });

test('rendu : chaque jeu, à chaque étape, respecte les limites Discord et route vers un handler', () => {
  const states = [];
  states.push(baseGame('morpion', { status: 'pending', state: { inviteUntil: Date.now() + 60_000, botId: BOT } }));
  states.push(baseGame('morpion', { status: 'over', result: { type: 'declined' }, state: { botId: BOT } }));
  states.push(baseGame('morpion', { state: { botId: BOT, marks: { [ALICE]: T.X, [BOB]: T.O }, turn: ALICE, board: [1, 2, 0, 0, 1, 0, 0, 0, 2] } }));
  states.push(baseGame('morpion', { status: 'over', result: { type: 'win', winner: ALICE, line: [0, 4, 8] }, state: { botId: BOT, marks: { [ALICE]: T.X, [BOB]: T.O }, turn: BOB, board: [1, 2, 0, 0, 1, 2, 0, 0, 1] } }));
  const p4 = P4.newBoard();
  for (let i = 0; i < 6; i += 1) P4.drop(p4, 0, (i % 2) + 1);
  states.push(baseGame('puissance4', { state: { botId: BOT, marks: { [ALICE]: P4.RED, [BOB]: P4.YELLOW }, turn: ALICE, board: p4, last: { col: 0, row: 0, mark: 2 } } }));
  states.push(baseGame('puissance4', { status: 'expired', state: { botId: BOT, marks: { [ALICE]: P4.RED, [BOB]: P4.YELLOW }, turn: ALICE, board: p4 } }));
  const word = H.prepareWord('anticonstitutionnellement'.slice(0, 14));
  states.push(baseGame('pendu', { players: [ALICE], state: { mode: 'solo', word, guessed: new Set(H.FIRST_HALF), notice: null } }));
  states.push(baseGame('pendu', { players: [ALICE], state: { mode: 'salon', word, guessed: new Set(['Z']), notice: 'x' } }));
  states.push(baseGame('pendu', { players: [ALICE], status: 'over', result: { type: 'loss' }, state: { mode: 'solo', word, guessed: new Set(['Q', 'W', 'X', 'Y', 'K', 'J']), notice: null } }));
  const questions = Q.drawQuestions(null, 10);
  states.push(baseGame('quiz', { players: [ALICE], state: { theme: null, questions, index: 9, scores: new Map([[ALICE, 2]]), answered: new Set([BOB]), history: [], notice: null, deadline: Date.now() } }));
  const many = new Map(Array.from({ length: 40 }, (_, i) => [String(BigInt(ALICE) + BigInt(i)), i % 5]));
  states.push(baseGame('quiz', { players: [ALICE], status: 'over', result: { type: 'done' }, state: { theme: 'sciences', questions, index: 10, scores: many, answered: new Set(), history: questions.map((x) => ({ answer: x.choices[x.answer], winner: ALICE })), notice: 'fin', deadline: 0 } }));
  states.push(baseGame('devine', { players: [ALICE], state: { secret: 42, guesses: Array.from({ length: 60 }, (_, i) => (i % 100) + 1), notice: null } }));
  states.push(baseGame('devine', { players: [ALICE], status: 'over', result: { type: 'win', points: 9 }, state: { secret: 42, guesses: [50, 42], notice: '🎯' } }));
  for (const game of states) checkPayload(jeu.render(game));

  // Morpion : 3 rangées de 3 cases + la rangée « Abandonner ».
  const board = jeu.render(states[2]).components.map(json);
  assert.equal(board.length, 4);
  assert.deepEqual(board.slice(0, 3).map((r) => r.components.length), [3, 3, 3]);
  assert.match(board[3].components[0].custom_id, /^cmd:jeu:abandon:/);
  assert.equal(board[0].components[0].disabled, true, 'case occupée désactivée');
  // Puissance 4 : colonne pleine retirée du menu, grille 7 × 6 dans l'embed.
  const p4View = jeu.render(states[4]);
  assert.deepEqual(json(p4View.components[0]).components[0].options.map((o) => o.value), ['2', '3', '4', '5', '6', '7']);
  assert.equal(json(p4View.embeds[0]).description.split('\n').filter((l) => /^[⚫🔴🟡🟥🟨]+$/u.test(l)).length, 6);
  // Pendu : un menu disparaît quand toutes ses lettres sont proposées.
  const pendu = jeu.render(states[6]).components.map(json);
  assert.equal(pendu.length, 2);
  assert.match(pendu[0].components[0].custom_id, /:nz$/);
});

test('rendu : classement (vide, plusieurs pages), carte d\'une partie disparue désactivée sauf 🗑️', () => {
  const { db } = memoryDb();
  const client = { repositories: { gameScores: new GameScoreRepository(db) } };
  const guild = { id: GUILD, name: 'Serveur' };
  const empty = jeu.boardView(client, guild, 'tous', 0, ALICE, ALICE);
  checkPayload(empty);
  assert.match(json(empty.embeds[0]).description, /Personne/);
  const entries = Array.from({ length: 25 }, (_, i) => ({ guildId: GUILD, userId: String(BigInt(ALICE) + BigInt(i)), game: 'quiz', outcome: 'win', points: i }));
  client.repositories.gameScores.record(entries);
  const page = jeu.boardView(client, guild, 'quiz', 2, ALICE, ALICE);
  const ids = checkPayload(page);
  assert.ok(ids.some((id) => id.startsWith('cmd:jeu:page:quiz:1:')));
  assert.match(json(page.embeds[0]).footer.text, /Page 3\/3/);
  assert.match(json(page.embeds[0]).fields[0].value, /#25/, 'place de la personne qui regarde');
  const huge = jeu.boardView(client, guild, 'quiz', 999, ALICE, BOB);
  assert.match(json(huge.embeds[0]).footer.text, /Page 3\/3/, 'page bornée');

  const message = { components: jeu.render(baseGame('devine', { players: [ALICE], state: { secret: 1, guesses: [], notice: null } })).components.map(json) };
  message.components[0].components.push({ type: 2, style: 2, custom_id: `cmd:_:delete:${ALICE}`, emoji: { name: '🗑️' } });
  const rows = jeu.disabledRows(message);
  const flat = rows.flatMap((r) => r.components);
  assert.ok(flat.filter((c) => !c.custom_id.startsWith('cmd:_:delete')).every((c) => c.disabled === true));
  assert.ok(!flat.find((c) => c.custom_id.startsWith('cmd:_:delete')).disabled);
  assert.equal(jeu.disabledRows({ components: [] }), null);
  assert.equal(jeu.disabledRows({ components: rows }), null, 'carte déjà figée : rien à modifier');
});

test('commande : une seule commande de premier niveau, sous-commandes et options conformes', () => {
  const data = jeu.data.toJSON();
  assert.equal(data.name, 'jeu');
  assert.equal(jeu.category, 'fun');
  assert.deepEqual(data.options.map((o) => o.name), ['morpion', 'puissance4', 'pendu', 'quiz', 'devine', 'classement']);
  const quiz = data.options.find((o) => o.name === 'quiz');
  const rounds = quiz.options.find((o) => o.name === 'manches');
  assert.deepEqual([rounds.min_value, rounds.max_value], [1, 10]);
  assert.deepEqual(quiz.options.find((o) => o.name === 'theme').choices.map((c) => c.value), Object.keys(Q.THEMES));
  assert.equal(data.options.find((o) => o.name === 'morpion').options[0].type, 6);
  assert.equal(jeu.autoDelete, false);
});
