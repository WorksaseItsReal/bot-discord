'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { card, field, wide, ICONS, subtext, actionButton, deleteButton, labelButton, buttonRows, ButtonStyle, status } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');
const T = require('../../utils/games/morpion');
const P4 = require('../../utils/games/puissance4');
const H = require('../../utils/games/pendu');
const Q = require('../../utils/games/quiz');
const D = require('../../utils/games/devine');

/**
 * /jeu : mini-jeux (morpion, puissance 4, pendu, quiz, devine le nombre) et classement.
 *
 * Parties en mémoire (client.services.games, src/services/GameService.js), scores en base
 * (migration 24). customId : cmd:jeu:<action>:<partieId>[:<coup>] — le coup d'un menu est
 * dans ses valeurs. Une partie disparue (expirée, redémarrage) répond « partie terminée »
 * en éphémère et sa carte est désactivée.
 *
 * Verrous : morpion, puissance 4, devine et pendu solo → une partie par joueur et par jeu ;
 * quiz et pendu « salon » → une partie par salon.
 */

const GAMES = Object.freeze({
  morpion: { label: 'Morpion', emoji: '⭕' },
  puissance4: { label: 'Puissance 4', emoji: '🔴' },
  pendu: { label: 'Pendu', emoji: '🔤' },
  quiz: { label: 'Quiz', emoji: '❓' },
  devine: { label: 'Devine le nombre', emoji: '🔢' },
});
const ALL = 'tous';
/** Points d'un duel (morpion, puissance 4). */
const DUEL_POINTS = Object.freeze({ win: 3, draw: 1, loss: 0 });
const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const MARKS = { [T.X]: '❌', [T.O]: '⭕' };
const DISCS = { [P4.EMPTY]: '⚫', [P4.RED]: '🔴', [P4.YELLOW]: '🟡' };
const WIN_DISCS = { [P4.RED]: '🟥', [P4.YELLOW]: '🟨' };
const SNOWFLAKE = /^\d{17,20}$/;
const EXPIRED = '⌛ Partie expirée : aucune action depuis 10 minutes.';

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const mention = (id) => `<@${id}>`;
const lockKey = (type, scope, id) => `${type}:${scope}:${id}`;
const games = (client) => client.services.games;
const row = (component) => new ActionRowBuilder().addComponents(component);
const isOver = (game) => game.status !== 'playing' && game.status !== 'pending';
const isMod = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));
const messageLink = (game) => (game.messageId ? `https://discord.com/channels/${game.guildId}/${game.channelId}/${game.messageId}` : null);

/** Bouton d'action d'une partie : cmd:jeu:<action>:<partieId>[:<coup>]. */
const gameButton = (action, game, extra, opts) =>
  actionButton({ command: 'jeu', action, args: extra == null ? [game.id] : [game.id, extra], ...opts });

const abandonButton = (game, label = 'Abandonner') =>
  gameButton('abandon', game, null, { label, emoji: '🏳️', style: ButtonStyle.Danger });

/** Carte d'une partie (section Fun, pied de page « Partie <id> »). */
function gameCard(game, { tone, title, description, fields } = {}) {
  const meta = GAMES[game.type];
  return card({
    // Victoire d'un membre : carte festive ; défaite contre le bot, nul, abandon, expiration : sobre.
    tone: tone ?? (isOver(game) ? (game.result?.type === 'win' && game.result.winner !== game.state?.botId ? 'celebrate' : 'neutral') : 'fun'),
    section: 'fun',
    icon: meta.emoji,
    title: title ?? meta.label,
    description,
    fields,
    footer: `Partie ${game.id}`,
  });
}

/** Rendu d'une partie, quel que soit son jeu (utilisé aussi à l'expiration). */
function render(game) {
  switch (game.type) {
    case 'morpion':
      return morpionView(game);
    case 'puissance4':
      return p4View(game);
    case 'pendu':
      return penduView(game);
    case 'quiz':
      return quizView(game);
    default:
      return devineView(game);
  }
}

// ======================================================================== duels

/** Défi en attente (ou refusé, annulé, sans réponse). */
function inviteView(game) {
  const [owner, opp] = game.players;
  const meta = GAMES[game.type];
  const title = `${meta.label} · Défi`;
  if (game.status === 'pending') {
    return {
      embeds: [gameCard(game, {
        title,
        description: [
          `${mention(opp)}, ${mention(owner)} vous défie au **${meta.label}** !`,
          subtext(`Acceptez ${discordTimestamp(game.state.inviteUntil, 'R')}, sinon le défi sera annulé.`),
        ],
      })],
      components: buttonRows(
        gameButton('accepter', game, null, { label: 'Accepter', emoji: ICONS.success, style: ButtonStyle.Success }),
        gameButton('refuser', game, null, { label: 'Refuser', emoji: '✖️', style: ButtonStyle.Secondary }),
        abandonButton(game, 'Annuler'),
      ),
    };
  }
  const text = {
    declined: `✖️ ${mention(opp)} a refusé le défi.`,
    cancelled: `🏳️ ${mention(owner)} a annulé le défi.`,
    timeout: `⌛ ${mention(opp)} n'a pas répondu à temps : défi annulé.`,
  }[game.result?.type] ?? EXPIRED;
  return { embeds: [gameCard(game, { tone: 'neutral', title, description: text })], components: buttonRows(deleteButton(owner)) };
}

/** Joueurs d'un duel avec leur symbole. */
const playersLine = (game, symbols) => game.players.map((id) => `${symbols[game.state.marks[id]]} ${mention(id)}`).join('  ·  ');

/** Verdict d'un duel terminé. */
function duelOutcome(game) {
  if (game.status === 'expired') return EXPIRED;
  const r = game.result ?? {};
  const bot = game.state.botId;
  const human = (id) => id !== bot;
  if (r.type === 'win') return `🏆 ${mention(r.winner)} gagne la partie !${human(r.winner) ? ` **+${pts(DUEL_POINTS.win)}**` : ''}`;
  if (r.type === 'draw') return `🤝 Match nul ! **+${pts(DUEL_POINTS.draw)}**${game.state.vsBot ? '' : ' chacun'}`;
  if (r.type === 'abandon') return `🏳️ ${mention(r.loser)} abandonne : victoire de ${mention(r.winner)}.`;
  return '🏁 Partie terminée.';
}

const turnLine = (game, symbols) => `▶️ Au tour de ${mention(game.state.turn)} (${symbols[game.state.marks[game.state.turn]]})`;

/** Début d'un duel : premier joueur tiré au sort (❌ / 🔴 commence). */
function beginDuel(game, rng = Math.random) {
  const [a, b] = game.players;
  const starter = rng() < 0.5 ? a : b;
  const first = game.type === 'morpion' ? T.X : P4.RED;
  const second = game.type === 'morpion' ? T.O : P4.YELLOW;
  game.status = 'playing';
  game.state.marks = { [starter]: first, [starter === a ? b : a]: second };
  game.state.turn = starter;
  game.state.board = game.type === 'morpion' ? T.newBoard() : P4.newBoard();
  if (game.state.vsBot && starter === game.state.botId) botTurn(game);
}

const opponentOf = (game, userId) => game.players.find((id) => id !== userId);

/** Le bot joue (morpion : minimax imbattable ; puissance 4 : IA simple). */
function botTurn(game) {
  const s = game.state;
  const mark = s.marks[s.botId];
  if (game.type === 'morpion') {
    const cell = T.bestMove(s.board, mark);
    if (cell >= 0) s.board[cell] = mark;
  } else {
    const col = P4.aiMove(s.board, mark);
    if (col >= 0) s.last = { col, row: P4.drop(s.board, col, mark), mark };
  }
  s.turn = opponentOf(game, s.botId);
}

/** Résultats d'un duel en base (le bot n'est jamais classé). */
function recordDuel(client, game, winnerId) {
  games(client).record(game.players.map((userId) => {
    const outcome = winnerId == null ? 'draw' : userId === winnerId ? 'win' : 'loss';
    return { guildId: game.guildId, userId, game: game.type, outcome, points: DUEL_POINTS[outcome] };
  }));
}

/** Fin de partie si la grille est gagnée ou pleine. @returns {boolean} */
function settleDuel(client, game) {
  const s = game.state;
  let result = null;
  if (game.type === 'morpion') {
    const o = T.outcomeOf(s.board);
    if (o?.type === 'win') result = { type: 'win', winner: playerWithMark(game, o.mark), line: o.line };
    else if (o?.type === 'draw') result = { type: 'draw' };
  } else {
    const w = s.last ? P4.lineThrough(s.board, s.last.row, s.last.col) : null;
    if (w) result = { type: 'win', winner: playerWithMark(game, s.last.mark), cells: w };
    else if (P4.isFull(s.board)) result = { type: 'draw' };
  }
  if (!result) return false;
  game.result = result;
  recordDuel(client, game, result.type === 'win' ? result.winner : null);
  games(client).end(game);
  return true;
}

const playerWithMark = (game, mark) => game.players.find((id) => game.state.marks[id] === mark);

function morpionView(game) {
  const s = game.state;
  if (!s.marks) return inviteView(game);
  const over = isOver(game);
  const line = new Set(game.result?.line ?? []);
  const cells = s.board.map((c, i) =>
    gameButton('jouer', game, i, {
      ...(c === T.EMPTY ? { label: '\u200b' } : { emoji: MARKS[c] }),
      style: line.has(i) ? ButtonStyle.Success : ButtonStyle.Secondary,
      disabled: over || c !== T.EMPTY,
    }),
  );
  const rows = [0, 1, 2].map((r) => new ActionRowBuilder().addComponents(cells.slice(r * 3, r * 3 + 3)));
  rows.push(row(over ? deleteButton(game.ownerId) : abandonButton(game)));
  return {
    embeds: [gameCard(game, { description: [over ? duelOutcome(game) : turnLine(game, MARKS), subtext(playersLine(game, MARKS))] })],
    components: rows,
  };
}

function p4View(game) {
  const s = game.state;
  if (!s.marks) return inviteView(game);
  const over = isOver(game);
  const win = new Set(game.result?.cells ?? []);
  const grid = [KEYCAPS.join('')];
  for (let r = 0; r < P4.ROWS; r += 1) {
    let line = '';
    for (let c = 0; c < P4.COLS; c += 1) {
      const i = r * P4.COLS + c;
      line += win.has(i) ? WIN_DISCS[s.board[i]] : DISCS[s.board[i]];
    }
    grid.push(line);
  }
  const components = over
    ? buttonRows(deleteButton(game.ownerId))
    : [
      row(new StringSelectMenuBuilder()
        .setCustomId(`cmd:jeu:colonne:${game.id}`)
        .setPlaceholder('Choisissez une colonne…')
        .addOptions(P4.playableColumns(s.board).map((c) => ({ label: `Colonne ${c + 1}`, value: String(c + 1), emoji: KEYCAPS[c] })))),
      row(abandonButton(game)),
    ];
  return {
    embeds: [gameCard(game, {
      description: [
        over ? duelOutcome(game) : turnLine(game, DISCS),
        subtext(`${playersLine(game, DISCS)}${s.last ? ` · dernier coup : ${DISCS[s.last.mark]} colonne ${s.last.col + 1}` : ''}`),
        '',
        grid.join('\n'),
      ],
    })],
    components,
  };
}

/** Lance un duel (contre un membre, qui doit accepter, ou contre le bot). */
async function startDuel(interaction, client, type) {
  const botId = client.user.id;
  const target = interaction.options.getUser('adversaire');
  let opponentId = botId;
  if (target && target.id !== botId) {
    if (target.id === interaction.user.id) throw new UserError('Vous ne pouvez pas vous défier vous-même. Lancez la commande sans adversaire pour m\'affronter.');
    if (target.bot) throw new UserError('Les autres bots ne savent pas jouer : lancez la commande sans adversaire pour m\'affronter.');
    if (!interaction.options.getMember('adversaire')) throw new UserError('Ce membre n\'est pas sur le serveur.');
    opponentId = target.id;
  }
  const vsBot = opponentId === botId;
  const humans = vsBot ? [interaction.user.id] : [interaction.user.id, opponentId];
  assertFree(client, interaction, type, 'u', humans);
  const service = games(client);
  await launch(interaction, client, {
    type,
    players: [interaction.user.id, opponentId],
    locks: humans.map((id) => lockKey(type, 'u', id)),
    status: vsBot ? 'playing' : 'pending',
    state: { vsBot, botId },
    setup(game) {
      if (vsBot) return beginDuel(game);
      game.state.inviteUntil = Date.now() + service.inviteMs;
      service.timer(game, 'invite', service.inviteMs, () => inviteTimeout(client, game));
    },
  }, vsBot ? {} : { content: mention(opponentId), allowedMentions: { users: [opponentId] } });
}

/** Défi sans réponse : annulé, carte désactivée. */
async function inviteTimeout(client, game) {
  if (game.status !== 'pending') return;
  game.result = { type: 'timeout' };
  games(client).end(game);
  await games(client).edit(game, render(game));
}

/** Participant d'un duel (sinon refus éphémère). */
function assertPlayer(game, userId) {
  if (!game.players.includes(userId)) {
    throw new UserError(`Cette partie oppose ${game.players.map(mention).join(' et ')}. Lancez la vôtre avec \`/jeu ${game.type}\`.`);
  }
}

/** Coup d'un humain dans un duel en cours. */
function assertTurn(game, userId) {
  assertPlayer(game, userId);
  if (game.status === 'pending') throw new UserError('La partie n\'a pas commencé : l\'adversaire doit d\'abord accepter le défi.');
  if (game.state.turn !== userId) throw new UserError(`Ce n'est pas votre tour : ${mention(game.state.turn)} doit jouer.`);
}

// ======================================================================== pendu

function penduView(game) {
  const s = game.state;
  const over = isOver(game);
  const errors = H.errorCount(s.word, s.guessed);
  const misses = [...s.guessed].filter((l) => !s.word.plain.includes(l)).sort();
  const salon = s.mode === 'salon';
  const reveal = `Le mot était **${s.word.display}**.`;
  let outcome = null;
  if (game.status === 'expired') outcome = `${EXPIRED}\n${reveal}`;
  else if (game.result?.type === 'win') outcome = `🎉 ${mention(game.result.winner)} a trouvé le mot ! **+${pts(game.result.points)}**`;
  else if (game.result?.type === 'loss') outcome = `💀 Perdu ! ${reveal}`;
  else if (game.result?.type === 'abandon') outcome = `🏳️ Partie arrêtée. ${reveal}`;
  const word = over ? [...s.word.display].join(' ') : H.maskWord(s.word, s.guessed);
  const components = over
    ? buttonRows(deleteButton(game.ownerId))
    : [letterMenu(game, 'am'), letterMenu(game, 'nz'), row(abandonButton(game, salon ? 'Arrêter' : 'Abandonner'))].filter(Boolean);
  return {
    embeds: [gameCard(game, {
      title: salon ? 'Pendu · Salon' : 'Pendu',
      description: [
        s.notice ?? null,
        `\`\`\`\n${H.drawing(errors)}\n\`\`\``,
        `### \`${word}\``,
        outcome,
        !over && salon ? subtext('Tout le monde peut proposer une lettre : la personne qui complète le mot gagne.') : null,
      ],
      fields: [
        field('❌', 'Erreurs', `**${errors}** / ${H.MAX_ERRORS}`),
        field('🔤', 'Lettres ratées', misses.length ? misses.join(' ') : '—'),
        salon ? field(ICONS.members, 'Mode', 'Salon') : field(ICONS.user, 'Joueur', mention(game.ownerId)),
      ],
    })],
    components,
  };
}

/** Menu des lettres encore disponibles (A à M ou N à Z), ou null s'il n'en reste aucune. */
function letterMenu(game, half) {
  const letters = (half === 'am' ? H.FIRST_HALF : H.SECOND_HALF).filter((l) => !game.state.guessed.has(l));
  if (!letters.length) return null;
  return row(new StringSelectMenuBuilder()
    .setCustomId(`cmd:jeu:lettre:${game.id}:${half}`)
    .setPlaceholder(half === 'am' ? 'Proposer une lettre (A à M)…' : 'Proposer une lettre (N à Z)…')
    .addOptions(letters.map((l) => ({ label: l, value: l }))));
}

async function startPendu(interaction, client) {
  const salon = interaction.options.getString('mode') === 'salon';
  const scope = salon ? 'c' : 'u';
  const holderId = salon ? interaction.channelId : interaction.user.id;
  assertFree(client, interaction, 'pendu', scope, [holderId], salon ? 'Pendu (salon)' : null);
  await launch(interaction, client, {
    type: 'pendu',
    locks: [lockKey('pendu', scope, holderId)],
    state: { mode: salon ? 'salon' : 'solo', word: H.randomWord(), guessed: new Set(), notice: null },
  });
}

// ======================================================================== quiz

function quizView(game) {
  const s = game.state;
  const over = isOver(game);
  const theme = s.theme ? Q.THEMES[s.theme] : null;
  const themeLabel = theme ? `${theme.emoji} ${theme.label}` : '🎲 Tous les thèmes';
  if (over) {
    const ranking = Q.finalRanking(s.scores);
    const recap = s.history.map((h, i) => `${i + 1}. ${truncate(h.answer, 40)} · ${h.winner ? `✅ ${mention(h.winner)}` : '⌛ personne'}`);
    let head = '🏁 **Quiz terminé !**';
    if (game.status === 'expired') head = EXPIRED;
    else if (game.result?.type === 'stopped') head = `⏹️ Quiz arrêté par ${mention(game.result.by)} : aucun point n'est enregistré.`;
    return {
      embeds: [gameCard(game, {
        tone: ranking.length && game.result?.type === 'done' ? 'gold' : 'neutral',
        title: 'Quiz · Résultats',
        description: [
          s.notice ?? null,
          s.notice ? '' : null,
          head,
          '',
          ranking.length
            ? ranking.slice(0, 10).map((r) => {
              // Ex æquo : même place (classement « 1, 1, 3 »).
              const place = 1 + ranking.filter((x) => x.points > r.points).length;
              return `${MEDALS[place - 1] ?? `\`#${place}\``} ${mention(r.userId)} · **${pts(r.points)}**`;
            }).join('\n')
            : 'Personne n\'a répondu.',
        ],
        fields: [
          field('🏷️', 'Thème', themeLabel),
          field(ICONS.count, 'Questions', `${s.history.length} / ${s.questions.length}`),
          recap.length ? wide(ICONS.history, 'Réponses', recap.join('\n')) : null,
        ],
      })],
      components: buttonRows(deleteButton(game.ownerId)),
    };
  }
  const question = s.questions[s.index];
  const top = Q.finalRanking(s.scores).filter((r) => r.points > 0).slice(0, 5);
  return {
    embeds: [gameCard(game, {
      title: `Quiz · Question ${s.index + 1}/${s.questions.length}`,
      description: [
        s.notice ?? null,
        s.notice ? '' : null,
        `**${question.q}**`,
        '',
        question.choices.map((c, i) => `${Q.CHOICE_EMOJIS[i]} ${c}`).join('\n'),
        '',
        subtext(`⏱️ Fin ${discordTimestamp(s.deadline, 'R')} · 🙋 ${s.answered.size} réponse${s.answered.size > 1 ? 's' : ''}`),
      ],
      fields: [
        field('🏷️', 'Thème', themeLabel),
        field(ICONS.stats, 'Scores', top.length ? top.map((r) => `${mention(r.userId)} · **${r.points}**`).join('\n') : 'Aucun point'),
        field(ICONS.info, 'Règle', 'Premier à répondre juste : **1 point**. Une seule réponse par question.'),
      ],
    })],
    components: [
      row(question.choices.map((c, i) => gameButton('reponse', game, `${s.index}-${i}`, { label: truncate(c, 80), emoji: Q.CHOICE_EMOJIS[i], style: ButtonStyle.Secondary }))),
      row(abandonButton(game, 'Arrêter')),
    ],
  };
}

/** Pose la question courante : réponses remises à zéro, minuteur de 15 s. */
function askQuestion(client, game) {
  const service = games(client);
  const s = game.state;
  s.answered = new Set();
  s.deadline = Date.now() + service.questionMs;
  const index = s.index;
  service.timer(game, 'question', service.questionMs, () => questionTimeout(client, game, index));
}

/** Clôt la question courante (gagnant ou temps écoulé), puis passe à la suivante ou termine. */
function closeQuestion(client, game, winnerId) {
  const s = game.state;
  const question = s.questions[s.index];
  const answer = question.choices[question.answer];
  s.history.push({ answer, winner: winnerId ?? null });
  if (winnerId) {
    s.scores.set(winnerId, (s.scores.get(winnerId) ?? 0) + 1);
    s.notice = `✅ ${mention(winnerId)} a trouvé : **${answer}** (+1)`;
  } else {
    s.notice = `⌛ Temps écoulé ! La réponse était **${answer}**.`;
  }
  s.index += 1;
  if (s.index < s.questions.length) return askQuestion(client, game);
  return finishQuiz(client, game, { type: 'done' });
}

/** Fin du quiz : scores enregistrés (sauf arrêt anticipé), partie terminée. */
function finishQuiz(client, game, result) {
  const service = games(client);
  service.clearTimer(game, 'question');
  game.result = result;
  if (result.type === 'done') {
    const ranking = Q.finalRanking(game.state.scores);
    service.record(ranking.map((r) => ({ guildId: game.guildId, userId: r.userId, game: 'quiz', outcome: r.outcome, points: r.points })));
  }
  service.end(game);
}

/** Temps écoulé sur la question `index` (ignoré si elle est déjà close). */
async function questionTimeout(client, game, index) {
  if (game.ended || game.state.index !== index) return;
  closeQuestion(client, game, null);
  games(client).touch(game);
  await games(client).edit(game, render(game));
}

async function startQuiz(interaction, client) {
  const theme = interaction.options.getString('theme');
  if (theme && !Object.hasOwn(Q.THEMES, theme)) throw new UserError('Thème inconnu.');
  const rounds = Q.clampRounds(interaction.options.getInteger('manches') ?? Q.DEFAULT_ROUNDS);
  assertFree(client, interaction, 'quiz', 'c', [interaction.channelId]);
  await launch(interaction, client, {
    type: 'quiz',
    locks: [lockKey('quiz', 'c', interaction.channelId)],
    state: { theme, questions: Q.drawQuestions(theme, rounds), index: 0, scores: new Map(), answered: new Set(), history: [], notice: null, deadline: 0 },
    setup: (game) => askQuestion(client, game),
  });
}

// ======================================================================== devine

function devineView(game) {
  const s = game.state;
  const over = isOver(game);
  const [low, high] = D.range(s.secret, s.guesses);
  let outcome = null;
  if (game.status === 'expired') outcome = `${EXPIRED}\nLe nombre était **${s.secret}**.`;
  else if (game.result?.type === 'win') outcome = `🎉 Trouvé en **${s.guesses.length}** essai${s.guesses.length > 1 ? 's' : ''} ! **+${pts(game.result.points)}**`;
  else if (game.result?.type === 'abandon') outcome = `🏳️ Partie abandonnée : le nombre était **${s.secret}**.`;
  const arrow = (g) => (g < s.secret ? '⬆️' : g > s.secret ? '⬇️' : '🎯');
  return {
    embeds: [gameCard(game, {
      description: [
        `J'ai choisi un nombre entre **${D.MIN}** et **${D.MAX}**. À vous de le trouver !`,
        s.notice ? `\n${s.notice}` : null,
        outcome ? `\n${outcome}` : null,
        over ? null : subtext('« Proposer » ouvre un formulaire ; je réponds « plus » ou « moins ».'),
      ],
      fields: [
        field(ICONS.user, 'Joueur', mention(game.ownerId)),
        field(ICONS.count, 'Essais', `**${s.guesses.length}**`),
        field('🎯', over ? 'Nombre' : 'Intervalle', over ? `**${s.secret}**` : `${low} à ${high}`),
        s.guesses.length ? wide(ICONS.history, 'Propositions', s.guesses.slice(-20).map((g) => `${g} ${arrow(g)}`).join(' · ')) : null,
      ],
    })],
    components: over
      ? buttonRows(deleteButton(game.ownerId))
      : buttonRows(
        gameButton('proposer', game, null, { label: 'Proposer', emoji: '🎯', style: ButtonStyle.Primary }),
        abandonButton(game),
      ),
  };
}

function guessModal(game) {
  return new ModalBuilder()
    .setCustomId(`cmd:jeu:nombre:${game.id}`)
    .setTitle('Devine le nombre')
    .addComponents(row(new TextInputBuilder()
      .setCustomId('nombre')
      .setLabel(`Votre proposition (${D.MIN} à ${D.MAX})`)
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(3)
      .setRequired(true)
      .setPlaceholder('50')));
}

async function startDevine(interaction, client) {
  assertFree(client, interaction, 'devine', 'u', [interaction.user.id]);
  await launch(interaction, client, {
    type: 'devine',
    locks: [lockKey('devine', 'u', interaction.user.id)],
    state: { secret: D.secretNumber(), guesses: [], notice: null },
  });
}

// ======================================================================== commun

/**
 * Refus clair si un verrou est pris : « vous avez déjà une partie… », « @X a déjà… »,
 * « une partie est déjà en cours dans ce salon… » (avec un lien vers la carte).
 */
function assertFree(client, interaction, type, scope, ids, label = null) {
  const name = label ?? GAMES[type].label;
  for (const id of ids) {
    const holder = games(client).holder(lockKey(type, scope, id));
    if (!holder) continue;
    const link = messageLink(holder);
    const where = link ? ` : [voir la partie](${link})` : '';
    if (scope === 'c') throw new UserError(`Une partie de **${name}** est déjà en cours dans ce salon${where}. Attendez sa fin ou jouez dans un autre salon.`);
    if (id === interaction.user.id) throw new UserError(`Vous avez déjà une partie de **${name}** en cours${where}. Terminez-la ou abandonnez-la d'abord.`);
    throw new UserError(`${mention(id)} a déjà une partie de **${name}** en cours.`);
  }
}

/**
 * Crée la partie, prépare son état (`setup`) et publie sa carte. En cas d'échec de la
 * réponse, la partie est supprimée (aucun verrou fantôme).
 */
async function launch(interaction, client, { setup, ...opts }, extra = {}) {
  const service = games(client);
  const parentId = interaction.channel?.isThread?.() ? interaction.channel.parentId : null;
  const game = service.create({ ...opts, guildId: interaction.guildId, channelId: interaction.channelId, parentId, ownerId: interaction.user.id, view: render });
  try {
    setup?.(game);
    service.touch(game, interaction);
    const message = await interaction.reply({ ...render(game), ...extra, withResponse: true });
    if (message?.id) service.setMessage(game, message.id);
  } catch (err) {
    service.end(game);
    throw err;
  }
  return game;
}

/** Partie en cours de ce jeu, ou null. */
function liveGame(client, id, ...types) {
  const game = games(client).get(id);
  return game && types.includes(game.type) ? game : null;
}

/** Composants d'un message, tous désactivés (sauf 🗑️ et les liens), ou null s'il n'y a rien à désactiver. */
function disabledRows(message) {
  let changed = false;
  const rows = (message?.components ?? []).map((r) => {
    const json = typeof r?.toJSON === 'function' ? r.toJSON() : r;
    return {
      ...json,
      components: (json.components ?? []).map((c) => {
        if (c.disabled || c.style === ButtonStyle.Link || String(c.custom_id ?? '').startsWith('cmd:_:delete')) return c;
        changed = true;
        return { ...c, disabled: true };
      }),
    };
  });
  // Rien à désactiver (carte déjà figée) : aucune modification.
  return changed ? rows : null;
}

/** Bouton d'une partie disparue : carte désactivée, « partie terminée » en éphémère. */
async function gameOver(interaction) {
  const rows = disabledRows(interaction.message);
  if (rows && typeof interaction.update === 'function') await interaction.update({ components: rows }).catch(() => {});
  await interaction.reply({
    embeds: [status.note('Cette partie est terminée (finie, expirée ou interrompue par un redémarrage). Lancez-en une nouvelle avec `/jeu`.', 'Partie terminée')],
    ephemeral: true,
  });
}

// ======================================================================== classement

function boardView(client, guild, gameKey, page, ownerId, viewerId) {
  const repo = client.repositories.gameScores;
  const game = gameKey === ALL ? null : gameKey;
  const total = repo.count(guild.id, game);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
  const rows = repo.leaderboard(guild.id, game, PAGE_SIZE, p * PAGE_SIZE);
  const meta = game ? GAMES[game] : { label: 'Tous les jeux', emoji: '🎮' };
  const mine = viewerId ? repo.get(guild.id, viewerId, game) : null;
  const rank = mine ? repo.rank(guild.id, viewerId, game) : null;
  const line = (r, pos) => `${MEDALS[pos - 1] ?? `\`#${pos}\``} ${mention(r.user_id)} · **${pts(r.points)}** · ${r.wins} V · ${r.draws} N · ${r.losses} D`;
  const nav = pages > 1
    ? [
      actionButton({ command: 'jeu', action: 'page', args: [gameKey, Math.max(0, p - 1), ownerId], emoji: ICONS.back, disabled: p === 0 }),
      labelButton(`Page ${p + 1}/${pages}`),
      actionButton({ command: 'jeu', action: 'page', args: [gameKey, Math.min(pages - 1, p + 1), ownerId], emoji: ICONS.next, disabled: p === pages - 1 }),
    ]
    : [];
  return {
    embeds: [card({
      tone: 'gold',
      section: 'fun',
      icon: '🏆',
      title: `Classement des jeux · ${meta.label}`,
      description: [
        rows.length ? rows.map((r, i) => line(r, p * PAGE_SIZE + i + 1)).join('\n') : 'Personne n\'a encore marqué de points. Lancez une partie avec `/jeu` !',
        '',
        subtext('V : victoires · N : nuls · D : défaites'),
      ],
      fields: mine ? [wide('📍', 'Votre place', `**#${rank}** · ${pts(mine.points)} · ${mine.wins} V · ${mine.draws} N · ${mine.losses} D`)] : [],
      footer: `Page ${p + 1}/${pages} · ${total} joueur${total > 1 ? 's' : ''}`,
    })],
    components: [
      row(new StringSelectMenuBuilder()
        .setCustomId(`cmd:jeu:vue:${ownerId}`)
        .setPlaceholder('Choisir un jeu…')
        .addOptions([
          { label: 'Tous les jeux', value: ALL, emoji: '🎮', default: gameKey === ALL },
          ...Object.entries(GAMES).map(([key, g]) => ({ label: g.label, value: key, emoji: g.emoji, default: gameKey === key })),
        ])),
      ...buttonRows(...nav, deleteButton(ownerId)),
    ],
  };
}

const boardKey = (value) => (value === ALL || Object.hasOwn(GAMES, value ?? '') ? value : null);

// ======================================================================== commande

const DUEL_OPPONENT = (o) => o.setName('adversaire').setDescription('Membre à défier (sans adversaire : contre moi)');

module.exports = {
  category: 'fun',
  // Les cartes de partie gèrent elles-mêmes 🗑️ (ajouté en fin de partie).
  autoDelete: false,
  GAMES,
  DUEL_POINTS,
  render,
  boardView,
  disabledRows,
  data: new SlashCommandBuilder()
    .setName('jeu')
    .setDescription('Mini-jeux : morpion, puissance 4, pendu, quiz, devine le nombre et classement.')
    .addSubcommand((s) => s.setName('morpion').setDescription('Partie de morpion contre un membre ou contre moi.').addUserOption(DUEL_OPPONENT))
    .addSubcommand((s) => s.setName('puissance4').setDescription('Partie de puissance 4 contre un membre ou contre moi.').addUserOption(DUEL_OPPONENT))
    .addSubcommand((s) =>
      s.setName('pendu').setDescription('Trouvez le mot avant d\'être pendu (6 erreurs maximum).').addStringOption((o) =>
        o.setName('mode').setDescription('Solo (vous seul) ou salon (tout le monde propose des lettres)').addChoices(
          { name: 'Solo', value: 'solo' },
          { name: 'Salon', value: 'salon' },
        )))
    .addSubcommand((s) =>
      s.setName('quiz').setDescription('Quiz ouvert à tout le salon : 15 s par question, le plus rapide marque.')
        .addStringOption((o) => o.setName('theme').setDescription('Thème des questions (par défaut : tous)').addChoices(
          ...Object.entries(Q.THEMES).map(([value, t]) => ({ name: t.label, value })),
        ))
        .addIntegerOption((o) => o.setName('manches').setDescription(`Nombre de questions (${Q.MIN_ROUNDS} à ${Q.MAX_ROUNDS}, ${Q.DEFAULT_ROUNDS} par défaut)`).setMinValue(Q.MIN_ROUNDS).setMaxValue(Q.MAX_ROUNDS)))
    .addSubcommand((s) => s.setName('devine').setDescription('Devinez le nombre (1 à 100) que j\'ai choisi.'))
    .addSubcommand((s) =>
      s.setName('classement').setDescription('Classement des mini-jeux du serveur.').addStringOption((o) =>
        o.setName('jeu').setDescription('Jeu (par défaut : tous les jeux)').addChoices(
          ...Object.entries(GAMES).map(([value, g]) => ({ name: g.label, value })),
        ))),

  async execute(interaction, client) {
    switch (interaction.options.getSubcommand()) {
      case 'morpion':
        return startDuel(interaction, client, 'morpion');
      case 'puissance4':
        return startDuel(interaction, client, 'puissance4');
      case 'pendu':
        return startPendu(interaction, client);
      case 'quiz':
        return startQuiz(interaction, client);
      case 'devine':
        return startDevine(interaction, client);
      case 'classement': {
        const key = boardKey(interaction.options.getString('jeu') ?? ALL) ?? ALL;
        return interaction.reply(boardView(client, interaction.guild, key, 0, interaction.user.id, interaction.user.id));
      }
      default:
        throw new UserError('Sous-commande inconnue.');
    }
  },

  buttons: {
    // ------------------------------------------------------------ défis (morpion, puissance 4)

    /** cmd:jeu:accepter:<partieId> — l'adversaire accepte le défi. */
    async accepter(interaction, client, [id]) {
      const game = liveGame(client, id, 'morpion', 'puissance4');
      if (!game) return gameOver(interaction);
      if (game.status !== 'pending') throw new UserError('Ce défi a déjà été accepté.');
      if (interaction.user.id !== game.players[1]) throw new UserError(`Seul(e) ${mention(game.players[1])} peut accepter ce défi.`);
      games(client).clearTimer(game, 'invite');
      beginDuel(game);
      games(client).touch(game, interaction);
      await interaction.update(render(game));
    },
    /** cmd:jeu:refuser:<partieId> — l'adversaire décline le défi. */
    async refuser(interaction, client, [id]) {
      const game = liveGame(client, id, 'morpion', 'puissance4');
      if (!game) return gameOver(interaction);
      if (game.status !== 'pending') throw new UserError('Ce défi a déjà commencé : utilisez « Abandonner ».');
      if (interaction.user.id !== game.players[1]) {
        throw new UserError(interaction.user.id === game.ownerId ? 'Pour retirer votre défi, utilisez « Annuler ».' : 'Ce défi ne vous est pas adressé.');
      }
      game.result = { type: 'declined' };
      games(client).end(game);
      await interaction.update(render(game));
    },
    /** cmd:jeu:jouer:<partieId>:<case 0-8> — coup au morpion. */
    async jouer(interaction, client, [id, cell]) {
      const game = liveGame(client, id, 'morpion');
      if (!game) return gameOver(interaction);
      assertTurn(game, interaction.user.id);
      if (!/^[0-8]$/.test(cell ?? '')) throw new UserError('Case invalide.');
      const s = game.state;
      const index = Number(cell);
      if (s.board[index] !== T.EMPTY) throw new UserError('Cette case est déjà prise.');
      s.board[index] = s.marks[interaction.user.id];
      s.turn = opponentOf(game, interaction.user.id);
      if (!settleDuel(client, game) && s.vsBot) {
        botTurn(game);
        settleDuel(client, game);
      }
      games(client).touch(game, interaction);
      await interaction.update(render(game));
    },
    /** cmd:jeu:colonne:<partieId> (menu, valeur 1-7) — coup au puissance 4. */
    async colonne(interaction, client, [id]) {
      const game = liveGame(client, id, 'puissance4');
      if (!game) return gameOver(interaction);
      assertTurn(game, interaction.user.id);
      const raw = interaction.values?.[0] ?? '';
      const col = /^[1-7]$/.test(raw) ? Number(raw) - 1 : -1;
      const s = game.state;
      if (!P4.canPlay(s.board, col)) throw new UserError('Cette colonne est pleine ou invalide.');
      const mark = s.marks[interaction.user.id];
      s.last = { col, row: P4.drop(s.board, col, mark), mark };
      s.turn = opponentOf(game, interaction.user.id);
      if (!settleDuel(client, game) && s.vsBot) {
        botTurn(game);
        settleDuel(client, game);
      }
      games(client).touch(game, interaction);
      await interaction.update(render(game));
    },

    // ------------------------------------------------------------ pendu

    /** cmd:jeu:lettre:<partieId>:<am|nz> (menu, valeur A-Z) — lettre proposée. */
    async lettre(interaction, client, [id, half]) {
      const game = liveGame(client, id, 'pendu');
      if (!game) return gameOver(interaction);
      const s = game.state;
      const userId = interaction.user.id;
      if (s.mode !== 'salon' && userId !== game.ownerId) {
        throw new UserError(`Cette partie de pendu est réservée à ${mention(game.ownerId)}. Lancez la vôtre avec \`/jeu pendu\`.`);
      }
      const letter = interaction.values?.[0];
      const pool = half === 'nz' ? H.SECOND_HALF : H.FIRST_HALF;
      if (!H.isLetter(letter) || !pool.includes(letter)) throw new UserError('Lettre invalide.');
      if (s.guessed.has(letter)) throw new UserError(`La lettre **${letter}** a déjà été proposée.`);
      s.guessed.add(letter);
      const hits = [...s.word.plain].filter((l) => l === letter).length;
      s.notice = hits
        ? `✅ ${mention(userId)} : **${letter}** apparaît ${hits === 1 ? 'une fois' : `${hits} fois`} !`
        : `✖️ ${mention(userId)} : pas de **${letter}** dans le mot.`;
      const errors = H.errorCount(s.word, s.guessed);
      if (H.isSolved(s.word, s.guessed)) {
        game.result = { type: 'win', winner: userId, points: H.winPoints(errors) };
        games(client).record([{ guildId: game.guildId, userId, game: 'pendu', outcome: 'win', points: game.result.points }]);
        games(client).end(game);
      } else if (errors >= H.MAX_ERRORS) {
        game.result = { type: 'loss' };
        // En salon, personne ne perd seul : seule une partie solo compte une défaite.
        if (s.mode !== 'salon') games(client).record([{ guildId: game.guildId, userId: game.ownerId, game: 'pendu', outcome: 'loss', points: 0 }]);
        games(client).end(game);
      }
      games(client).touch(game, interaction);
      await interaction.update(render(game));
    },

    // ------------------------------------------------------------ quiz

    /** cmd:jeu:reponse:<partieId>:<question>-<choix> — réponse au quiz (une par joueur et par question). */
    async reponse(interaction, client, [id, move]) {
      const game = liveGame(client, id, 'quiz');
      if (!game) return gameOver(interaction);
      const s = game.state;
      const m = /^(\d{1,2})-([0-3])$/.exec(move ?? '');
      if (!m) throw new UserError('Réponse invalide.');
      if (Number(m[1]) !== s.index) throw new UserError('Cette question est terminée : répondez à la question affichée.');
      const userId = interaction.user.id;
      if (s.answered.has(userId)) throw new UserError('Vous avez déjà répondu à cette question : attendez la suivante.');
      s.answered.add(userId);
      if (!s.scores.has(userId)) s.scores.set(userId, 0);
      const correct = Number(m[2]) === s.questions[s.index].answer;
      if (correct) closeQuestion(client, game, userId);
      games(client).touch(game, interaction);
      await interaction.update(render(game));
      if (!correct) {
        await interaction.followUp({ embeds: [status.warn('Mauvaise réponse ! Vous pourrez retenter votre chance à la prochaine question.')], ephemeral: true });
      }
    },

    // ------------------------------------------------------------ devine

    /** cmd:jeu:proposer:<partieId> — ouvre le formulaire de proposition. */
    async proposer(interaction, client, [id]) {
      const game = liveGame(client, id, 'devine');
      if (!game) return gameOver(interaction);
      if (interaction.user.id !== game.ownerId) throw new UserError(`Cette partie est réservée à ${mention(game.ownerId)}. Lancez la vôtre avec \`/jeu devine\`.`);
      games(client).touch(game);
      await interaction.showModal(guessModal(game));
    },
    /** cmd:jeu:nombre:<partieId> — formulaire envoyé : plus, moins ou trouvé. */
    async nombre(interaction, client, [id]) {
      const game = liveGame(client, id, 'devine');
      if (!game) return gameOver(interaction);
      if (interaction.user.id !== game.ownerId) throw new UserError('Cette partie ne vous appartient pas.');
      let raw = '';
      try {
        raw = interaction.fields.getTextInputValue('nombre');
      } catch {
        raw = '';
      }
      const guess = D.parseGuess(raw);
      if (guess == null) throw new UserError(`Entrez un nombre entier entre ${D.MIN} et ${D.MAX}.`);
      const s = game.state;
      s.guesses.push(guess);
      const c = D.compare(s.secret, guess);
      s.notice = c > 0 ? `📈 **${guess}** : c'est plus !` : c < 0 ? `📉 **${guess}** : c'est moins !` : `🎯 **${guess}** : c'est gagné !`;
      if (c === 0) {
        game.result = { type: 'win', points: D.winPoints(s.guesses.length) };
        games(client).record([{ guildId: game.guildId, userId: game.ownerId, game: 'devine', outcome: 'win', points: game.result.points }]);
        games(client).end(game);
      }
      games(client).touch(game, interaction);
      await interaction.update(render(game));
    },

    // ------------------------------------------------------------ commun

    /** cmd:jeu:abandon:<partieId> — abandon (duel, pendu, devine), annulation d'un défi ou arrêt (quiz, pendu en salon). */
    async abandon(interaction, client, [id]) {
      const game = liveGame(client, id, ...Object.keys(GAMES));
      if (!game) return gameOver(interaction);
      const service = games(client);
      const userId = interaction.user.id;
      switch (game.type) {
        case 'morpion':
        case 'puissance4': {
          assertPlayer(game, userId);
          if (game.status === 'pending') {
            game.result = { type: userId === game.ownerId ? 'cancelled' : 'declined' };
          } else {
            const winner = opponentOf(game, userId);
            game.result = { type: 'abandon', loser: userId, winner };
            recordDuel(client, game, winner);
          }
          break;
        }
        case 'pendu': {
          const salon = game.state.mode === 'salon';
          if (userId !== game.ownerId && !(salon && isMod(interaction))) {
            throw new UserError(salon ? 'Seuls la personne qui a lancé la partie et les modérateurs peuvent l\'arrêter.' : 'Seule la personne qui joue peut abandonner.');
          }
          game.result = { type: 'abandon' };
          if (!salon) service.record([{ guildId: game.guildId, userId, game: 'pendu', outcome: 'loss', points: 0 }]);
          break;
        }
        case 'quiz': {
          if (userId !== game.ownerId && !isMod(interaction)) throw new UserError('Seuls la personne qui a lancé le quiz et les modérateurs peuvent l\'arrêter.');
          finishQuiz(client, game, { type: 'stopped', by: userId });
          break;
        }
        default: {
          if (userId !== game.ownerId) throw new UserError('Seule la personne qui joue peut abandonner.');
          game.result = { type: 'abandon' };
          service.record([{ guildId: game.guildId, userId, game: 'devine', outcome: 'loss', points: 0 }]);
        }
      }
      service.end(game);
      await interaction.update(render(game));
    },

    // ------------------------------------------------------------ classement

    /** cmd:jeu:vue:<auteur> (menu) — jeu affiché par le classement (public : tout le monde peut changer). */
    async vue(interaction, client, [ownerId]) {
      if (!SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce menu est invalide.');
      const key = boardKey(interaction.values?.[0]);
      if (!key) throw new UserError('Jeu inconnu.');
      await interaction.update(boardView(client, interaction.guild, key, 0, ownerId, interaction.user.id));
    },
    /** cmd:jeu:page:<jeu|tous>:<page>:<auteur> — pagination du classement. */
    async page(interaction, client, [key, page, ownerId]) {
      if (!boardKey(key) || !/^\d{1,5}$/.test(page ?? '') || !SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.update(boardView(client, interaction.guild, key, Number(page), ownerId, interaction.user.id));
    },
  },
};
