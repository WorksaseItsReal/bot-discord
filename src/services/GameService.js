'use strict';

const { randomBytes } = require('node:crypto');
const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');

const logger = createLogger('games');

/** Une partie sans action pendant 10 minutes est terminée (carte désactivée). */
const TTL_MS = 10 * 60_000;
/** Fréquence du nettoyage des parties inactives. */
const SWEEP_MS = 60_000;
/** Délai laissé à l'adversaire pour accepter un défi. */
const INVITE_MS = 60_000;
/** Temps de réponse d'une question de quiz. */
const QUESTION_MS = 15_000;
/** Bornes de la mémoire : parties simultanées, au total et par serveur. */
const MAX_GAMES = 500;
const MAX_GAMES_PER_GUILD = 50;
/** Identifiant de partie : 8 caractères base 36 (sûr dans un customId). */
const GAME_ID = /^[a-z0-9]{8}$/;

/**
 * Parties de mini-jeux (/jeu) EN MÉMOIRE : rien n'est rejoué après un redémarrage
 * (les boutons d'une partie disparue répondent « partie terminée »). Seuls les
 * résultats sont écrits en base (GameScoreRepository, migration 24).
 *
 *  - Map bornée (MAX_GAMES, MAX_GAMES_PER_GUILD) ;
 *  - verrous : une partie par joueur (« morpion:u:<id> ») ou par salon (« quiz:c:<id> ») ;
 *  - expiration après 10 min d'inactivité : nettoyage périodique (minuteur unref, actif
 *    seulement tant qu'il reste des parties) qui désactive la carte via la dernière
 *    interaction (jeton valable 15 min) ;
 *  - minuteurs par partie (acceptation d'un défi, question de quiz), unref, annulés à la
 *    fin de la partie et à l'arrêt du bot (stop()).
 */
class GameService {
  /**
   * @param {{ client?: import('discord.js').Client, scores?: import('../database/repositories/GameScoreRepository').GameScoreRepository,
   *   ttlMs?: number, sweepMs?: number, inviteMs?: number, questionMs?: number, maxGames?: number, maxPerGuild?: number }} deps
   */
  constructor({ client = null, scores = null, ttlMs = TTL_MS, sweepMs = SWEEP_MS, inviteMs = INVITE_MS, questionMs = QUESTION_MS, maxGames = MAX_GAMES, maxPerGuild = MAX_GAMES_PER_GUILD } = {}) {
    this.client = client;
    this.scores = scores;
    this.ttlMs = ttlMs;
    this.sweepMs = sweepMs;
    this.inviteMs = inviteMs;
    this.questionMs = questionMs;
    this.maxGames = maxGames;
    this.maxPerGuild = maxPerGuild;
    /** @type {Map<string, object>} partieId → partie */
    this.games = new Map();
    /** @type {Map<string, string>} verrou → partieId */
    this.locks = new Map();
    /** @type {Map<string, string>} messageId → partieId */
    this.messages = new Map();
    this.sweeper = null;
    this.stopping = false;
  }

  /**
   * Crée une partie (verrous pris de façon synchrone : deux commandes simultanées ne
   * peuvent pas ouvrir deux parties sur le même verrou).
   * @param {{ type: string, guildId: string, channelId: string, ownerId: string, players?: string[],
   *   locks?: string[], state?: object, status?: string, view?: (game: object) => object }} opts
   */
  create({ type, guildId, channelId, parentId = null, ownerId, players = [ownerId], locks = [], state = {}, status = 'playing', view = null }) {
    if (this.stopping) throw new UserError('Le bot redémarre : réessayez dans un instant.');
    for (const key of locks) {
      if (this.holder(key)) throw new UserError('Une partie est déjà en cours : terminez-la d\'abord.');
    }
    if (this.games.size >= this.maxGames) throw new UserError('Trop de parties sont en cours en ce moment : réessayez dans quelques minutes.');
    if (this.count(guildId) >= this.maxPerGuild) throw new UserError(`Trop de parties sont en cours sur ce serveur (${this.maxPerGuild} au maximum) : terminez-en une d'abord.`);
    const now = Date.now();
    const game = {
      id: this.#newId(),
      type,
      guildId,
      channelId,
      parentId,
      ownerId,
      players,
      locks: [...locks],
      state,
      status,
      result: null,
      view,
      createdAt: now,
      updatedAt: now,
      messageId: null,
      interaction: null,
      timers: new Map(),
      ended: false,
    };
    this.games.set(game.id, game);
    for (const key of game.locks) this.locks.set(key, game.id);
    this.#startSweeper();
    return game;
  }

  /** Partie qui détient un verrou (null si libre ; une partie inactive est expirée au passage). */
  holder(key) {
    const id = this.locks.get(key);
    if (!id) return null;
    const game = this.games.get(id);
    if (!game) {
      this.locks.delete(key);
      return null;
    }
    if (this.#isStale(game)) {
      this.expire(game);
      return null;
    }
    return game;
  }

  /** Partie en cours, ou null (inconnue, terminée, expirée ou identifiant invalide). */
  get(id) {
    if (typeof id !== 'string' || !GAME_ID.test(id)) return null;
    const game = this.games.get(id);
    if (!game) return null;
    if (this.#isStale(game)) {
      // Le clic qui la découvre désactive lui-même la carte : pas d'édition concurrente.
      this.expire(game, { edit: false });
      return null;
    }
    return game;
  }

  /** Nombre de parties en cours (sur un serveur, ou au total). */
  count(guildId = null) {
    if (guildId == null) return this.games.size;
    let n = 0;
    for (const g of this.games.values()) if (g.guildId === guildId) n += 1;
    return n;
  }

  /** Activité : repousse l'expiration et retient la dernière interaction (pour éditer la carte). */
  touch(game, interaction = null) {
    if (game.ended) return;
    game.updatedAt = Date.now();
    if (interaction) {
      game.interaction = interaction;
      const messageId = interaction.message?.id;
      if (messageId) this.setMessage(game, messageId);
    }
  }

  /** Message qui porte la carte de la partie (suppression du message → fin de partie). */
  setMessage(game, messageId) {
    if (!messageId || game.ended) return;
    if (game.messageId && this.messages.get(game.messageId) === game.id) this.messages.delete(game.messageId);
    game.messageId = messageId;
    this.messages.set(messageId, game.id);
  }

  /** Termine une partie : verrous libérés, minuteurs annulés. @returns {boolean} false si déjà terminée */
  end(game) {
    if (!game || game.ended) return false;
    game.ended = true;
    if (game.status === 'playing' || game.status === 'pending') game.status = 'over';
    this.games.delete(game.id);
    for (const key of game.locks) if (this.locks.get(key) === game.id) this.locks.delete(key);
    if (game.messageId && this.messages.get(game.messageId) === game.id) this.messages.delete(game.messageId);
    for (const t of game.timers.values()) clearTimeout(t);
    game.timers.clear();
    if (!this.games.size) this.#stopSweeper();
    return true;
  }

  /** Expire une partie inactive et (par défaut) désactive sa carte. */
  expire(game, { edit = true } = {}) {
    if (!this.end(game)) return;
    game.status = 'expired';
    if (!edit || typeof game.view !== 'function') return;
    let payload = null;
    try {
      payload = game.view(game);
    } catch (err) {
      logger.warn(`Rendu de la partie expirée ${game.id} :`, err?.message);
    }
    if (payload) this.edit(game, payload);
  }

  /**
   * Modifie la carte via la dernière interaction de la partie (aucune permission de salon
   * requise). Ne lève jamais. @returns {Promise<boolean>}
   */
  async edit(game, payload) {
    const interaction = game.interaction;
    if (!interaction || this.stopping) return false;
    try {
      await interaction.editReply(payload);
      return true;
    } catch (err) {
      logger.debug(`Carte de la partie ${game.id} non modifiée :`, err?.message);
      return false;
    }
  }

  /** Minuteur nommé d'une partie (remplace le précédent du même nom). unref, ignoré après la fin. */
  timer(game, name, ms, fn) {
    this.clearTimer(game, name);
    if (game.ended || this.stopping) return;
    const t = setTimeout(() => {
      if (game.timers.get(name) !== t) return;
      game.timers.delete(name);
      if (game.ended || this.stopping) return;
      Promise.resolve()
        .then(fn)
        .catch((err) => logger.error(`Minuteur « ${name} » de la partie ${game.id} :`, err));
    }, ms);
    t.unref?.();
    game.timers.set(name, t);
  }

  clearTimer(game, name) {
    const t = game.timers.get(name);
    if (t) clearTimeout(t);
    game.timers.delete(name);
  }

  /** Expire les parties inactives depuis plus de `ttlMs`. @returns {number} parties expirées */
  sweep(now = Date.now()) {
    let n = 0;
    for (const game of [...this.games.values()]) {
      if (now - game.updatedAt > this.ttlMs) {
        this.expire(game);
        n += 1;
      }
    }
    return n;
  }

  /** Message de la carte supprimé : la partie s'arrête (verrous libérés). */
  endByMessage(messageId) {
    const id = messageId && this.messages.get(messageId);
    const game = id && this.games.get(id);
    return game ? this.end(game) : false;
  }

  /** Salon ou fil supprimé : ses parties (et celles de ses fils) s'arrêtent. @returns {number} */
  endByChannel(channelId) {
    if (!channelId) return 0;
    let n = 0;
    for (const game of [...this.games.values()]) if ((game.channelId === channelId || game.parentId === channelId) && this.end(game)) n += 1;
    return n;
  }

  /**
   * Enregistre des résultats (le bot lui-même n'est jamais classé). Ne lève jamais.
   * @param {{ guildId: string, userId: string, game: string, outcome: 'win'|'loss'|'draw', points?: number }[]} entries
   */
  record(entries) {
    if (this.stopping || !this.scores) return 0;
    const botId = this.client?.user?.id;
    try {
      return this.scores.record(entries.filter((e) => e && e.userId !== botId));
    } catch (err) {
      logger.warn('Enregistrement des scores de jeu :', err?.message);
      return 0;
    }
  }

  /** Arrêt du bot : nettoyage et minuteurs annulés, parties oubliées. */
  stop() {
    this.stopping = true;
    this.#stopSweeper();
    for (const game of this.games.values()) {
      for (const t of game.timers.values()) clearTimeout(t);
      game.timers.clear();
      game.ended = true;
    }
    this.games.clear();
    this.locks.clear();
    this.messages.clear();
  }

  #isStale(game, now = Date.now()) {
    return now - game.updatedAt > this.ttlMs;
  }

  #newId() {
    let id;
    do id = BigInt(`0x${randomBytes(6).toString('hex')}`).toString(36).padStart(8, '0').slice(-8);
    while (this.games.has(id));
    return id;
  }

  #startSweeper() {
    if (this.sweeper || this.stopping) return;
    this.sweeper = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        logger.error('Nettoyage des parties :', err);
      }
    }, this.sweepMs);
    this.sweeper.unref?.();
  }

  #stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

module.exports = { GameService, GAME_ID, TTL_MS, SWEEP_MS, INVITE_MS, QUESTION_MS, MAX_GAMES, MAX_GAMES_PER_GUILD };
