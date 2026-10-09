'use strict';

/**
 * Bout en bout : /jeu (morpion, puissance 4, pendu, quiz, devine, classement) sur le vrai
 * discord.js. Parties jouées jusqu'au bout par de vrais clics, défis acceptés ou expirés,
 * minuteurs réels (raccourcis), parties expirées ou perdues au redémarrage, refus.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');
const { GameService } = require('../../src/services/GameService');
const H = require('../../src/utils/games/pendu');
const D = require('../../src/utils/games/devine');

const sub = (name, options = []) => [{ name, type: 1, options }];
const opt = (name, type, value) => ({ name, type, value });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (msg) => (msg?.components ?? []).flatMap((r) => r.components ?? []);
const isEphemeral = (m) => Boolean((m?.flags ?? 0) & EPHEMERAL);
const embedText = (msg) => (msg?.embeds ?? []).map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name} ${f.value}`)].join('\n')).join('\n');
/** Carte publique produite (ou mise à jour) par une interaction. */
const cardOf = (h, rec) => h.messagesOf(rec).find((m) => !isEphemeral(m)) ?? null;
/** Texte de la réponse éphémère (refus, « partie terminée »…). */
const privateText = (h, rec) => h.messagesOf(rec).filter(isEphemeral).map(embedText).join('\n');
const gameIdOf = (msg) => /Partie ([a-z0-9]{8})/.exec(msg?.embeds?.[0]?.footer?.text ?? '')?.[1] ?? null;
const scoreOf = (h, userId, game) => h.client.repositories.gameScores.get(h.guild.id, IDS.users[userId] ?? userId, game);

/** Termine les parties encore en cours (exploration suivante sur un terrain libre). */
function endAll(h) {
  const games = h.client.services.games;
  for (const game of [...games.games.values()]) games.end(game);
}

/** Clique un composant de la carte courante (relue à chaque fois). */
async function play(h, msgId, customId, as, values) {
  return h.click(h.message(msgId), customId, { as, values });
}

test('/jeu : chaque sous-commande lancée puis explorée (boutons, menus, formulaire) sans anomalie', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    // Classement sur plusieurs pages.
    h.client.repositories.gameScores.record(Array.from({ length: 12 }, (_, i) => ({ guildId: h.guild.id, userId: String(BigInt(IDS.users.owner) + BigInt(i * 7)), game: 'quiz', outcome: 'win', points: i + 1 })));
    const runs = [
      sub('morpion'),
      sub('morpion', [opt('adversaire', 6, IDS.users.target)]),
      sub('puissance4'),
      sub('puissance4', [opt('adversaire', 6, IDS.users.target)]),
      sub('pendu', [opt('mode', 3, 'solo')]),
      sub('pendu', [opt('mode', 3, 'salon')]),
      sub('quiz', [opt('theme', 3, 'jeuxvideo'), opt('manches', 4, 2)]),
      sub('devine'),
      sub('classement'),
      sub('classement', [opt('jeu', 3, 'quiz')]),
    ];
    const keys = new Set();
    for (const options of runs) {
      const rec = await h.slash('jeu', options);
      assert.ok(rec.ackType === 4, `/jeu ${options[0].name} : réponse attendue`);
      assert.ok(!h.isError(rec), `/jeu ${options[0].name} refusée : ${h.replyText(rec)}`);
      // « Abandonner » finirait la partie avant tout coup : il est exploré avec /jeu devine.
      const keepAbandon = options[0].name === 'devine';
      const stats = await explore(h, rec, { budget: 80, skip: (a) => !keepAbandon && a.customId.startsWith('cmd:jeu:abandon:') });
      for (const k of stats.keys) keys.add(k);
      endAll(h);
    }
    for (const action of ['jouer', 'colonne', 'lettre', 'reponse', 'proposer', 'abandon', 'accepter', 'refuser', 'vue', 'page']) {
      assert.ok(keys.has(`cmd:jeu:${action}`), `${action} jamais utilisé`);
    }
    assert.ok(keys.has('modal:cmd:jeu:nombre'), 'formulaire de devine jamais soumis');
    // Membre : mêmes commandes, explorées en tant que membre.
    for (const options of runs) {
      await explore(h, await h.slash('jeu', options, { as: 'member' }), { as: 'member', budget: 30 });
      endAll(h);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('morpion contre un membre : défi notifié (mention ciblée), acceptation réservée, tour par tour, victoire enregistrée', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('jeu', sub('morpion', [opt('adversaire', 6, IDS.users.target)]), { as: 'member' });
    const msg = cardOf(h, rec);
    assert.equal(msg.content, `<@${IDS.users.target}>`, 'l\'adversaire est notifié');
    const callback = h.fake.calls.find((c) => c.method === 'POST' && c.route.includes(`/interactions/${rec.raw.id}/`));
    assert.deepEqual(callback.body.data.allowed_mentions, { users: [IDS.users.target] }, 'seul l\'adversaire peut être notifié');
    const id = gameIdOf(msg);
    assert.ok(id);

    // Seul l'adversaire accepte ; un tiers ne peut ni accepter ni refuser.
    for (const as of ['admin', 'member']) {
      const denied = await play(h, msg.id, `cmd:jeu:accepter:${id}`, as);
      assert.ok(isEphemeral(h.messagesOf(denied)[0]), 'refus éphémère');
    }
    assert.match(privateText(h, await play(h, msg.id, `cmd:jeu:refuser:${id}`, 'admin')), /pas adressé/);
    const accepted = await play(h, msg.id, `cmd:jeu:accepter:${id}`, 'target');
    assert.equal(accepted.ackType, 7, 'acquittée par une mise à jour de la carte');
    let board = h.message(msg.id);
    assert.equal(board.components.length, 4);
    assert.deepEqual(board.components.slice(0, 3).map((r) => r.components.length), [3, 3, 3]);
    assert.match(board.components[3].components[0].custom_id, new RegExp(`^cmd:jeu:abandon:${id}$`));

    const game = h.client.services.games.get(id);
    const first = game.state.turn;
    const second = first === IDS.users.member ? IDS.users.target : IDS.users.member;
    // Un tiers et le joueur dont ce n'est pas le tour sont refusés, la grille ne bouge pas.
    const before = JSON.stringify(game.state.board);
    assert.match(privateText(h, await play(h, msg.id, `cmd:jeu:jouer:${id}:4`, 'admin')), /oppose/);
    assert.match(privateText(h, await play(h, msg.id, `cmd:jeu:jouer:${id}:4`, second)), /pas votre tour/);
    assert.equal(JSON.stringify(game.state.board), before);

    // Le premier joueur (❌) aligne la première ligne ; une ancienne carte est gardée pour plus tard.
    const snapshot = JSON.parse(JSON.stringify(h.message(msg.id)));
    for (const [as, cell] of [[first, 0], [second, 3], [first, 1], [second, 4], [first, 2]]) {
      const r = await play(h, msg.id, `cmd:jeu:jouer:${id}:${cell}`, as);
      assert.equal(r.ackType, 7);
    }
    board = h.message(msg.id);
    assert.match(embedText(board), new RegExp(`<@${first}> gagne la partie`));
    assert.ok(flat(board).filter((c) => c.custom_id.startsWith('cmd:jeu:jouer')).every((c) => c.disabled), 'grille figée');
    assert.deepEqual(flat(board).filter((c) => c.style === 3).map((c) => c.custom_id.split(':').pop()), ['0', '1', '2'], 'ligne gagnante en vert');
    assert.match(board.components[3].components[0].custom_id, /^cmd:_:delete:/);
    assert.deepEqual([scoreOf(h, first, 'morpion').wins, scoreOf(h, first, 'morpion').points], [1, 3]);
    assert.deepEqual([scoreOf(h, second, 'morpion').losses, scoreOf(h, second, 'morpion').points], [1, 0]);
    assert.equal(h.client.services.games.get(id), null);

    // Clic sur une copie de la carte d'avant la fin (client en retard) : « partie terminée ».
    assert.match(privateText(h, await h.click(snapshot, `cmd:jeu:jouer:${id}:8`, { as: first })), /Partie terminée/);
    // Verrous libérés : une nouvelle partie démarre.
    assert.ok(!h.isError(await h.slash('jeu', sub('morpion'), { as: 'member' })));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('morpion contre le bot : l\'IA n\'est jamais battue, parties enregistrées (nul ou défaite)', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    let played = 0;
    for (let g = 0; g < 4; g += 1) {
      const rec = await h.slash('jeu', sub('morpion', g === 3 ? [opt('adversaire', 6, IDS.users.bot)] : []), { as: 'member' });
      const msg = cardOf(h, rec);
      const id = gameIdOf(msg);
      for (let turn = 0; turn < 9 && h.client.services.games.get(id); turn += 1) {
        const free = flat(h.message(msg.id)).filter((c) => c.custom_id.startsWith('cmd:jeu:jouer') && !c.disabled);
        const pick = free[(g * 3 + turn * 5) % free.length];
        const r = await play(h, msg.id, pick.custom_id, 'member');
        assert.equal(r.ackType, 7, h.replyText(r));
      }
      assert.equal(h.client.services.games.get(id), null, 'partie terminée');
      assert.match(embedText(h.message(msg.id)), /gagne la partie|Match nul/);
      played += 1;
    }
    const score = scoreOf(h, 'member', 'morpion');
    assert.equal(score.wins, 0, 'l\'IA a perdu une partie');
    assert.equal(score.losses + score.draws, played);
    assert.equal(scoreOf(h, IDS.users.bot, 'morpion'), null, 'le bot n\'est pas classé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('puissance 4 : victoire verticale contre un membre (jetons gagnants marqués), partie complète contre le bot', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('jeu', sub('puissance4', [opt('adversaire', 6, IDS.users.target)]), { as: 'member' });
    const msg = cardOf(h, rec);
    const id = gameIdOf(msg);
    await play(h, msg.id, `cmd:jeu:accepter:${id}`, 'target');
    const game = h.client.services.games.get(id);
    const first = game.state.turn;
    const second = first === IDS.users.member ? IDS.users.target : IDS.users.member;
    const menu = flat(h.message(msg.id)).find((c) => c.type === 3);
    assert.equal(menu.custom_id, `cmd:jeu:colonne:${id}`);
    assert.equal(menu.options.length, 7);
    assert.match(privateText(h, await play(h, msg.id, menu.custom_id, second, ['1'])), /pas votre tour/);
    assert.match(privateText(h, await play(h, msg.id, menu.custom_id, first, ['9'])), /invalide/);
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await play(h, msg.id, menu.custom_id, first, ['1'])).ackType, 7);
      if (i < 3) await play(h, msg.id, menu.custom_id, second, ['2']);
    }
    const end = h.message(msg.id);
    assert.match(embedText(end), new RegExp(`<@${first}> gagne la partie`));
    const grid = end.embeds[0].description;
    assert.equal((grid.match(/🟥|🟨/gu) ?? []).length, 4, 'jetons gagnants marqués');
    assert.equal(scoreOf(h, first, 'puissance4').points, 3);

    // Contre le bot : on joue la première colonne libre jusqu'à la fin.
    const vsBot = await h.slash('jeu', sub('puissance4'), { as: 'member' });
    const card = cardOf(h, vsBot);
    const botGame = gameIdOf(card);
    for (let i = 0; i < 25 && h.client.services.games.get(botGame); i += 1) {
      const select = flat(h.message(card.id)).find((c) => c.type === 3);
      const r = await play(h, card.id, select.custom_id, 'member', [select.options[i % select.options.length].value]);
      assert.equal(r.ackType, 7, h.replyText(r));
    }
    assert.equal(h.client.services.games.get(botGame), null, 'partie contre le bot terminée');
    const s = scoreOf(h, 'member', 'puissance4');
    assert.equal(s.wins + s.losses + s.draws, 2);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('pendu solo : victoire (points selon les vies restantes), défaite après 6 erreurs, partie réservée au joueur', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('jeu', sub('pendu'), { as: 'member' });
    const msg = cardOf(h, rec);
    const id = gameIdOf(msg);
    const game = h.client.services.games.get(id);
    const letters = [...new Set(game.state.word.plain)];
    const menuFor = (l) => `cmd:jeu:lettre:${id}:${H.FIRST_HALF.includes(l) ? 'am' : 'nz'}`;
    assert.match(privateText(h, await play(h, msg.id, menuFor(letters[0]), 'admin', [letters[0]])), /réservée/);
    assert.equal(game.state.guessed.size, 0);
    // Lettre déjà proposée (valeur forgée) : refusée.
    await play(h, msg.id, menuFor(letters[0]), 'member', [letters[0]]);
    assert.match(privateText(h, await play(h, msg.id, menuFor(letters[0]), 'member', [letters[0]])), /déjà été proposée/);
    // Valeur hors du menu (N dans A-M) : refusée.
    assert.match(privateText(h, await h.click(h.message(msg.id), `cmd:jeu:lettre:${id}:am`, { as: 'member', values: ['Z'], componentType: 3 })), /invalide/);
    for (const l of letters.slice(1)) assert.equal((await play(h, msg.id, menuFor(l), 'member', [l])).ackType, 7);
    const won = h.message(msg.id);
    assert.match(embedText(won), /a trouvé le mot/);
    assert.ok(embedText(won).includes([...game.state.word.display].join(' ')), 'mot révélé avec ses accents');
    assert.deepEqual([scoreOf(h, 'member', 'pendu').wins, scoreOf(h, 'member', 'pendu').points], [1, H.winPoints(0)]);

    // Défaite : six lettres absentes du mot.
    const rec2 = await h.slash('jeu', sub('pendu', [opt('mode', 3, 'solo')]), { as: 'member' });
    const msg2 = cardOf(h, rec2);
    const id2 = gameIdOf(msg2);
    const word = h.client.services.games.get(id2).state.word;
    const wrong = H.LETTERS.filter((l) => !word.plain.includes(l)).slice(0, 6);
    for (const l of wrong) await play(h, msg2.id, `cmd:jeu:lettre:${id2}:${H.FIRST_HALF.includes(l) ? 'am' : 'nz'}`, 'member', [l]);
    const lost = h.message(msg2.id);
    assert.match(embedText(lost), /Perdu !/);
    assert.ok(embedText(lost).includes(word.display), 'le mot est révélé');
    assert.ok(lost.embeds[0].description.includes(H.drawing(6)), 'pendu complet');
    assert.equal(scoreOf(h, 'member', 'pendu').losses, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('pendu en salon : tout le monde propose, la personne qui complète le mot gagne ; arrêt réservé au lanceur et aux modérateurs', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('jeu', sub('pendu', [opt('mode', 3, 'salon')]), { as: 'admin' });
    const msg = cardOf(h, rec);
    const id = gameIdOf(msg);
    // Une seconde partie « salon » dans ce salon est refusée ; une partie solo reste possible.
    assert.match(h.replyText(await h.slash('jeu', sub('pendu', [opt('mode', 3, 'salon')]), { as: 'member' })), /déjà en cours dans ce salon/);
    assert.ok(!h.isError(await h.slash('jeu', sub('pendu'), { as: 'member' })));

    const game = h.client.services.games.get(id);
    const letters = [...new Set(game.state.word.plain)];
    const players = ['member', 'target', 'mod'];
    for (const [i, l] of letters.entries()) {
      await play(h, msg.id, `cmd:jeu:lettre:${id}:${H.FIRST_HALF.includes(l) ? 'am' : 'nz'}`, players[i % 3], [l]);
    }
    const finder = IDS.users[players[(letters.length - 1) % 3]];
    assert.match(embedText(h.message(msg.id)), new RegExp(`<@${finder}> a trouvé le mot`));
    assert.equal(scoreOf(h, finder, 'pendu').wins, 1);

    // Arrêt : refusé à un membre, permis à un modérateur (aucun score en salon).
    const rec2 = await h.slash('jeu', sub('pendu', [opt('mode', 3, 'salon')]), { as: 'admin' });
    const msg2 = cardOf(h, rec2);
    const id2 = gameIdOf(msg2);
    assert.match(privateText(h, await play(h, msg2.id, `cmd:jeu:abandon:${id2}`, 'member')), /modérateurs/);
    assert.ok(h.client.services.games.get(id2));
    assert.equal((await play(h, msg2.id, `cmd:jeu:abandon:${id2}`, 'mod')).ackType, 7);
    assert.match(embedText(h.message(msg2.id)), /Partie arrêtée/);
    assert.equal(scoreOf(h, 'admin', 'pendu'), null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('quiz : salon, une réponse par joueur et par question, premier juste marque, minuteur réel, classement final', async () => {
  const h = await createHarness();
  h.configureAll();
  const games = h.client.services.games;
  games.questionMs = 300;
  try {
    const rec = await h.slash('jeu', sub('quiz', [opt('manches', 4, 3)]), { as: 'admin' });
    const msg = cardOf(h, rec);
    const id = gameIdOf(msg);
    assert.match(msg.embeds[0].title, /Question 1\/3/);
    assert.match(h.replyText(await h.slash('jeu', sub('quiz'), { as: 'member' })), /déjà en cours dans ce salon/);
    const game = games.get(id);
    const answerOf = () => game.state.questions[game.state.index].answer;
    const wrongOf = () => (answerOf() + 1) % 4;

    // Q1 : mauvaise réponse (éphémère), seconde tentative refusée, puis bonne réponse d'un autre membre.
    const snapshot = JSON.parse(JSON.stringify(h.message(msg.id)));
    const miss = await play(h, msg.id, `cmd:jeu:reponse:${id}:0-${wrongOf()}`, 'member');
    assert.equal(miss.ackType, 7);
    assert.match(privateText(h, miss), /Mauvaise réponse/);
    assert.match(embedText(h.message(msg.id)), /1 réponse/);
    assert.match(privateText(h, await play(h, msg.id, `cmd:jeu:reponse:${id}:0-${answerOf()}`, 'member')), /déjà répondu/);
    const hit = await play(h, msg.id, `cmd:jeu:reponse:${id}:0-${answerOf()}`, 'target');
    assert.equal(hit.ackType, 7);
    assert.match(h.message(msg.id).embeds[0].title, /Question 2\/3/);
    assert.match(embedText(h.message(msg.id)), new RegExp(`<@${IDS.users.target}> a trouvé`));
    // Bouton d'une question close (ancienne carte) : refusé.
    assert.match(privateText(h, await h.click(snapshot, `cmd:jeu:reponse:${id}:0-${answerOf()}`, { as: 'mod' })), /question est terminée/);

    // Q2 : personne ne répond, le minuteur passe à la question suivante (carte éditée).
    assert.ok(await h.waitFor(() => /Question 3\/3/.test(h.message(msg.id).embeds[0].title), { timeout: 3_000 }), 'minuteur de question');
    assert.match(embedText(h.message(msg.id)), /Temps écoulé/);

    // Q3 : bonne réponse de l'administrateur → fin du quiz et classement.
    await play(h, msg.id, `cmd:jeu:reponse:${id}:2-${answerOf()}`, 'admin');
    const end = h.message(msg.id);
    assert.match(end.embeds[0].title, /Résultats/);
    assert.match(embedText(end), /Quiz terminé/);
    assert.deepEqual(flat(end).map((c) => c.custom_id.split(':').slice(0, 3).join(':')), ['cmd:_:delete']);
    assert.equal(scoreOf(h, 'target', 'quiz').draws, 1, 'ex æquo en tête : nul');
    assert.equal(scoreOf(h, 'admin', 'quiz').points, 1);
    assert.equal(scoreOf(h, 'member', 'quiz').losses, 1, 'participant sans point : défaite');
    assert.equal(games.get(id), null);

    // Arrêt : refusé à un membre, permis au lanceur ; aucun point enregistré.
    const rec2 = await h.slash('jeu', sub('quiz', [opt('theme', 3, 'histoire')]), { as: 'admin' });
    const msg2 = cardOf(h, rec2);
    const id2 = gameIdOf(msg2);
    assert.match(privateText(h, await play(h, msg2.id, `cmd:jeu:abandon:${id2}`, 'member')), /modérateurs/);
    await play(h, msg2.id, `cmd:jeu:reponse:${id2}:0-${games.get(id2).state.questions[0].answer}`, 'member');
    await play(h, msg2.id, `cmd:jeu:abandon:${id2}`, 'admin');
    assert.match(embedText(h.message(msg2.id)), /Quiz arrêté/);
    assert.equal(scoreOf(h, 'member', 'quiz').points, 0, 'arrêt anticipé : rien d\'enregistré');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('devine : formulaire, saisie invalide refusée, plus/moins, victoire par dichotomie', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('jeu', sub('devine'), { as: 'member' });
    const msg = cardOf(h, rec);
    const id = gameIdOf(msg);
    assert.match(privateText(h, await play(h, msg.id, `cmd:jeu:proposer:${id}`, 'admin')), /réservée/);
    let open = await play(h, msg.id, `cmd:jeu:proposer:${id}`, 'member');
    assert.equal(open.ackType, 9, 'formulaire ouvert');
    for (const bad of ['0', 'abc', '101']) {
      const r = await h.submitModal(open, { nombre: bad });
      assert.match(privateText(h, r), /nombre entier/);
    }
    let low = D.MIN;
    let high = D.MAX;
    let attempts = 0;
    for (; attempts < 10; attempts += 1) {
      const guess = Math.floor((low + high) / 2);
      open = await play(h, msg.id, `cmd:jeu:proposer:${id}`, 'member');
      const r = await h.submitModal(open, { nombre: String(guess) });
      assert.equal(r.ackType, 7);
      const text = embedText(h.message(msg.id));
      if (/🎯 \*\*\d+\*\* : c'est gagné/.test(text)) break;
      if (/📈 \*\*\d+\*\* : c'est plus/.test(text)) low = guess + 1;
      else if (/📉 \*\*\d+\*\* : c'est moins/.test(text)) high = guess - 1;
      else assert.fail(`indication absente : ${text}`);
    }
    attempts += 1;
    assert.ok(attempts <= 7, `${attempts} essais`);
    assert.match(embedText(h.message(msg.id)), new RegExp(`Trouvé en \\*\\*${attempts}\\*\\* essai`));
    assert.deepEqual([scoreOf(h, 'member', 'devine').wins, scoreOf(h, 'member', 'devine').points], [1, D.winPoints(attempts)]);
    // Formulaire soumis après la fin : « partie terminée ».
    assert.match(privateText(h, await h.submitModal(open, { nombre: '50' })), /Partie terminée/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('défi sans réponse (délai réduit) : annulé, carte désactivée, verrous libérés', async () => {
  const h = await createHarness();
  h.configureAll();
  h.client.services.games.inviteMs = 150;
  try {
    const rec = await h.slash('jeu', sub('puissance4', [opt('adversaire', 6, IDS.users.target)]), { as: 'member' });
    const msg = cardOf(h, rec);
    assert.match(h.replyText(await h.slash('jeu', sub('puissance4', [opt('adversaire', 6, IDS.users.member)]), { as: 'admin' })), /a déjà une partie de \*\*Puissance 4\*\*/);
    assert.ok(await h.waitFor(() => /n'a pas répondu/.test(embedText(h.message(msg.id))), { timeout: 3_000 }));
    assert.deepEqual(flat(h.message(msg.id)).map((c) => c.custom_id.split(':').slice(0, 3).join(':')), ['cmd:_:delete']);
    assert.ok(!h.isError(await h.slash('jeu', sub('puissance4', [opt('adversaire', 6, IDS.users.target)]), { as: 'member' })), 'verrous libérés');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('partie expirée ou perdue au redémarrage : « partie terminée » en éphémère, carte désactivée ; nettoyage périodique', async () => {
  const h = await createHarness();
  h.configureAll();
  const games = h.client.services.games;
  try {
    // Inactivité : le clic découvre la partie expirée.
    const rec = await h.slash('jeu', sub('devine'), { as: 'member' });
    const msg = cardOf(h, rec);
    const id = gameIdOf(msg);
    games.ttlMs = 50;
    await sleep(80);
    const late = await play(h, msg.id, `cmd:jeu:proposer:${id}`, 'member');
    assert.match(privateText(h, late), /Partie terminée/);
    assert.ok(flat(h.message(msg.id)).every((c) => c.disabled), 'carte désactivée');

    // Nettoyage périodique : la carte affiche l'expiration.
    games.ttlMs = 10 * 60_000;
    const rec2 = await h.slash('jeu', sub('quiz', [opt('manches', 4, 1)]), { as: 'admin' });
    const msg2 = cardOf(h, rec2);
    games.ttlMs = 1;
    await sleep(5);
    assert.equal(games.sweep(), 1);
    assert.ok(await h.waitFor(() => /Partie expirée/.test(embedText(h.message(msg2.id)))));
    assert.deepEqual(flat(h.message(msg2.id)).map((c) => c.custom_id.split(':').slice(0, 3).join(':')), ['cmd:_:delete']);
    games.ttlMs = 10 * 60_000;

    // Redémarrage : les parties en mémoire sont perdues.
    const rec3 = await h.slash('jeu', sub('pendu'), { as: 'member' });
    const msg3 = cardOf(h, rec3);
    const id3 = gameIdOf(msg3);
    h.client.services.games.stop();
    h.client.services.games = new GameService({ client: h.client, scores: h.client.repositories.gameScores });
    const after = await play(h, msg3.id, `cmd:jeu:lettre:${id3}:am`, 'member', ['A']);
    assert.match(privateText(h, after), /Partie terminée/);
    assert.ok(flat(h.message(msg3.id)).every((c) => c.disabled));
    assert.ok(!h.isError(await h.slash('jeu', sub('pendu'), { as: 'member' })), 'nouvelle partie possible');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('refus clairs : partie déjà en cours (lien vers la carte), adversaire invalide ; carte ou salon supprimés → partie arrêtée', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('jeu', sub('devine'), { as: 'member' });
    const msg = cardOf(h, rec);
    const again = await h.slash('jeu', sub('devine'), { as: 'member' });
    assert.ok(h.isError(again));
    assert.ok(isEphemeral(h.messagesOf(again)[0]));
    assert.match(h.replyText(again), new RegExp(`déjà une partie de \\*\\*Devine le nombre\\*\\*.*channels/${h.guild.id}/${msg.channel_id}/${msg.id}`, 's'));
    assert.match(h.replyText(await h.slash('jeu', sub('morpion', [opt('adversaire', 6, IDS.users.member)]), { as: 'member' })), /vous-même/);
    assert.match(h.replyText(await h.slash('jeu', sub('morpion', [opt('adversaire', 6, IDS.users.otherBot)]), { as: 'member' })), /bots/);
    const outsider = h.addUser('Visiteur');
    assert.match(h.replyText(await h.slash('jeu', sub('morpion', [opt('adversaire', 6, outsider.id)]), { as: 'member' })), /pas sur le serveur/);
    // Le bot lui-même comme adversaire : partie contre l'IA.
    const vsBot = await h.slash('jeu', sub('morpion', [opt('adversaire', 6, IDS.users.bot)]), { as: 'member' });
    assert.match(embedText(cardOf(h, vsBot)), /Au tour de/);

    // Carte supprimée (🗑️ d'un modérateur, purge…) : la partie s'arrête, le verrou est libéré.
    await h.deleteUserMessage(msg.id);
    assert.ok(!h.isError(await h.slash('jeu', sub('devine'), { as: 'member' })));

    // Quiz : un par salon (deux salons → deux quiz) ; salon supprimé → son quiz s'arrête.
    const games = h.client.services.games;
    assert.ok(!h.isError(await h.slash('jeu', sub('quiz'), { as: 'admin' })));
    assert.ok(!h.isError(await h.slash('jeu', sub('quiz'), { as: 'admin', channel: 'staff' })));
    const quizIn = (channel) => [...games.games.values()].filter((g) => g.type === 'quiz' && g.channelId === IDS.channels[channel]).length;
    assert.deepEqual([quizIn('general'), quizIn('staff')], [1, 1]);
    h.fake.deleteChannel(IDS.channels.staff);
    await h.settle();
    assert.deepEqual([quizIn('general'), quizIn('staff')], [1, 0]);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/jeu classement : filtre par jeu, pagination, place de la personne', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const repo = h.client.repositories.gameScores;
    repo.record(Array.from({ length: 23 }, (_, i) => ({ guildId: h.guild.id, userId: String(BigInt(IDS.users.owner) + BigInt(i * 11)), game: i % 2 ? 'morpion' : 'devine', outcome: 'win', points: 3 + i })));
    repo.record([{ guildId: h.guild.id, userId: IDS.users.member, game: 'morpion', outcome: 'draw', points: 1 }]);
    const rec = await h.slash('jeu', sub('classement', [opt('jeu', 3, 'morpion')]), { as: 'member' });
    const msg = cardOf(h, rec);
    assert.match(msg.embeds[0].title, /Morpion/);
    assert.match(msg.embeds[0].footer.text, /Page 1\/2 · 12 joueurs/);
    assert.match(embedText(msg), /Votre place.*#12/s);
    const next = flat(msg).find((c) => c.custom_id === `cmd:jeu:page:morpion:1:${IDS.users.member}`);
    assert.ok(next);
    await h.click(msg, next.custom_id, { as: 'admin' });
    assert.match(h.message(msg.id).embeds[0].footer.text, /Page 2\/2/);
    await h.click(h.message(msg.id), `cmd:jeu:vue:${IDS.users.member}`, { as: 'member', values: ['tous'] });
    assert.match(h.message(msg.id).embeds[0].title, /Tous les jeux/);
    assert.match(h.message(msg.id).embeds[0].footer.text, /24 joueurs/);
    assert.match(privateText(h, await h.click(h.message(msg.id), `cmd:jeu:vue:${IDS.users.member}`, { as: 'member', values: ['echecs'] })), /inconnu/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
