'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { createLogger } = require('../core/logger');

const logger = createLogger('invites');

const DAY_MS = 86_400_000;
/** Une invitation supprimée reste candidate ce temps-là (INVITE_DELETE reçu avant GUILD_MEMBER_ADD). */
const DELETED_GRACE_MS = 15_000;
/** Attente maximale de l'attribution par le log d'arrivée (events/guildMemberAdd.js). */
const LOG_WAIT_MS = 2_000;

/**
 * Suivi des invitations : cache des invitations de chaque serveur (compteurs `uses`),
 * comparé à chaque arrivée pour retrouver l'invitation utilisée.
 *
 * Cas gérés : lien personnalisé (vanity), invitation à usage limité supprimée par Discord
 * au moment de l'arrivée, invitation inconnue, plusieurs candidates (→ inconnue), bot ajouté
 * par OAuth2. Sans la permission « Gérer le serveur », le suivi se désactive proprement
 * (l'arrivée est enregistrée comme « inconnue »).
 *
 * Les traitements d'un même serveur sont sérialisés : deux arrivées simultanées ne
 * comparent jamais leurs instantanés en même temps. Les arrivées qui attendent dans la file
 * partagent UNE lecture des invitations (rafale, raid) : le nombre d'appels à Discord ne
 * croît pas avec le nombre d'arrivées.
 */
class InviteTrackerService {
  /**
   * @param {{ client: import('discord.js').Client, joins: import('../database/repositories/InviteJoinRepository').InviteJoinRepository, config: import('./ConfigService').ConfigService }} deps
   */
  constructor({ client, joins, config }) {
    this.client = client;
    this.joins = joins;
    this.config = config;
    /** @type {Map<string, Map<string, InviteEntry>>} instantané par serveur */
    this.snapshots = new Map();
    /** @type {Map<string, number|null>} utilisations du lien personnalisé */
    this.vanity = new Map();
    /** @type {Map<string, Map<string, { entry: InviteEntry, at: number }>>} invitations supprimées récemment */
    this.deleted = new Map();
    /** @type {Map<string, 'ok'|'noperm'|'error'>} */
    this.states = new Map();
    /** @type {Map<string, Promise<unknown>>} file d'attente par serveur */
    this.queues = new Map();
    /** @type {Map<string, { members: object[], promise: Promise<Map<string, JoinResult>> }>} arrivées en attente d'une lecture */
    this.waiting = new Map();
    /** Attente maximale de l'attribution par le log d'arrivée (ms). */
    this.logWaitMs = LOG_WAIT_MS;
  }

  /** Le bot peut-il lire les invitations du serveur ? */
  static canRead(guild) {
    return guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
  }

  /** État du suivi : ok · noperm (permission manquante) · error (lecture impossible) · unknown (pas encore lu). */
  state(guild) {
    if (!InviteTrackerService.canRead(guild)) return 'noperm';
    return this.states.get(guild.id) ?? 'unknown';
  }

  /** Exécute `fn` après les traitements en cours du même serveur. */
  #enqueue(guildId, fn) {
    const previous = this.queues.get(guildId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    this.queues.set(guildId, tail);
    tail.then(() => {
      if (this.queues.get(guildId) === tail) this.queues.delete(guildId);
    });
    return run;
  }

  /** Lit les invitations du serveur depuis Discord. @returns {Promise<Map<string, InviteEntry>|null>} */
  async #fetch(guild) {
    if (!InviteTrackerService.canRead(guild)) {
      this.states.set(guild.id, 'noperm');
      this.snapshots.delete(guild.id);
      return null;
    }
    try {
      const invites = await guild.invites.fetch({ cache: false });
      const map = new Map();
      for (const invite of invites.values()) map.set(invite.code, toEntry(invite));
      if (guild.vanityURLCode) {
        const data = await guild.fetchVanityData().catch(() => null);
        this.vanity.set(guild.id, Number.isFinite(data?.uses) ? data.uses : null);
      } else this.vanity.delete(guild.id);
      this.states.set(guild.id, 'ok');
      return map;
    } catch (err) {
      // 50013 Missing Permissions : permission retirée entre-temps.
      this.states.set(guild.id, err?.code === 50013 ? 'noperm' : 'error');
      logger.debug(`Lecture des invitations impossible sur ${guild.id} :`, err?.message);
      return null;
    }
  }

  /** (Re)construit le cache d'un serveur. */
  refresh(guild) {
    return this.#enqueue(guild.id, async () => {
      const map = await this.#fetch(guild);
      if (map) this.snapshots.set(guild.id, map);
      return map;
    });
  }

  /** Cache initial de tous les serveurs (au démarrage), un serveur à la fois. */
  async refreshAll() {
    for (const guild of this.client.guilds.cache.values()) {
      if (!guild.available) continue;
      await this.refresh(guild).catch(() => {});
    }
  }

  /** Oublie un serveur quitté. */
  forget(guildId) {
    this.snapshots.delete(guildId);
    this.vanity.delete(guildId);
    this.deleted.delete(guildId);
    this.states.delete(guildId);
  }

  /** INVITE_CREATE : ajout au cache (0 utilisation). */
  onCreate(invite) {
    const guildId = invite.guild?.id;
    const map = guildId && this.snapshots.get(guildId);
    if (map) map.set(invite.code, toEntry(invite));
  }

  /** INVITE_DELETE : retirée du cache, mais gardée quelques secondes comme candidate. */
  onDelete(invite) {
    const guildId = invite.guild?.id;
    const map = guildId && this.snapshots.get(guildId);
    if (!map) return;
    const entry = map.get(invite.code);
    map.delete(invite.code);
    if (!entry) return;
    const bucket = this.deleted.get(guildId) ?? new Map();
    bucket.set(invite.code, { entry, at: Date.now() });
    this.deleted.set(guildId, bucket);
  }

  /** Invitations actives (cache) créées par un membre. @returns {InviteEntry[]} */
  invitesOf(guildId, userId) {
    const map = this.snapshots.get(guildId);
    if (!map) return [];
    const now = Date.now();
    return [...map.values()]
      .filter((e) => e.inviterId === userId && (!e.expiresAt || e.expiresAt > now))
      .sort((a, b) => b.uses - a.uses);
  }

  /** Le cache d'un serveur existe-t-il ? */
  hasSnapshot(guildId) {
    return this.snapshots.has(guildId);
  }

  /** Seuil (jours) d'un compte « faux ». */
  fakeDays(guildId) {
    const days = Number(this.config.get(guildId).invites?.fakeAccountDays);
    return Number.isFinite(days) && days >= 0 ? days : 7;
  }

  /**
   * Arrivée d'un membre : retrouve l'invitation utilisée et enregistre l'arrivée.
   * Les arrivées en attente dans la file du serveur sont regroupées : une seule lecture
   * des invitations pour toutes (voir #processBatch).
   * @returns {Promise<JoinResult>}
   */
  handleJoin(member) {
    if (member.user?.bot) return Promise.resolve({ kind: 'oauth' });
    const guild = member.guild;
    let batch = this.waiting.get(guild.id);
    if (!batch) {
      batch = { members: [], promise: null };
      this.waiting.set(guild.id, batch);
      const current = batch;
      // Le lot est fermé au DÉBUT de son traitement : les arrivées suivantes forment le prochain.
      current.promise = this.#enqueue(guild.id, () => {
        if (this.waiting.get(guild.id) === current) this.waiting.delete(guild.id);
        return this.#processBatch(guild, current.members);
      });
    }
    batch.members.push(member);
    return batch.promise.then((results) => results.get(member.id));
  }

  /** Une lecture des invitations pour un lot d'arrivées. @returns {Promise<Map<string, JoinResult>>} */
  async #processBatch(guild, members) {
    const before = this.snapshots.get(guild.id) ?? null;
    const vanityBefore = this.vanity.get(guild.id);
    const after = await this.#fetch(guild);
    if (after) this.snapshots.set(guild.id, after);

    let result;
    if (!after) result = { kind: 'unknown', reason: this.states.get(guild.id) === 'noperm' ? 'noperm' : 'error' };
    else if (!before) result = { kind: 'unknown', reason: 'nobaseline' };
    else result = this.#resolve(guild, before, after, vanityBefore, members.length);

    const days = this.fakeDays(guild.id);
    const results = new Map();
    for (const member of members) {
      const created = member.user?.createdTimestamp ?? Date.now();
      const fake = days > 0 && Date.now() - created < days * DAY_MS;
      try {
        this.joins.recordJoin({
          guildId: guild.id,
          userId: member.id,
          inviterId: result.inviterId ?? null,
          code: result.kind === 'vanity' ? 'vanity' : result.code ?? null,
          fake,
        });
      } catch (err) {
        logger.warn(`Arrivée non enregistrée (${guild.id}/${member.id}) :`, err?.message);
      }
      let count = null;
      try {
        count = result.inviterId ? this.joins.stats(guild.id, result.inviterId).net : null;
      } catch (err) {
        logger.debug('stats', err?.message);
      }
      results.set(member.id, { ...result, fake, fakeDays: days, count });
    }
    return results;
  }

  /**
   * Comparaison de deux instantanés (pur, hors effets de bord du cache des supprimées).
   * @param {number} [arrivals] arrivées du lot : attribuées ensemble seulement si une seule
   *   source a servi, et au moins autant de fois qu'il y a d'arrivées
   */
  #resolve(guild, before, after, vanityBefore, arrivals = 1) {
    const candidates = [];
    for (const [code, now] of after) {
      const old = before.get(code);
      // Invitation absente de l'ancien instantané (INVITE_CREATE manqué) : candidate si utilisée.
      const delta = now.uses - (old?.uses ?? 0);
      if (delta > 0) candidates.push({ ...now, delta });
    }
    // Invitation à usage limité supprimée par Discord en atteignant son maximum.
    for (const [code, old] of before) {
      if (!after.has(code) && exhausted(old)) candidates.push({ ...old, uses: old.uses + 1, delta: 1 });
    }
    const bucket = this.deleted.get(guild.id);
    if (bucket) {
      const now = Date.now();
      for (const [code, { entry, at }] of bucket) {
        if (now - at > DELETED_GRACE_MS) bucket.delete(code);
        else if (!after.has(code) && !before.has(code) && exhausted(entry)) {
          candidates.push({ ...entry, uses: entry.uses + 1, delta: 1 });
          bucket.delete(code);
        }
      }
      if (!bucket.size) this.deleted.delete(guild.id);
    }
    const vanityAfter = this.vanity.get(guild.id);
    const vanityUsed = Number.isFinite(vanityBefore) && Number.isFinite(vanityAfter) && vanityAfter > vanityBefore;

    const total = candidates.length + (vanityUsed ? 1 : 0);
    if (total > 1) return { kind: 'unknown', reason: 'multiple' };
    // Lot de plusieurs arrivées : une source utilisée moins de fois qu'il n'y a d'arrivées
    // n'explique pas toutes les arrivées (aucune attribution plutôt qu'une fausse).
    const used = vanityUsed ? vanityAfter - vanityBefore : candidates[0]?.delta ?? 0;
    if (total === 1 && arrivals > 1 && used < arrivals) return { kind: 'unknown', reason: 'multiple' };
    if (vanityUsed) return { kind: 'vanity', code: guild.vanityURLCode };
    if (candidates.length === 1) {
      const [c] = candidates;
      return { kind: 'invite', code: c.code, inviterId: c.inviterId ?? null };
    }
    return { kind: 'unknown', reason: 'none' };
  }

  /** Départ d'un membre : sa dernière arrivée est marquée « repartie ». */
  handleLeave(member) {
    try {
      return this.joins.markLeft(member.guild.id, member.id);
    } catch (err) {
      logger.debug('markLeft', err?.message);
      return false;
    }
  }
}

const plural = (n, word) => `${n} ${word}${Math.abs(n) > 1 ? 's' : ''}`;

/**
 * Ligne « invitation » du log d'arrivée (pur).
 * @param {JoinResult|null} result
 * @returns {string|null}
 */
function describeJoin(result) {
  if (!result) return null;
  let line;
  if (result.kind === 'invite') {
    line = result.inviterId
      ? `Invité par <@${result.inviterId}> via \`${result.code}\` (**${plural(result.count ?? 0, 'invitation')}**)`
      : `Via l'invitation \`${result.code}\` (créateur inconnu)`;
  } else if (result.kind === 'vanity') line = `Lien personnalisé${result.code ? ` \`discord.gg/${result.code}\`` : ''}`;
  else if (result.kind === 'oauth') line = 'Ajouté par OAuth2 (intégration autorisée par un administrateur)';
  else if (result.reason === 'multiple') line = 'Invitation inconnue (plusieurs invitations possibles)';
  else if (result.reason === 'noperm') line = 'Invitation inconnue : il me manque la permission **Gérer le serveur**';
  else if (result.reason === 'timeout') line = 'Invitation inconnue : lecture des invitations trop lente (arrivées nombreuses)';
  else line = 'Invitation inconnue';
  if (result.fake) line += `\n⚠️ Comptée comme **fausse** (compte de moins de ${plural(result.fakeDays ?? 7, 'jour')})`;
  return line;
}

/** Invitation au bord de son nombre maximal d'utilisations. */
function exhausted(entry) {
  return entry.maxUses > 0 && entry.uses + 1 >= entry.maxUses;
}

/**
 * @typedef {{ code: string, uses: number, maxUses: number, inviterId: string|null, channelId: string|null, expiresAt: number|null, temporary: boolean }} InviteEntry
 * @typedef {{ kind: 'invite'|'vanity'|'unknown'|'oauth', code?: string, inviterId?: string|null, reason?: string, fake?: boolean, fakeDays?: number, count?: number|null }} JoinResult
 */
function toEntry(invite) {
  return {
    code: invite.code,
    uses: Number(invite.uses ?? 0),
    maxUses: Number(invite.maxUses ?? 0),
    inviterId: invite.inviterId ?? invite.inviter?.id ?? null,
    channelId: invite.channelId ?? invite.channel?.id ?? null,
    expiresAt: invite.expiresTimestamp ?? null,
    temporary: Boolean(invite.temporary),
  };
}

module.exports = { InviteTrackerService, toEntry, describeJoin, DELETED_GRACE_MS, LOG_WAIT_MS };
