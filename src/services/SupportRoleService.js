'use strict';

const { ActivityType, GatewayIntentBits } = require('discord.js');
const { createLogger } = require('../core/logger');
const { applyRoles } = require('../utils/memberRoles');
const { normalize } = require('../utils/community');
const { assignableRoleIssue, removableRoles } = require('./AutomationService');

const logger = createLogger('support');

/** Anti-rebond : au plus un changement de rôle par membre et par minute. */
const DEBOUNCE_MS = 60_000;
/** Décisions en attente au plus (au-delà : ignorées et comptées). */
const QUEUE_MAX = 200;
/** « Resynchroniser » (source tag) : 10 minutes entre deux passages. */
const RESYNC_COOLDOWN_MS = 10 * 60_000;
/** Liste des membres relue (resynchronisation, retrait) jusqu'à 10 000 membres. */
const MEMBER_FETCH_LIMIT = 10_000;
const MEMBER_FETCH_TIMEOUT_MS = 15_000;
const MIN_TEXT = 2;
const MAX_TEXT = 64;
const SOURCES = Object.freeze({ tag: 'Tag du serveur', statut: 'Statut personnalisé' });

/**
 * Le membre affiche-t-il le tag de CE serveur ? `user` : User de discord.js (primaryGuild) ou
 * objet brut de l'API (primary_guild). Pur.
 */
function wearsGuildTag(user, guildId) {
  if (!user || !guildId) return false;
  if (user.primaryGuild) return user.primaryGuild.identityGuildId === guildId && user.primaryGuild.identityEnabled === true;
  const raw = user.primary_guild;
  return Boolean(raw && raw.identity_guild_id === guildId && raw.identity_enabled === true);
}

/** Texte du statut saisi : 2 à 64 caractères, sans caractère de contrôle. Texte nettoyé, ou null. Pur. */
function parseStatusText(raw) {
  // eslint-disable-next-line no-control-regex
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length < MIN_TEXT || [...text].length > MAX_TEXT || !normalize(text)) return null;
  return text;
}

/**
 * Décision « par statut personnalisé » : true (donner le rôle), false (le retirer), null (rien).
 *  - en ligne, inactif ou ne pas déranger, statut personnalisé contenant le texte → true ;
 *  - EN LIGNE sans le texte → false ;
 *  - hors ligne ou invisible (et inactif / ne pas déranger sans le texte) → null.
 * Seul le statut personnalisé compte (pas « Joue à… », « Écoute… »). Majuscules et accents ignorés. Pur.
 */
function statusDecision(presence, text) {
  const status = presence?.status;
  if (!status || status === 'offline' || status === 'invisible') return null;
  const needle = normalize(text);
  if (!needle) return null;
  const custom = (presence.activities ?? []).find((a) => a?.type === ActivityType.Custom);
  const state = normalize(custom?.state ?? '');
  if (state && state.includes(needle)) return true;
  return status === 'online' ? false : null;
}

/** Autre attribution automatique qui utilise déjà ce rôle (libellé), ou null. Pur. */
function otherAutoRoleUse(cfg, roleId) {
  if (!roleId || !cfg) return null;
  const w = cfg.welcome ?? {};
  if ((w.autoRoles?.humans ?? []).includes(roleId) || (w.autoRoles?.bots ?? []).includes(roleId)) return 'un rôle automatique d\'arrivée (/bienvenue)';
  if (w.verification?.roleId === roleId) return 'le rôle de vérification (/bienvenue)';
  const a = cfg.automations ?? {};
  if (a.voiceRole?.roleId === roleId || (a.voiceRole?.channels ?? []).some((l) => l?.roleId === roleId)) return 'un rôle vocal (/automatisations)';
  if (a.boost?.roleId === roleId) return 'le rôle des boosters (/automatisations)';
  if ((cfg.levels?.rewards ?? []).some((r) => r?.roleId === roleId)) return 'une récompense de niveau (/niveaux)';
  if (cfg.birthdays?.roleId === roleId) return 'le rôle anniversaire (/anniversaire)';
  if (cfg.moderation?.mutedRoleId === roleId) return 'le rôle de mute';
  if (cfg.stats?.inactivity?.roleId === roleId) return 'le rôle « inactif » (/activite)';
  return null;
}

/**
 * Rôle soutien (/automatisations › Rôle soutien) : rôle DÉDIÉ, donné et retiré par le bot.
 *
 *  - Source « tag » (par défaut, sans intent privilégié) : le membre affiche le tag de CE serveur
 *    (primary guild). discord.js n'émet pas guildMemberUpdate quand seul l'utilisateur change
 *    (et userUpdate une seule fois, tous serveurs confondus) : le paquet brut GUILD_MEMBER_UPDATE
 *    est donc lu directement (src/events/supportRole.js). Bouton « Resynchroniser » en secours.
 *  - Source « statut » : texte dans le statut personnalisé, lu sur presenceUpdate. Exige
 *    PRESENCE_INTENT=on ; sans l'intent, le service reste inerte.
 *  - Anti-rebond de 60 s par membre, file de 200 décisions au plus, bots exclus. Ajout et retrait
 *    par applyRoles (rôle par rôle). Rôle ni géré, ni sensible, sous le bot, non utilisé ailleurs.
 */
class SupportRoleService {
  /**
   * @param {{ client: import('discord.js').Client, config: import('./ConfigService').ConfigService, now?: () => number }} deps
   */
  constructor({ client, config, now = Date.now }) {
    this.client = client;
    this.config = config;
    this.now = now;
    this.debounceMs = DEBOUNCE_MS;
    /** @type {Map<string, { guildId: string, userId: string, desired: boolean, timer: NodeJS.Timeout|null }>} */
    this.pending = new Map();
    /** @type {string[]} décisions prêtes, traitées une par une */
    this.ready = [];
    this.working = false;
    /** @type {Map<string, number>} dernier changement de rôle, par serveur:membre */
    this.lastChange = new Map();
    /** @type {Map<string, number>} décisions ignorées (file pleine), par serveur */
    this.dropped = new Map();
    /** @type {Map<string, number>} dernière resynchronisation, par serveur */
    this.resyncAt = new Map();
    /** @type {Set<Promise<unknown>>} */
    this.background = new Set();
    this.stopped = false;
  }

  settings(guildId) {
    return this.config.get(guildId).support ?? {};
  }

  /** L'intent GuildPresences est-il actif sur ce client (PRESENCE_INTENT=on) ? */
  presenceIntent() {
    try {
      return Boolean(this.client?.options?.intents?.has?.(GatewayIntentBits.GuildPresences));
    } catch {
      return false;
    }
  }

  /** Source en service : 'tag', 'statut' (intent et texte présents), ou null (inerte). */
  activeSource(guildId) {
    const cfg = this.settings(guildId);
    if (!cfg.enabled || !cfg.roleId) return null;
    if (cfg.source === 'statut') return this.presenceIntent() && normalize(cfg.text) ? 'statut' : null;
    return 'tag';
  }

  /** Problème du rôle pour une attribution automatique (message), ou null. */
  roleIssue(guild, role, actor = null) {
    const issue = assignableRoleIssue(guild, role, actor);
    if (issue) return issue;
    const other = otherAutoRoleUse(this.config.get(guild.id), role.id);
    if (other) return `Le rôle ${role.name} est déjà ${other} : choisissez un rôle dédié.`;
    const muted = this.client?.services?.moderation?.mutedRole?.(guild);
    if (muted && muted.id === role.id) return `Le rôle ${role.name} est le rôle de mute.`;
    return null;
  }

  // ------------------------------------------------------------ événements

  /** Paquet brut GUILD_MEMBER_UPDATE (champ primary_guild de l'utilisateur). */
  handleRawMember(d) {
    if (this.stopped || !d?.guild_id || !d.user?.id || d.user.bot) return false;
    if (!('primary_guild' in d.user)) return false;
    if (this.activeSource(d.guild_id) !== 'tag') return false;
    return this.request(d.guild_id, d.user.id, wearsGuildTag(d.user, d.guild_id));
  }

  /** presenceUpdate (intent GuildPresences) : statut personnalisé. */
  handlePresence(presence) {
    const guildId = presence?.guild?.id;
    const userId = presence?.userId ?? presence?.user?.id;
    if (this.stopped || !guildId || !userId) return false;
    if (presence.user?.bot || presence.member?.user?.bot) return false;
    if (this.activeSource(guildId) !== 'statut') return false;
    const desired = statusDecision(presence, this.settings(guildId).text);
    if (desired === null) return false;
    return this.request(guildId, userId, desired);
  }

  /**
   * Décision pour un membre (la dernière l'emporte), appliquée au plus tôt 60 s après le
   * changement précédent du même membre. Rien n'est mis en file si le rôle est déjà à jour.
   * @returns {boolean} décision en attente
   */
  request(guildId, userId, desired) {
    if (this.stopped) return false;
    const key = `${guildId}:${userId}`;
    const entry = this.pending.get(key);
    if (entry) {
      entry.desired = desired;
      return true;
    }
    const member = this.client?.guilds?.cache?.get(guildId)?.members?.cache?.get(userId);
    if (member?.user?.bot) return false;
    const roleId = this.settings(guildId).roleId;
    if (member && Boolean(member.roles?.cache?.has(roleId)) === desired) return false;
    if (this.pending.size >= QUEUE_MAX) {
      this.dropped.set(guildId, (this.dropped.get(guildId) ?? 0) + 1);
      logger.debug(`Rôle soutien : file pleine, décision ignorée (${guildId}).`);
      return false;
    }
    const now = this.now();
    const wait = Math.max(0, (this.lastChange.get(key) ?? 0) + this.debounceMs - now);
    const next = { guildId, userId, desired, timer: null };
    this.pending.set(key, next);
    next.timer = setTimeout(() => {
      next.timer = null;
      this.ready.push(key);
      this.#track(this.#work());
    }, wait);
    next.timer.unref?.();
    return true;
  }

  /** Décisions en attente pour un serveur (tableau de bord). */
  stats(guildId) {
    let pending = 0;
    for (const e of this.pending.values()) if (e.guildId === guildId) pending += 1;
    return { pending, dropped: this.dropped.get(guildId) ?? 0, resyncAt: this.resyncAt.get(guildId) ?? 0 };
  }

  async #work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.ready.length && !this.stopped) {
        const key = this.ready.shift();
        const entry = this.pending.get(key);
        this.pending.delete(key);
        if (entry) await this.#apply(entry).catch((err) => logger.debug('Rôle soutien :', err?.message));
      }
    } finally {
      this.working = false;
    }
  }

  /** Applique une décision (tout est relu : réglage, membre, rôle). @returns {Promise<'added'|'removed'|null>} */
  async #apply({ guildId, userId, desired }) {
    const guild = this.client?.guilds?.cache?.get(guildId);
    if (!guild?.available || !this.activeSource(guildId)) return null;
    const role = guild.roles.cache.get(this.settings(guildId).roleId);
    if (!role) return null;
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (!member || member.user?.bot) return null;
    const has = member.roles.cache.has(role.id);
    const key = `${guildId}:${userId}`;
    const onError = (id, err) => logger.debug(`Rôle soutien ${id} (${guildId}) :`, err?.message);
    if (desired && !has) {
      // Revérifié à chaque ajout : un rôle devenu sensible ou utilisé ailleurs n'est plus donné.
      const issue = this.roleIssue(guild, role);
      if (issue) {
        logger.debug(`Rôle soutien non donné (${guildId}) : ${issue}`);
        return null;
      }
      const { added } = await applyRoles(member, { add: [role.id] }, 'Rôle soutien', onError);
      if (!added.length) return null;
      this.#changed(key);
      return 'added';
    }
    if (!desired && has && removableRoles(guild, [role.id]).length) {
      const { removed } = await applyRoles(member, { remove: [role.id] }, 'Rôle soutien : condition plus remplie', onError);
      if (!removed.length) return null;
      this.#changed(key);
      return 'removed';
    }
    return null;
  }

  #changed(key) {
    const now = this.now();
    this.lastChange.set(key, now);
    if (this.lastChange.size > 5_000) for (const [k, at] of this.lastChange) if (now - at >= this.debounceMs) this.lastChange.delete(k);
  }

  #track(promise) {
    const p = Promise.resolve(promise).catch((err) => logger.warn('Rôle soutien en échec :', err?.message ?? err));
    this.background.add(p);
    p.finally(() => this.background.delete(p));
    return p;
  }

  /** Liste des membres relue si le cache est incomplet (jusqu'à 10 000 membres). */
  async #ensureMembers(guild) {
    if ((guild.members.cache.size ?? 0) < (guild.memberCount ?? 0) && guild.memberCount <= MEMBER_FETCH_LIMIT) {
      await guild.members.fetch({ time: MEMBER_FETCH_TIMEOUT_MS }).catch((err) => logger.debug(`Membres de ${guild.id} non récupérés :`, err?.message));
    }
  }

  // ------------------------------------------------------------ resynchronisation et retrait

  /**
   * « Resynchroniser » (source tag) : rôle donné à ceux qui affichent le tag, retiré aux autres.
   * Au plus une fois par 10 minutes et par serveur, en arrière-plan.
   * @returns {{ started: boolean, retryAt?: number, reason?: string }}
   */
  resync(guild, { force = false } = {}) {
    if (this.stopped) return { started: false, reason: 'stopped' };
    if (this.activeSource(guild.id) !== 'tag') return { started: false, reason: 'source' };
    const now = this.now();
    const last = this.resyncAt.get(guild.id) ?? 0;
    if (!force && last && now - last < RESYNC_COOLDOWN_MS) return { started: false, retryAt: last + RESYNC_COOLDOWN_MS, reason: 'cooldown' };
    this.resyncAt.set(guild.id, now);
    this.#track(this.reconcileTag(guild));
    return { started: true };
  }

  /** @returns {Promise<number>} rôles ajoutés ou retirés */
  async reconcileTag(guild) {
    if (this.activeSource(guild.id) !== 'tag') return 0;
    const role = guild.roles.cache.get(this.settings(guild.id).roleId);
    if (!role || this.roleIssue(guild, role)) return 0;
    await this.#ensureMembers(guild);
    let changed = 0;
    for (const member of [...guild.members.cache.values()]) {
      if (this.stopped || this.activeSource(guild.id) !== 'tag' || this.settings(guild.id).roleId !== role.id) break;
      if (member.user?.bot) continue;
      const wants = wearsGuildTag(member.user, guild.id);
      if (wants === member.roles.cache.has(role.id)) continue;
      const out = await applyRoles(member, wants ? { add: [role.id] } : { remove: [role.id] }, 'Rôle soutien (resynchronisation)', (id, err) => logger.debug(`Rôle soutien ${id} :`, err?.message));
      changed += out.added.length + out.removed.length;
    }
    return changed;
  }

  /**
   * Retire le rôle à tous ses porteurs (désactivation, changement de rôle ou de source), en
   * arrière-plan ; les décisions en attente du serveur sont abandonnées.
   */
  release(guild, roleId) {
    for (const [key, entry] of this.pending) {
      if (entry.guildId !== guild.id) continue;
      clearTimeout(entry.timer);
      this.pending.delete(key);
    }
    return this.#track(this.#release(guild, roleId));
  }

  async #release(guild, roleId) {
    if (!roleId || !removableRoles(guild, [roleId]).length) return 0;
    // Réglage modifié de nouveau pendant le retrait (réactivé, autre rôle…) : on s'arrête là.
    const snapshot = JSON.stringify(this.settings(guild.id));
    await this.#ensureMembers(guild);
    let removed = 0;
    for (const member of [...(guild.roles.cache.get(roleId)?.members?.values() ?? [])]) {
      if (this.stopped || JSON.stringify(this.settings(guild.id)) !== snapshot) break;
      if (member.user?.bot) continue;
      const out = await applyRoles(member, { remove: [roleId] }, 'Rôle soutien retiré (réglage modifié)', (id, err) => logger.debug(`Retrait du rôle soutien ${id} :`, err?.message));
      removed += out.removed.length;
    }
    return removed;
  }

  /** Lance une tâche de fond suivie (attendue à l'arrêt). */
  runInBackground(promise) {
    return this.#track(promise);
  }

  async stop() {
    this.stopped = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.ready.length = 0;
    await Promise.allSettled([...this.background]);
  }
}

module.exports = {
  SupportRoleService,
  wearsGuildTag,
  statusDecision,
  parseStatusText,
  otherAutoRoleUse,
  SOURCES,
  DEBOUNCE_MS,
  QUEUE_MAX,
  RESYNC_COOLDOWN_MS,
  MIN_TEXT,
  MAX_TEXT,
};
