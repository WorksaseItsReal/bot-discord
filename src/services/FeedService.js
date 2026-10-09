'use strict';

const { escapeMarkdown } = require('discord.js');
const { createLogger } = require('../core/logger');
const { UserError } = require('../core/errors');
const { card, fitEmbeds, linkButton, buttonRows, field, ICONS } = require('../utils/ui');
const { truncate } = require('../utils/embeds');
const { safeFetch } = require('../utils/safeFetch');
const { parseFeed, decodeBody, normalizeFeedUrl, matchesFilter, isYoutubeFeed, safeHttpUrl, FeedError } = require('../utils/feeds');
const { channelIssue } = require('./AnnouncementService');
const { logCard } = require('./LoggingService');

const logger = createLogger('feeds');

/** Intervalle entre deux lectures d'un même flux. */
const POLL_INTERVAL_MS = 10 * 60_000;
/** Flux suivis au plus par serveur. */
const MAX_FEEDS_PER_GUILD = 25;
/** Flux lus au plus par passage du scheduler : par serveur, puis au total. */
const MAX_PER_GUILD_TICK = 5;
const MAX_PER_TICK = 25;
/** Lectures simultanées. */
const CONCURRENCY = 4;
/** Au-delà, plus aucune lecture n'est lancée pendant ce passage (le scheduler n'est pas bloqué). */
const TICK_BUDGET_MS = 20_000;
/** Erreurs consécutives avant désactivation automatique. */
const MAX_ERRORS = 10;
/** Nouveautés publiées au plus par lecture (les autres sont marquées comme vues). */
const MAX_POSTS_PER_POLL = 5;
const BUTTON_URL_MAX = 512;
/** Contenu externe : TOUT le Markdown est neutralisé (liens masqués compris). */
const ESCAPE_ALL = Object.freeze({ maskedLink: true, heading: true, bulletedList: true, numberedList: true });
const USER_AGENT = `InspecteurGadget/${require('../../package.json').version} (bot Discord ; lecteur de flux RSS)`;
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

/**
 * Message publié pour un article : carte (titre, extrait ≤ 300, lien http(s), image), bouton
 * lien, mention du rôle avec allowedMentions explicite (jamais @everyone). Pur.
 */
function itemPayload(item, { feedTitle, youtube = false, roleId = null } = {}) {
  const link = safeHttpUrl(item.link);
  const embed = card({
    tone: 'info',
    section: { emoji: youtube ? '▶️' : '📰', label: truncate(feedTitle || 'Flux RSS', 200) },
    title: item.title ? escapeMarkdown(item.title, ESCAPE_ALL) : youtube ? 'Nouvelle vidéo' : 'Nouvel article',
    url: link ?? undefined,
    description: item.summary ? escapeMarkdown(item.summary, ESCAPE_ALL) : undefined,
    image: safeHttpUrl(item.image),
    footer: youtube ? 'Nouvelle vidéo YouTube' : 'Nouvel article',
    timestamp: Number.isFinite(item.date) ? item.date : true,
  });
  return {
    ...(roleId ? { content: `<@&${roleId}>` } : {}),
    embeds: fitEmbeds([embed]),
    components: link && link.length <= BUTTON_URL_MAX ? buttonRows(linkButton(youtube ? 'Regarder' : 'Lire', link, youtube ? '▶️' : ICONS.link)) : [],
    allowedMentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] },
  };
}

/** Phrase lisible d'une erreur de lecture ou d'envoi. */
function describeError(err) {
  if (err?.code === 50013) return 'permission manquante dans le salon';
  if (err?.code === 50001) return 'accès au salon refusé';
  if (err?.code === 10003) return 'salon supprimé';
  return truncate(String(err?.message ?? err ?? 'erreur inconnue'), 200);
}

/**
 * Flux RSS / Atom / YouTube : ajout (première lecture : les articles existants sont marqués
 * comme vus, rien n'est publié), lecture périodique (étape « feeds » du SchedulerService),
 * déduplication par guid, ETag / Last-Modified, désactivation après 10 erreurs consécutives.
 */
class FeedService {
  /**
   * @param {{
   *   client: import('discord.js').Client, feeds: import('../database/repositories/FeedRepository').FeedRepository,
   *   networkEnabled?: boolean, allowLoopback?: boolean, http?: typeof safeFetch, netOptions?: object,
   * }} deps `allowLoopback` / `netOptions` (lookup, fetchImpl) : tests uniquement
   */
  constructor({ client, feeds, networkEnabled = true, allowLoopback = false, http = safeFetch, netOptions = {} }) {
    this.client = client;
    this.repo = feeds;
    this.networkEnabled = networkEnabled;
    this.allowLoopback = allowLoopback;
    this.http = http;
    this.netOptions = netOptions;
    this.abort = new AbortController();
    this.stopped = false;
    /** @type {Promise<unknown> | null} passage en cours (attendu par stop()) */
    this.running = null;
    this.cursor = 0;
  }

  /**
   * Lit et analyse un flux. Lève une FeedError / FetchError (message affichable).
   * @returns {Promise<{ notModified: boolean, status: number, feed?: ReturnType<typeof parseFeed>, etag?: string|null, lastModified?: string|null }>}
   */
  async fetchFeed(url, { etag = null, lastModified = null, signal = null } = {}) {
    if (!this.networkEnabled) throw new FeedError('la lecture des flux est désactivée sur cette instance du bot (FEEDS_NETWORK=off)');
    if (this.stopped) throw new FeedError('le bot s\'arrête');
    const headers = { 'user-agent': USER_AGENT, accept: ACCEPT };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;
    const res = await this.http(url, {
      ...this.netOptions,
      headers,
      allowLoopback: this.allowLoopback,
      signal: signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal,
    });
    if (res.status === 304) return { notModified: true, status: 304 };
    if (!res.ok) throw new FeedError(res.status === 404 || res.status === 410 ? `le flux est introuvable (HTTP ${res.status})` : `le site a répondu HTTP ${res.status}`);
    const feed = parseFeed(decodeBody(res.body, res.headers.get('content-type')), { baseUrl: res.url });
    return {
      notModified: false,
      status: res.status,
      feed,
      etag: res.headers.get('etag')?.slice(0, 200) || null,
      lastModified: res.headers.get('last-modified')?.slice(0, 100) || null,
    };
  }

  /**
   * Suit un nouveau flux. Première lecture immédiate : adresse validée, articles existants
   * marqués comme vus (l'historique n'est jamais publié).
   * @returns {Promise<{ row: object, feed: object }>}
   */
  async add({ guild, channelId, input, roleId = null, filter = null, by = null, now = Date.now() }) {
    const { url } = normalizeFeedUrl(input);
    this.#assertRoom(guild.id, channelId, url);
    const result = await this.fetchFeed(url);
    // Relecture après la requête : un double clic ou un autre administrateur a pu ajouter entre-temps.
    this.#assertRoom(guild.id, channelId, url);
    let row;
    try {
      row = this.repo.create({
        guildId: guild.id,
        channelId,
        url,
        title: truncate(result.feed.title, 200),
        roleId,
        filter,
        etag: result.etag,
        lastModified: result.lastModified,
        synced: true,
        lastCheckedAt: now,
        createdBy: by,
        now,
      });
    } catch (err) {
      if (String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw new UserError('Ce flux est déjà publié dans ce salon.');
      throw err;
    }
    this.repo.markSeen(row.id, result.feed.items.map((i) => i.id), now);
    return { row, feed: result.feed };
  }

  #assertRoom(guildId, channelId, url) {
    if (this.repo.find(guildId, channelId, url)) throw new UserError('Ce flux est déjà publié dans ce salon.');
    if (this.repo.count(guildId) >= MAX_FEEDS_PER_GUILD) throw new UserError(`**${MAX_FEEDS_PER_GUILD}** flux au plus par serveur : retirez-en un d'abord (\`/flux retirer\`).`);
  }

  /** Aperçu d'un flux (rien n'est publié ni mémorisé). */
  async preview(input) {
    const { url } = normalizeFeedUrl(input);
    const result = await this.fetchFeed(url);
    return { url, feed: result.feed };
  }

  /**
   * Étape « feeds » du SchedulerService : flux non lus depuis 10 min, au plus 5 par serveur
   * et 25 au total par passage (rotation entre serveurs), 4 lectures simultanées.
   * @returns {Promise<number>} flux traités
   */
  async processDue({ isStopping = () => false, now = Date.now() } = {}) {
    if (!this.networkEnabled || this.stopped) return 0;
    const guilds = [...this.client.guilds.cache.values()].filter((g) => g.available);
    if (!guilds.length) return 0;
    const batch = [];
    const start = this.cursor % guilds.length;
    for (let k = 0; k < guilds.length && batch.length < MAX_PER_TICK; k += 1) {
      const guild = guilds[(start + k) % guilds.length];
      batch.push(...this.repo.due(guild.id, now - POLL_INTERVAL_MS, Math.min(MAX_PER_GUILD_TICK, MAX_PER_TICK - batch.length)));
    }
    this.cursor = start + 1;
    if (!batch.length) return 0;

    // Arrêt du scheduler : les lectures en cours sont interrompues sans attendre leur délai.
    const tick = new AbortController();
    const watch = setInterval(() => {
      if (isStopping()) tick.abort();
    }, 200);
    watch.unref?.();
    const started = Date.now();
    let index = 0;
    let done = 0;
    const worker = async () => {
      while (index < batch.length && !this.stopped && !isStopping() && Date.now() - started < TICK_BUDGET_MS) {
        const row = batch[index];
        index += 1;
        try {
          await this.poll(row, { signal: tick.signal });
        } catch (err) {
          logger.warn(`Flux #${row.id} (serveur ${row.guild_id}) : lecture en échec`, err?.message ?? err);
        }
        done += 1;
      }
    };
    const run = Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    this.running = run;
    try {
      await run;
    } finally {
      clearInterval(watch);
      if (this.running === run) this.running = null;
    }
    return done;
  }

  /**
   * Lit un flux et publie ses nouveautés.
   * @returns {Promise<'skipped'|'stopped'|'unchanged'|'synced'|'posted'|'error'|'disabled'>}
   */
  async poll(row, { signal = null, now = Date.now() } = {}) {
    const guild = this.client.guilds.cache.get(row.guild_id);
    if (!guild?.available) return 'skipped';
    // Relecture avant la requête : flux retiré ou mis en pause depuis la sélection.
    const current = this.repo.byId(row.id);
    if (!current?.enabled) return 'skipped';
    let result;
    try {
      result = await this.fetchFeed(current.url, current.synced ? { etag: current.etag, lastModified: current.last_modified, signal } : { signal });
    } catch (err) {
      if (this.stopped || signal?.aborted) return 'stopped';
      if (!this.repo.byId(row.id)?.enabled) return 'skipped';
      return this.#fail(guild, current, describeError(err), now);
    }
    // Relecture : flux retiré, mis en pause ou désactivé pendant la requête.
    const fresh = this.repo.byId(row.id);
    if (!fresh?.enabled || this.stopped) return 'skipped';
    if (result.notModified) {
      this.repo.recordSuccess(fresh.id, { now });
      return 'unchanged';
    }
    const meta = { etag: result.etag, lastModified: result.lastModified, title: truncate(result.feed.title, 200), now };
    const items = result.feed.items;
    if (!fresh.synced) {
      this.repo.markSeen(fresh.id, items.map((i) => i.id), now);
      this.repo.recordSuccess(fresh.id, { ...meta, synced: true });
      return 'synced';
    }
    const unseen = items.filter((i) => !this.repo.isSeen(fresh.id, i.id));
    const toPost = unseen.filter((i) => matchesFilter(i, fresh.filter)).slice(0, MAX_POSTS_PER_POLL).reverse();
    if (toPost.length) {
      const issue = channelIssue(guild, fresh.channel_id);
      if (issue) return this.#fail(guild, fresh, `salon inutilisable : ${issue.replace(/\*/g, '')}`, now);
    }
    // Articles filtrés, au-delà du plafond ou déjà vus : mémorisés sans être publiés.
    const pending = new Set(toPost.map((i) => i.id));
    this.repo.markSeen(fresh.id, items.filter((i) => !pending.has(i.id)).map((i) => i.id), now);
    let posted = 0;
    for (const item of toPost) {
      if (this.stopped) break;
      try {
        await this.publish(guild, fresh, item, result.feed);
      } catch (err) {
        // Les articles restants seront retentés à la prochaine lecture.
        return this.#fail(guild, fresh, `publication impossible : ${describeError(err)}`, now);
      }
      this.repo.markSeen(fresh.id, [item.id], now);
      this.repo.recordPosted(fresh.id);
      posted += 1;
    }
    this.repo.recordSuccess(fresh.id, meta);
    return posted ? 'posted' : 'unchanged';
  }

  /** Publie un article dans le salon du flux. */
  async publish(guild, row, item, feed) {
    const channel = guild.channels.cache.get(row.channel_id);
    // Jamais @everyone : un rôle disparu ou égal au serveur n'est pas mentionné.
    const roleId = row.role_id && row.role_id !== guild.id && guild.roles.cache.has(row.role_id) ? row.role_id : null;
    await channel.send(itemPayload(item, { feedTitle: row.title || feed?.title, youtube: isYoutubeFeed(row.url), roleId }));
  }

  /** Erreur de lecture : compteur incrémenté, désactivation (et log) à la 10e consécutive. */
  async #fail(guild, row, message, now) {
    const errors = this.repo.recordError(row.id, message, now);
    if (errors < MAX_ERRORS) {
      logger.debug(`Flux #${row.id} (serveur ${row.guild_id}) : erreur ${errors}/${MAX_ERRORS} — ${message}`);
      return 'error';
    }
    this.repo.disable(row.id, message);
    logger.warn(`Flux #${row.id} (serveur ${row.guild_id}) désactivé après ${errors} erreurs consécutives : ${message}`);
    const embed = logCard({
      category: 'server',
      tone: 'warning',
      icon: ICONS.warning,
      title: 'Flux RSS désactivé',
      description: `Le flux **${escapeMarkdown(truncate(row.title || row.url, 200))}** a échoué **${errors}** fois de suite : il a été désactivé. Corrigez le problème puis réactivez-le avec \`/flux liste\`.`,
      fields: [field(ICONS.channel, 'Salon', `<#${row.channel_id}>`), field(ICONS.id, 'Flux', `#${row.id}`), field(ICONS.link, 'Adresse', truncate(row.url, 300), false), field(ICONS.reason, 'Dernière erreur', truncate(message, 500), false)],
    });
    await this.client.services?.logging?.send(guild.id, 'server', embed, undefined, { event: 'feeds' }).catch(() => {});
    return 'disabled';
  }

  /** Arrêt : lectures interrompues, passage en cours attendu. */
  async stop() {
    this.stopped = true;
    this.abort.abort();
    await this.running?.catch(() => {});
  }
}

module.exports = {
  FeedService,
  itemPayload,
  describeError,
  POLL_INTERVAL_MS,
  MAX_FEEDS_PER_GUILD,
  MAX_PER_GUILD_TICK,
  MAX_PER_TICK,
  MAX_ERRORS,
  MAX_POSTS_PER_POLL,
};
