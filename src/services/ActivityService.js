'use strict';

const { createLogger } = require('../core/logger');
const { DAY_MS, dayKey, dayStart, addDays } = require('../utils/activity');

const logger = createLogger('activity');

/** Vidage du tampon mémoire vers la base. */
const FLUSH_INTERVAL_MS = 30_000;
/** Au-delà de ce nombre de clés en tampon, vidage immédiat (rafale exceptionnelle). */
const MAX_BUFFER_KEYS = 20_000;
/** Purge des statistiques expirées : une fois par jour. */
const PURGE_INTERVAL_MS = DAY_MS;
/** Rétention (jours) : bornes et valeur par défaut. */
const RETENTION = Object.freeze({ min: 7, max: 365, default: 90 });
/** Délai minimal entre deux MP « inactif » au même membre. */
const DM_GAP_MS = 7 * DAY_MS;
/** Les traces de MP plus anciennes ne servent plus à rien. */
const DM_KEEP_MS = 30 * DAY_MS;
/** Vues de /statistiques : résultats gardés 60 s (500 au plus), délai entre deux clics d'un membre. */
const VIEW_CACHE_TTL_MS = 60_000;
const VIEW_CACHE_MAX = 500;
const VIEW_COOLDOWN_MS = 5_000;
/** Battement de la collecte (dernier vidage) : écrit au plus toutes les 5 minutes. */
const HEARTBEAT_MS = 5 * 60_000;
/** Au-delà de cet écart entre deux battements, la collecte est considérée interrompue (trou). */
const GAP_MS = 6 * 3_600_000;

const newBuffer = () => ({ messages: new Map(), hours: new Map(), voice: new Map(), flows: new Map() });
const bufferSize = (b) => b.messages.size + b.hours.size + b.voice.size + b.flows.size;
const inc = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);

/** Rétention effective d'une configuration (7 à 365 jours, 90 par défaut). Pur. */
function retentionDays(stats) {
  const n = Math.floor(Number(stats?.retentionDays));
  if (!Number.isFinite(n)) return RETENTION.default;
  return Math.min(RETENTION.max, Math.max(RETENTION.min, n));
}

/** Salon (ou son parent, ou la catégorie de son parent) ignoré par les logs ? Pur. */
function isIgnoredChannel(channel, ignored = []) {
  if (!channel || !ignored?.length) return false;
  const set = new Set(ignored);
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && set.has(id));
}

/** Tampon → lot pour ActivityRepository#applyBatch. Pur. */
function toBatch(buffer) {
  const split = (key) => key.split('|');
  return {
    messages: [...buffer.messages].map(([k, count]) => {
      const [guildId, day, channelId, userId] = split(k);
      return { guildId, day, channelId, userId, count };
    }),
    voice: [...buffer.voice].map(([k, seconds]) => {
      const [guildId, day, channelId, userId] = split(k);
      return { guildId, day, channelId, userId, seconds };
    }),
    hours: [...buffer.hours].map(([k, count]) => {
      const [guildId, day, hour] = split(k);
      return { guildId, day, hour: Number(hour), count };
    }),
    flows: [...buffer.flows].map(([k, v]) => {
      const [guildId, day] = split(k);
      return { guildId, day, joins: v.joins, leaves: v.leaves };
    }),
  };
}

/**
 * Statistiques du serveur : compte les messages (par jour, heure, salon et membre), le
 * temps passé en vocal et les arrivées/départs. Jamais de contenu : uniquement des
 * compteurs, gardés en mémoire puis écrits par lots (toutes les 30 s et à l'arrêt).
 * Bots, webhooks, messages système et salons ignorés des logs ne comptent pas.
 */
class ActivityService {
  /**
   * @param {{ client?: object, activity: import('../database/repositories/ActivityRepository').ActivityRepository,
   *   config: import('./ConfigService').ConfigService, flushIntervalMs?: number, clock?: () => number }} deps
   */
  constructor({ client, activity, config, flushIntervalMs = FLUSH_INTERVAL_MS, clock = () => Date.now() }) {
    this.client = client;
    this.repo = activity;
    this.config = config;
    this.flushIntervalMs = flushIntervalMs;
    this.clock = clock;
    this.buffer = newBuffer();
    /** Sessions vocales en cours : `${guildId}:${userId}` → { guildId, userId, channelId, since } */
    this.sessions = new Map();
    /** Serveurs dont le début de collecte est déjà enregistré (évite une écriture par message). */
    this.ensured = new Set();
    /** Serveurs ayant une action groupée de /activite en cours. */
    this.running = new Set();
    this.timer = null;
    this.stopped = false;
    this.lastPurgeAt = 0;
    this.lastHeartbeatAt = 0;
    /**
     * Résultats des vues de /statistiques (requêtes lourdes sur un gros serveur), par
     * (serveur, vue, période, portée) : `${guildId}:…` → { at, value }.
     * @type {Map<string, { at: number, value: unknown }>}
     */
    this.viewCache = new Map();
    /** Fin du délai entre deux clics de /statistiques : `${guildId}:${userId}` → ms. */
    this.viewCooldowns = new Map();
  }

  /**
   * Résultat mis en cache 60 s (`refresh` : recalculé). Le calcul ne se fait qu'en cas d'absence.
   * @template T
   * @param {string} key commence par l'identifiant du serveur
   * @param {() => T} compute
   * @returns {T}
   */
  cachedView(key, compute, { refresh = false } = {}) {
    const now = this.clock();
    const hit = this.viewCache.get(key);
    if (hit && !refresh && now - hit.at < VIEW_CACHE_TTL_MS) return hit.value;
    const value = compute();
    if (this.viewCache.size >= VIEW_CACHE_MAX) {
      for (const [k, v] of this.viewCache) if (now - v.at >= VIEW_CACHE_TTL_MS) this.viewCache.delete(k);
      while (this.viewCache.size >= VIEW_CACHE_MAX) this.viewCache.delete(this.viewCache.keys().next().value);
    }
    this.viewCache.set(key, { at: now, value });
    return value;
  }

  /** Oublie les vues en cache d'un serveur (données effacées, collecte coupée ou réactivée). */
  forgetViews(guildId) {
    for (const key of this.viewCache.keys()) if (key.startsWith(`${guildId}:`)) this.viewCache.delete(key);
  }

  /**
   * Délai entre deux clics d'un membre sur /statistiques (navigation, actualisation).
   * @returns {number} millisecondes restantes (0 : autorisé, le délai repart)
   */
  takeViewCooldown(guildId, userId, ms = VIEW_COOLDOWN_MS) {
    const now = this.clock();
    const key = `${guildId}:${userId}`;
    const until = this.viewCooldowns.get(key) ?? 0;
    if (until > now) return until - now;
    if (this.viewCooldowns.size > 1_000) for (const [k, t] of this.viewCooldowns) if (t <= now) this.viewCooldowns.delete(k);
    this.viewCooldowns.set(key, now + ms);
    return 0;
  }

  settings(guildId) {
    return this.config.get(guildId).stats ?? {};
  }

  /** La collecte est-elle active sur ce serveur ? (activée par défaut) */
  collecting(guildId) {
    return this.settings(guildId).enabled !== false;
  }

  retention(guildId) {
    return retentionDays(this.settings(guildId));
  }

  /** Salon exclu : salons ignorés des logs (/logs), avec leurs fils et catégories. */
  ignored(guildId, channel) {
    return isIgnoredChannel(channel, this.config.get(guildId).logs?.ignoredChannels);
  }

  // ------------------------------------------------------------ cycle de vie

  /** Démarre le vidage périodique (minuteur non bloquant, arrêté par stop()). */
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Arrêt : minuteur annulé, sessions vocales créditées et tampon écrit (avant fermeture de la base). */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
    // Dernier battement : un arrêt prolongé sera reconnu comme un trou dès le redémarrage.
    this.#heartbeat({ force: true });
    this.sessions.clear();
  }

  /**
   * Connexion prête : début de collecte des serveurs présents et sessions vocales en cours
   * (les membres déjà connectés commencent à compter maintenant).
   */
  onReady() {
    for (const guild of this.client?.guilds?.cache?.values?.() ?? []) this.onGuildAvailable(guild);
  }

  onGuildAvailable(guild) {
    if (this.stopped || !guild?.id || !this.collecting(guild.id)) return;
    this.#ensure(guild.id);
    // Battement immédiat : un trou (bot hors ligne, serveur quitté puis rejoint) est enregistré
    // dès le retour, avant toute action groupée.
    this.#heartbeat({ force: true, guildIds: [guild.id] });
    const now = this.clock();
    for (const state of guild.voiceStates?.cache?.values?.() ?? []) {
      const key = `${guild.id}:${state.id}`;
      if (!state.channelId || state.member?.user?.bot || this.sessions.has(key)) continue;
      if (!state.member) continue;
      if (this.#voiceCounts(guild, state.channel, state.channelId)) this.sessions.set(key, { guildId: guild.id, userId: state.id, channelId: state.channelId, since: now });
    }
  }

  /** Connexion à Discord établie (sinon les messages ne sont pas reçus : pas de battement). */
  #connected() {
    const shards = this.client?.ws?.shards;
    if (!shards?.size) return true;
    return shards.every((shard) => shard.status === 0); // Status.Ready
  }

  /**
   * Battement de la collecte (au plus toutes les 5 minutes, sauf `force`) pour les serveurs
   * présents, disponibles et collectés. Un écart de plus de 6 h est enregistré comme trou.
   * @param {{ force?: boolean, guildIds?: string[] }} [opts]
   */
  #heartbeat({ force = false, guildIds = null } = {}) {
    const now = this.clock();
    if (!force && now - this.lastHeartbeatAt < HEARTBEAT_MS) return;
    if (!this.#connected()) return;
    if (!guildIds) this.lastHeartbeatAt = now;
    const cache = this.client?.guilds?.cache;
    const ids = (guildIds ?? [...(cache?.keys?.() ?? [])]).filter((id) => {
      const guild = cache?.get?.(id);
      return guild && guild.available !== false && this.collecting(id);
    });
    try {
      this.repo.heartbeat?.(ids, now, GAP_MS);
    } catch (err) {
      logger.debug('Battement de la collecte non enregistré :', err?.message);
    }
  }

  #ensure(guildId) {
    if (this.ensured.has(guildId)) return;
    try {
      this.repo.ensureSince(guildId, this.clock());
      this.ensured.add(guildId);
    } catch (err) {
      logger.debug('Début de collecte non enregistré :', err?.message);
    }
  }

  // ------------------------------------------------------------ collecte

  /** Message reçu (messageCreate). @returns {boolean} compté */
  recordMessage(message) {
    if (this.stopped || !message?.guild || !message.author || message.author.bot || message.webhookId || message.system) return false;
    const guildId = message.guild.id;
    if (!this.collecting(guildId)) return false;
    const channel = message.channel;
    if (this.ignored(guildId, channel ?? { id: message.channelId })) return false;
    // Un fil (ou un post de forum) compte pour son salon.
    const channelId = channel?.isThread?.() ? channel.parentId ?? message.channelId : message.channelId;
    const at = message.createdTimestamp || this.clock();
    const day = dayKey(at);
    this.#ensure(guildId);
    inc(this.buffer.messages, `${guildId}|${day}|${channelId}|${message.author.id}`, 1);
    inc(this.buffer.hours, `${guildId}|${day}|${new Date(at).getUTCHours()}`, 1);
    if (bufferSize(this.buffer) > MAX_BUFFER_KEYS) this.flush();
    return true;
  }

  /** Arrivée ou départ d'un humain. @param {'join'|'leave'} kind */
  recordFlow(member, kind) {
    if (this.stopped || !member?.guild || member.user?.bot) return false;
    const guildId = member.guild.id;
    if (!this.collecting(guildId)) return false;
    this.#ensure(guildId);
    const key = `${guildId}|${dayKey(this.clock())}`;
    const entry = this.buffer.flows.get(key) ?? { joins: 0, leaves: 0 };
    if (kind === 'join') entry.joins += 1;
    else entry.leaves += 1;
    this.buffer.flows.set(key, entry);
    return true;
  }

  /** Le temps passé dans ce salon vocal compte-t-il ? (collecte active, hors AFK et salons ignorés) */
  #voiceCounts(guild, channel, channelId) {
    if (!channelId || !this.collecting(guild.id)) return false;
    if (guild.afkChannelId && channelId === guild.afkChannelId) return false;
    return !this.ignored(guild.id, channel ?? { id: channelId });
  }

  /**
   * Changement d'état vocal : la session en cours est créditée puis fermée à chaque
   * changement de salon (muet / sourd : même session). Le temps est réparti par jour UTC.
   */
  trackVoice(oldState, newState) {
    if (this.stopped) return;
    const member = newState?.member ?? oldState?.member;
    const guild = newState?.guild ?? oldState?.guild;
    if (!member || member.user?.bot || !guild?.id) return;
    const key = `${guild.id}:${member.id}`;
    const next = newState?.channelId ?? null;
    const current = this.sessions.get(key);
    if (current && current.channelId === next) return;
    const now = this.clock();
    if (current) {
      this.#credit(current, now);
      this.sessions.delete(key);
    }
    if (next && this.#voiceCounts(guild, newState.channel, next)) {
      this.#ensure(guild.id);
      this.sessions.set(key, { guildId: guild.id, userId: member.id, channelId: next, since: now });
    }
  }

  /** Crédite une session jusqu'à `until`, découpée par jour UTC (secondes entières, sans dérive). */
  #credit(session, until) {
    let from = session.since;
    if (!(until > from)) return;
    if (this.collecting(session.guildId)) {
      while (from < until) {
        const day = dayKey(from);
        const end = Math.min(until, dayStart(day) + DAY_MS);
        const seconds = Math.floor(end / 1000) - Math.floor(from / 1000);
        if (seconds > 0) inc(this.buffer.voice, `${session.guildId}|${day}|${session.channelId}|${session.userId}`, seconds);
        from = end;
      }
    }
    session.since = until;
  }

  /**
   * Écrit le tampon en base (une transaction). Les sessions vocales en cours sont
   * créditées jusqu'à maintenant ; une session dont le membre n'est plus dans le salon
   * (événement manqué pendant une coupure) est close.
   * @returns {number} lignes écrites
   */
  flush() {
    const now = this.clock();
    const ready = Boolean(this.client?.isReady?.());
    for (const [key, s] of this.sessions) {
      const guild = this.client?.guilds?.cache?.get?.(s.guildId);
      // Serveur quitté (client prêt, serveur absent du cache) : la session est close sans crédit
      // supplémentaire (sinon elle compterait du vocal indéfiniment).
      if (!guild && ready) {
        this.sessions.delete(key);
        continue;
      }
      this.#credit(s, now);
      const state = guild?.voiceStates?.cache?.get?.(s.userId);
      if (!this.collecting(s.guildId) || (guild && state?.channelId !== s.channelId)) this.sessions.delete(key);
    }
    if (!this.stopped) this.#heartbeat();
    if (!bufferSize(this.buffer)) return 0;
    const buffer = this.buffer;
    this.buffer = newBuffer();
    const batch = toBatch(buffer);
    try {
      this.repo.applyBatch(batch);
    } catch (err) {
      logger.warn('Écriture des statistiques impossible :', err?.message);
      return 0;
    }
    return batch.messages.length + batch.voice.length + batch.hours.length + batch.flows.length;
  }

  /**
   * Étape quotidienne du scheduler : supprime les statistiques plus anciennes que la
   * rétention de chaque serveur (et les traces de MP de plus de 30 jours).
   * @returns {number} lignes supprimées
   */
  async processDue({ isStopping = () => false, now = this.clock() } = {}) {
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return 0;
    this.lastPurgeAt = now;
    const today = dayKey(now);
    let removed = 0;
    for (const guildId of this.repo.guilds()) {
      if (isStopping()) return removed;
      // Rétention relue à chaque serveur : un réglage changé entre-temps s'applique.
      removed += this.repo.purgeBefore(guildId, addDays(today, -(this.retention(guildId) - 1)));
    }
    removed += this.repo.purgeDmsBefore(now - DM_KEEP_MS);
    if (removed) logger.info(`Statistiques : ${removed} ligne(s) expirée(s) supprimée(s).`);
    return removed;
  }

  // ------------------------------------------------------------ lecture

  /** Dépôt à jour (tampon vidé) pour une lecture. */
  read() {
    this.flush();
    return this.repo;
  }

  /** Début de la collecte (ms) ou null. */
  since(guildId) {
    return this.repo.getSince(guildId);
  }

  /** Jours complets de collecte (0 si elle n'a pas commencé). */
  collectedDays(guildId, now = this.clock()) {
    const since = this.since(guildId);
    return since ? Math.max(0, Math.floor((now - since) / DAY_MS)) : 0;
  }

  /**
   * Dernier trou de collecte (bot hors ligne plus de 6 h) se terminant dans les `days` derniers
   * jours, ou null : pendant ce trou, personne n'a été compté actif.
   * @returns {{ start: number, end: number } | null}
   */
  gapWithin(guildId, days, now = this.clock()) {
    const gap = this.repo.getGap?.(guildId) ?? null;
    return gap?.end && gap.end > now - days * DAY_MS ? gap : null;
  }

  /** Les actions groupées sur « inactifs depuis `days` jours » sont-elles fiables ? */
  canAct(guildId, days, now = this.clock()) {
    const since = this.since(guildId);
    return Boolean(since && this.collecting(guildId) && now - since >= days * DAY_MS && !this.gapWithin(guildId, days, now));
  }

  /** Serveur quitté (guildDelete) : sessions vocales closes (créditées jusqu'ici), plus de début de collecte en mémoire. */
  onGuildRemoved(guildId) {
    if (!guildId) return;
    const now = this.clock();
    for (const [key, s] of this.sessions) {
      if (s.guildId !== guildId) continue;
      this.#credit(s, now);
      this.sessions.delete(key);
    }
    this.ensured.delete(guildId);
  }

  /** Active ou coupe la collecte. La réactiver redémarre le décompte (trou dans les données). */
  setCollecting(guildId, enabled) {
    this.config.update(guildId, { stats: { enabled } });
    this.ensured.delete(guildId);
    this.forgetViews(guildId);
    if (enabled) {
      this.repo.setSince(guildId, this.clock());
      this.ensured.add(guildId);
    } else {
      this.flush();
      for (const key of this.sessions.keys()) if (key.startsWith(`${guildId}:`)) this.sessions.delete(key);
      this.repo.clearSince(guildId);
    }
  }

  /** Efface toutes les statistiques du serveur ; la collecte (si active) repart de zéro. */
  wipe(guildId) {
    this.flush();
    const n = this.repo.wipe(guildId);
    this.forgetViews(guildId);
    this.ensured.delete(guildId);
    for (const s of this.sessions.values()) if (s.guildId === guildId) s.since = this.clock();
    if (this.collecting(guildId)) this.#ensure(guildId);
    return n;
  }

  /**
   * Membres du serveur (cache s'il est complet, sinon récupération complète).
   * @returns {Promise<{ members: import('discord.js').Collection<string, import('discord.js').GuildMember>, partial: boolean }>}
   */
  async members(guild) {
    const cache = guild.members.cache;
    if (cache.size >= (guild.memberCount ?? 0)) return { members: cache, partial: false };
    try {
      const members = await guild.members.fetch({ time: 20_000 });
      return { members, partial: members.size < (guild.memberCount ?? 0) };
    } catch (err) {
      logger.debug('Liste des membres incomplète :', err?.message);
      return { members: cache, partial: true };
    }
  }

  /**
   * Membres inactifs : humains arrivés depuis plus de `days` jours, sans message ni vocal
   * depuis `days` jours, sans rôle exclu (staff). Triés : jamais actifs, puis les plus anciens.
   * @returns {Promise<{ list: Array<{ member: import('discord.js').GuildMember, lastDay: string|null }>, partial: boolean }>}
   */
  async inactiveMembers(guild, days, now = this.clock()) {
    const repo = this.read();
    const { members, partial } = await this.members(guild);
    const excluded = new Set(this.settings(guild.id).inactivity?.excludedRoles ?? []);
    const last = repo.lastActive(guild.id);
    const activeFrom = addDays(dayKey(now), -(days - 1));
    const joinedBefore = now - days * DAY_MS;
    const list = [];
    for (const member of members.values()) {
      if (member.user?.bot) continue;
      if (!member.joinedTimestamp || member.joinedTimestamp > joinedBefore) continue;
      if (excluded.size && member.roles?.cache?.some?.((r) => excluded.has(r.id))) continue;
      if (this.sessions.has(`${guild.id}:${member.id}`)) continue; // en vocal en ce moment
      const lastDay = last.get(member.id) ?? null;
      if (lastDay && lastDay >= activeFrom) continue;
      list.push({ member, lastDay });
    }
    list.sort((a, b) => (a.lastDay ?? '').localeCompare(b.lastDay ?? '') || a.member.joinedTimestamp - b.member.joinedTimestamp || a.member.id.localeCompare(b.member.id));
    return { list, partial };
  }

  /** Membres ayant reçu un MP « inactif » ces 7 derniers jours. */
  recentDms(guildId, now = this.clock()) {
    return this.repo.recentDms(guildId, now - DM_GAP_MS);
  }

  /** Réserve un MP « inactif » (au plus un par membre et par semaine). */
  claimDm(guildId, userId, now = this.clock()) {
    return this.repo.claimDm(guildId, userId, now, now - DM_GAP_MS);
  }
}

module.exports = { ActivityService, retentionDays, isIgnoredChannel, toBatch, RETENTION, DM_GAP_MS, FLUSH_INTERVAL_MS, GAP_MS, HEARTBEAT_MS, VIEW_CACHE_TTL_MS, VIEW_COOLDOWN_MS };
